"""AOF (Append Only File) 영속화.

쓰기 명령을 한 줄씩 파일 끝에 덧붙여 두고, 서버가 다시 켜질 때 처음부터 다시 실행해서 상태를 복구한다.
파일 한 줄 = JSON 하나:  {"cmd": "SET", "args": ["user:1", {"name": "kim"}, 1731400000.5]}

fsync 정책 (Redis 와 같은 이름):
  - "always"  : 명령마다 디스크까지 강제로 기록. 가장 안전하지만 가장 느림
  - "everysec": 메모리 버퍼에 모았다가 백그라운드 스레드가 1초마다 디스크에 기록 (기본값)
                목표는 "최대 1초치 유실"이지만, 디스크가 느려 fsync 가 오래 걸리면 간격이 더 길어질 수 있다
  - "no"      : 운영체제(OS)에 넘기기만 하고 디스크 기록 시점은 OS 가 결정. 가장 빠름
"""

import json
import logging
import os
import threading

logger = logging.getLogger("mini_redis.aof")

FSYNC_POLICIES = ("always", "everysec", "no")
FILE_MODE = 0o600  # 새 AOF 파일 권한: 소유자만 읽기/쓰기 (AOF 에는 저장된 값이 그대로 들어 있으므로)


class AOFCorruptError(Exception):
    """AOF 파일 중간이 깨져 있어서 안전하게 복구할 수 없음."""


def encode_line(cmd: str, args) -> str:
    # ensure_ascii=False: 한글을 \\uXXXX 로 바꾸지 않고 그대로 저장 / separators: 공백 없이 짧게
    return json.dumps({"cmd": cmd, "args": list(args)}, ensure_ascii=False, separators=(",", ":")) + "\n"


