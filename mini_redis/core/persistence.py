"""AOF (Append Only File) 영속화.

쓰기 명령을 한 줄씩 파일 끝에 덧붙여 두고, 서버가 다시 켜질 때 처음부터 다시 실행해서 상태를 복구한다.
파일 한 줄 = JSON 하나:  {"cmd": "SET", "args": ["user:1", {"name": "kim"}, 1731400000.5]}

fsync 정책 (Redis 와 같은 이름):
  - "always"  : 명령마다 디스크까지 강제로 기록. 가장 안전하지만 가장 느림
  - "everysec": 메모리 버퍼에 모았다가 1초마다 디스크에 기록 (기본값). 최악의 경우 1초치 유실
  - "no"      : 운영체제(OS)에 넘기기만 하고 디스크 기록 시점은 OS 가 결정. 가장 빠름
"""

import json
import logging
import os
import threading

logger = logging.getLogger("mini_redis.aof")

FSYNC_POLICIES = ("always", "everysec", "no")


class AOFCorruptError(Exception):
    """AOF 파일 중간이 깨져 있어서 안전하게 복구할 수 없음."""


class AOF:
    def __init__(self, path: str = "data/appendonly.aof", fsync: str = "everysec"):
        if fsync not in FSYNC_POLICIES:
            raise ValueError(f"fsync 는 {FSYNC_POLICIES} 중 하나여야 합니다")
        self.path = path
        self.fsync = fsync
        self._file = None                 # 파일은 처음 append 할 때 연다 (객체만 만들 때는 디스크를 건드리지 않음)
        # 파일 핸들을 여러 곳(append, 1초 flush, rewrite)에서 만지므로 보호용 Lock.
        # 잠그는 순서는 항상 "저장소 Lock → AOF Lock" 이라 서로 기다리다 멈추는(데드락) 일이 없다.
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # 기록
    # ------------------------------------------------------------------
    def _open(self) -> None:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)  # data/ 폴더가 없으면 만든다 (exist_ok: 이미 있어도 OK)
        # "a" = append 모드: 무조건 파일 끝에만 쓴다. 기존 내용은 절대 덮어쓰지 않음
        self._file = open(self.path, "a", encoding="utf-8")

    def append(self, cmd: str, *args) -> None:
        """명령 하나를 JSON 한 줄로 기록한다. MiniRedis._log 가 쓰기 성공 직후 호출한다."""
        # ensure_ascii=False: 한글을 \\uXXXX 로 바꾸지 않고 그대로 저장 / separators: 공백 없이 짧게
        line = json.dumps({"cmd": cmd, "args": list(args)}, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            if self._file is None:
                self._open()
            self._file.write(line + "\n")     # 아직은 Python 내부 버퍼(메모리)에 있을 수 있음
            if self.fsync == "always":
                self._sync()                  # 매번 디스크까지
            elif self.fsync == "no":
                self._file.flush()            # OS 에만 넘김 (프로세스가 죽어도 OS 가 살아 있으면 남는다)
            # everysec: 아무것도 안 함 → 1초마다 flush() 가 호출될 때 한꺼번에 기록

    def _sync(self) -> None:
        self._file.flush()                    # 1) Python 버퍼 → OS (write 시스템 콜)
        os.fsync(self._file.fileno())         # 2) OS 캐시 → 실제 디스크 (C 의 fsync(fd) 와 같음)

    def flush(self) -> None:
        """버퍼를 디스크에 기록. everysec 모드에서 app 의 백그라운드 태스크가 1초마다 부른다."""
        with self._lock:
            if self._file is None:
                return
            if self.fsync == "no":
                self._file.flush()
            else:
                self._sync()

    def close(self) -> None:
        """서버 종료 시: 남은 버퍼를 디스크에 쓰고 파일을 닫는다."""
        with self._lock:
            if self._file is not None:
                self._sync()
                self._file.close()
                self._file = None

    # ------------------------------------------------------------------
    # 복구
    # ------------------------------------------------------------------
    def replay(self, store) -> int:
        """파일의 명령을 처음부터 다시 실행해서 store 를 복구하고, 실행한 명령 수를 돌려준다.

        store.apply_command 는 AOF 에 기록하지 않는 전용 메서드라, 복구하면서 같은 줄이 또 쌓이지 않는다.
        """
        # 파일을 읽는 동안만 AOF Lock 을 잡는다. store.apply_command(저장소 Lock)는 Lock 밖에서 부른다.
        # 이유: 잠그는 순서를 항상 "저장소 → AOF" 로 지켜야 데드락이 없는데, 여기서 AOF Lock 을 쥔 채
        #       저장소 Lock 을 잡으면 순서가 거꾸로 된다.
        with self._lock:
            if self._file is not None:
                self._file.flush()            # 아직 버퍼에 있는 내용까지 읽히도록
            if not os.path.exists(self.path):
                return 0                      # 첫 실행: 복구할 것이 없음
            with open(self.path, "rb") as f:  # 바이트로 읽어야 잘린 위치(바이트 오프셋)를 정확히 계산할 수 있다
                raw_lines = f.readlines()     # 각 줄 끝의 b"\n" 이 그대로 남아 있음

        # 마지막 "내용 있는" 줄 번호 (끝에 빈 줄이 있어도 무시)
        last = max((i for i, line in enumerate(raw_lines) if line.strip()), default=-1)
        applied = 0
        good_bytes = 0                        # 여기까지는 정상인 바이트 수 → 잘린 꼬리를 잘라낼 위치
        for i, raw in enumerate(raw_lines):
            if not raw.strip():
                good_bytes += len(raw)
                continue
            try:
                entry = json.loads(raw.decode("utf-8"))
                cmd, args = entry["cmd"], entry["args"]
            except (ValueError, KeyError, TypeError) as e:  # JSON 문법 오류·UTF-8 깨짐·필드 누락
                if i == last:
                    # 마지막 줄만 깨짐 = 기록 도중 서버가 죽은 흔적. 그 줄만 버리고 계속 간다 (Redis 의 aof-load-truncated)
                    logger.warning("AOF 마지막 줄(%d번째)이 손상되어 건너뜁니다: %r", i + 1, raw[:80])
                    self._truncate(good_bytes)
                    break
                # 중간이 깨졌으면 그 뒤 명령들을 믿을 수 없다 → 멈추고 사람이 확인하게 한다
                raise AOFCorruptError(f"AOF {i + 1}번째 줄이 손상되었습니다: {e}") from e
            try:
                store.apply_command(cmd, *args)
            except (ValueError, TypeError) as e:      # 모르는 명령, 인자 개수 오류
                raise AOFCorruptError(f"AOF {i + 1}번째 줄을 실행할 수 없습니다: {e}") from e
            applied += 1
            good_bytes += len(raw)
        else:
            # for 문이 break 없이 끝났을 때만 실행 (Python 의 for-else 문법)
            if raw_lines and not raw_lines[-1].endswith(b"\n"):
                # 마지막 줄이 완전한 JSON 인데 줄바꿈만 빠진 경우 → 다음 기록이 같은 줄에 붙지 않도록 보충
                with self._lock, open(self.path, "ab") as f:
                    f.write(b"\n")
        return applied

    def _truncate(self, size: int) -> None:
        """손상된 꼬리를 잘라낸다. 그대로 두면 다음 append 가 깨진 줄 뒤에 붙어서 '중간이 깨진' 파일이 된다."""
        with self._lock:
            if self._file is not None:
                self._file.flush()
            os.truncate(self.path, size)

    # ------------------------------------------------------------------
    # 다시 쓰기 (파일 압축)
    # ------------------------------------------------------------------
    def rewrite(self, store) -> int:
        """살아 있는 키만 SET 명령으로 새 파일에 쓰고 기존 파일과 원자적으로 교체. 쓴 명령 수를 돌려준다.

        예) INCR 를 1000번 했다면 1000줄 → SET 1줄. 만료·삭제된 키는 아예 사라진다.
        store.snapshot(callback) 은 저장소 Lock 을 잡은 채로 callback 을 실행한다.
        → 스냅샷을 뜬 뒤 파일을 바꿔 끼우기 전까지 다른 쓰기가 끼어들어 옛 파일에 기록되고 유실되는 일이 없다.
        (주의) 파일 쓰기가 끝날 때까지 다른 요청이 기다린다. 진짜 Redis 는 fork 한 자식 프로세스가 대신 쓴다.
        """
        return store.snapshot(callback=self._write_rewrite)

    def _write_rewrite(self, entries) -> int:
        tmp_path = self.path + ".rewrite.tmp"
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        # 1) 임시 파일에 새 내용을 전부 쓰고 디스크까지 기록
        with open(tmp_path, "w", encoding="utf-8") as f:
            for key, value, expire_at in entries:
                args = [key, value] if expire_at is None else [key, value, expire_at]
                f.write(json.dumps({"cmd": "SET", "args": args}, ensure_ascii=False, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        with self._lock:
            # 2) 기존 파일 핸들을 닫고
            if self._file is not None:
                self._file.close()
                self._file = None             # 다음 append 때 새 파일을 연다
            # 3) os.replace: 이름 바꾸기 한 번으로 교체. 운영체제가 원자적으로 처리하므로
            #    "옛 파일" 아니면 "새 파일" 둘 중 하나만 존재한다 (반쯤 쓰인 파일이 보이는 순간이 없음)
            os.replace(tmp_path, self.path)
            self._fsync_dir(directory or ".")
        return len(entries)

    @staticmethod
    def _fsync_dir(directory: str) -> None:
        """이름 바꾸기 자체도 디스크에 확실히 남기려면 폴더도 fsync 해야 한다 (POSIX). 지원 안 하는 OS 는 무시."""
        try:
            fd = os.open(directory, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)