class AOF:
    def __init__(self, path: str = "data/appendonly.aof", fsync: str = "everysec", flush_interval: float = 1.0):
        if fsync not in FSYNC_POLICIES:
            raise ValueError(f"fsync 는 {FSYNC_POLICIES} 중 하나여야 합니다")
        self.path = path
        self.fsync = fsync
        self.flush_interval = flush_interval
        self._file = None                 # 파일은 처음 append 할 때 연다 (객체만 만들 때는 디스크를 건드리지 않음)
        # 파일 핸들을 여러 곳(append, 1초 flush 스레드, rewrite)에서 만지므로 보호용 Lock.
        # 잠그는 순서는 항상 "저장소 Lock → AOF Lock" 이라 서로 기다리다 멈추는(데드락) 일이 없다.
        self._lock = threading.Lock()
        self._stop = threading.Event()    # flush 스레드에 "이제 그만" 을 알리는 신호
        self._flusher = None              # everysec 용 백그라운드 스레드

    # ------------------------------------------------------------------
    # 파일 열기 (권한 제한)
    # ------------------------------------------------------------------
    def _ensure_dir(self) -> str:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)  # data/ 폴더가 없으면 만든다 (exist_ok: 이미 있어도 OK)
        return directory

    def _open(self) -> None:
        self._ensure_dir()
        # open(path, "a") 대신 os.open 으로 권한을 직접 지정해서 새 파일이 다른 사용자에게 보이지 않게 한다.
        # O_APPEND: 무조건 파일 끝에만 쓴다 / O_CREAT: 없으면 만든다 (이미 있는 파일의 권한은 바꾸지 않음)
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, FILE_MODE)
        self._file = os.fdopen(fd, "a", encoding="utf-8")   # 숫자 fd 를 Python 파일 객체로 감싼다
        if self.fsync == "everysec" and self._flusher is None:
            self._start_flusher()

    # ------------------------------------------------------------------
    # 기록
    # ------------------------------------------------------------------
    def append(self, cmd: str, *args) -> None:
        """명령 하나를 JSON 한 줄로 기록한다. MiniRedis._log 가 쓰기 성공 직후 호출한다."""
        line = encode_line(cmd, args)
        with self._lock:
            if self._file is None:
                self._open()
            self._file.write(line)            # 아직은 Python 내부 버퍼(메모리)에 있을 수 있음
            if self.fsync == "always":
                self._sync()                  # 매번 디스크까지
            elif self.fsync == "no":
                self._file.flush()            # OS 에만 넘김 (프로세스가 죽어도 OS 가 살아 있으면 남는다)
            # everysec: 아무것도 안 함 → flush 스레드가 1초마다 한꺼번에 기록

    def _sync(self) -> None:
        self._file.flush()                    # 1) Python 버퍼 → OS (write 시스템 콜)
        os.fsync(self._file.fileno())         # 2) OS 캐시 → 실제 디스크 (C 의 fsync(fd) 와 같음)

    def flush(self) -> None:
        """버퍼를 디스크에 기록. everysec 에서는 flush 스레드가 1초마다 부르고, 직접 불러도 된다."""
        with self._lock:
            if self._file is None:
                return
            if self.fsync == "no":
                self._file.flush()
            else:
                self._sync()

    def _start_flusher(self) -> None:
        """everysec 정책: AOF 가 스스로 1초마다 flush 하는 스레드를 띄운다.

        서버 앱 밖에서 MiniRedis(aof=AOF(...)) 로 직접 써도 1초 주기가 지켜진다.
        또 이벤트 루프와 다른 스레드라서, 요청 처리가 잠깐 막혀도 flush 는 계속 돈다.
        (진짜 Redis 도 fsync 를 별도 백그라운드 스레드에서 한다)
        저장소 데이터는 건드리지 않고 파일만 만지며, 파일은 AOF Lock 으로 보호된다.
        """
        self._stop.clear()

        def run():
            # wait(timeout): 신호가 오면 True(→ 종료), timeout 이 지나면 False(→ flush 하고 다시 대기)
            while not self._stop.wait(self.flush_interval):
                try:
                    self.flush()
                except Exception:                   # 디스크 오류가 나도 스레드가 죽지 않게
                    logger.exception("AOF flush 실패")

        # daemon=True: 프로그램이 끝날 때 이 스레드가 종료를 막지 않음 (정상 종료라면 close() 가 먼저 정리)
        self._flusher = threading.Thread(target=run, name="aof-flush", daemon=True)
        self._flusher.start()

    def close(self) -> None:
        """서버 종료 시: flush 스레드를 멈추고, 남은 버퍼를 디스크에 쓰고, 파일을 닫는다."""
        if self._flusher is not None:
            self._stop.set()
            self._flusher.join(timeout=5)
            self._flusher = None
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

        - 파일 전체를 메모리에 올리지 않고 한 줄씩 읽는다 (AOF 가 커도 메모리는 한 줄 크기만 사용)
        - store.apply_command 는 AOF 에 기록하지 않는 전용 메서드라, 복구하면서 같은 줄이 또 쌓이지 않는다
        - 다 읽은 뒤 store.purge_expired() 로 꺼져 있는 동안 만료된 키를 버린다
        """
        with self._lock:
            if self._file is not None:
                self._file.flush()            # 아직 버퍼에 있는 내용까지 읽히도록
        if not os.path.exists(self.path):
            return 0                          # 첫 실행: 복구할 것이 없음

        applied = 0
        good_bytes = 0                        # 여기까지는 정상인 바이트 수 → 잘린 꼬리를 잘라낼 위치
        truncate_at = None                    # 마지막 줄이 깨졌으면 잘라낼 위치
        missing_newline = False               # 마지막 줄이 완전한데 줄바꿈만 빠졌는지
        # 저장소 Lock 은 apply_command 안에서 잡는다. AOF Lock 은 잡지 않는다(잠금 순서 "저장소 → AOF" 유지).
        # 복구는 서버가 요청을 받기 전에 하므로 이 사이에 다른 쓰기는 없다.
        with open(self.path, "rb") as f:      # 바이트로 읽어야 잘린 위치(바이트 오프셋)를 정확히 계산할 수 있다
            line_no = 0
            for raw in f:                     # 한 줄씩 꺼냄 (b"\n" 포함). 파일 전체를 읽지 않는다
                line_no += 1
                if not raw.strip():
                    good_bytes += len(raw)
                    continue
                try:
                    entry = json.loads(raw.decode("utf-8"))
                    cmd, args = entry["cmd"], entry["args"]
                    if not isinstance(cmd, str) or not isinstance(args, list):
                        raise TypeError("cmd/args 형식이 아님")
                except (ValueError, KeyError, TypeError) as e:  # JSON 문법 오류·UTF-8 깨짐·필드 누락
                    # 뒤에 내용 있는 줄이 더 있는지 확인 (남은 부분도 한 줄씩만 읽음)
                    if any(rest.strip() for rest in f):
                        # 중간이 깨졌으면 그 뒤 명령들을 믿을 수 없다 → 멈추고 사람이 확인하게 한다
                        raise AOFCorruptError(f"AOF {line_no}번째 줄이 손상되었습니다: {e}") from e
                    # 마지막 줄만 깨짐 = 기록 도중 서버가 죽은 흔적. 그 줄만 버린다 (Redis 의 aof-load-truncated)
                    logger.warning("AOF 마지막 줄(%d번째)이 손상되어 건너뜁니다: %r", line_no, raw[:80])
                    truncate_at = good_bytes
                    break
                try:
                    store.apply_command(cmd, *args)
                except (ValueError, TypeError) as e:      # 모르는 명령, 인자 개수·형식 오류
                    raise AOFCorruptError(f"AOF {line_no}번째 줄을 실행할 수 없습니다: {e}") from e
                applied += 1
                good_bytes += len(raw)
                missing_newline = not raw.endswith(b"\n")  # 마지막으로 읽은 줄 기준으로 갱신됨

        if truncate_at is not None:
            self._truncate(truncate_at)
        elif missing_newline:
            # 마지막 줄이 완전한 JSON 인데 줄바꿈만 빠진 경우 → 다음 기록이 같은 줄에 붙지 않도록 보충
            with self._lock, open(self.path, "ab") as f:
                f.write(b"\n")
        store.purge_expired()                 # 모든 줄을 실행한 "뒤에" 만료된 키를 버린다
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
        directory = self._ensure_dir()
        # 새 파일 권한: 기존 AOF 가 있으면 그 권한을 그대로 물려받고, 없으면 소유자 전용
        # (os.replace 는 파일 자체를 바꿔 끼우므로, 권한을 맞춰 두지 않으면 기존 제한이 사라진다)
        try:
            mode = os.stat(self.path).st_mode & 0o777
        except FileNotFoundError:
            mode = FILE_MODE
        # 1) 임시 파일에 새 내용을 전부 쓰고 디스크까지 기록
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        if hasattr(os, "fchmod"):              # 이미 남아 있던 임시 파일이었다면 권한을 다시 맞춘다 (Windows 에는 없음)
            os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for key, value, expire_at in entries:
                args = [key, value] if expire_at is None else [key, value, expire_at]
                f.write(encode_line("SET", args))
            f.flush()
            os.fsync(f.fileno())
        with self._lock:
            # 2) 기존 파일 핸들을 닫고 (flush 스레드는 _file 이 None 이면 아무것도 안 함)
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
