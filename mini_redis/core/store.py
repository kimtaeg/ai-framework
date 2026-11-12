"""MiniRedis 저장소 본체.

웹(FastAPI)을 전혀 모르는 순수 Python 코드다. 서버는 이 클래스를 감싸기만 한다.
데이터는 1단계에서 만든 HashTable 두 개에 나눠 담는다.
  - data    : 키 → 값
  - expires : 키 → 만료 시각 (절대 시각, Unix 초). 만료가 없는 키는 여기에 없다.
"""

import fnmatch    # *, ? 패턴 매칭 (keys / delete_pattern 용)
import math       # ttl() 에서 남은 시간을 올림하기 위해
import threading  # 안전망용 Lock
import time       # 기본 시계 함수 time.time

from .hashtable import MISSING, HashTable


class MiniRedis:
    def __init__(self, clock=time.time, aof=None):
        # clock: 현재 시각(초)을 돌려주는 함수. 테스트에서는 가짜 시계를 넣어 시간을 직접 움직인다.
        #        Java로 치면 생성자에 Clock 인터페이스를 주입받는 것과 같다.
        self._clock = clock
        # aof: 쓰기 명령을 파일에 기록할 객체 (5단계에서 연결). None 이면 기록하지 않는다.
        self._aof = aof
        self._data = HashTable()     # 키 → 값
        self._expires = HashTable()  # 키 → 만료 절대 시각
        # threading.Lock: 한 번에 한 스레드만 들어오게 하는 자물쇠 (Java의 synchronized 블록과 비슷)
        # 서버는 싱글 스레드로 돌지만, 혹시 여러 스레드가 부르더라도 데이터가 깨지지 않게 하는 안전망이다.
        self._lock = threading.Lock()
        self._hits = 0      # get 으로 찾은 횟수
        self._misses = 0    # get 으로 못 찾은 횟수
        self._expired = 0   # 만료돼서 삭제된 키 수

    @property
    def aof(self):
        """연결된 AOF 객체 (없으면 None). 서버가 시작할 때 복구·주기적 flush 에 사용한다."""
        return self._aof

    # ==================================================================
    # 내부 도우미 (Lock 을 잡지 않는다. 반드시 Lock 을 잡은 공개 메서드 안에서만 부른다.)
    # threading.Lock 은 같은 스레드가 두 번 잡으면 멈춰버리므로(데드락),
    # 공개 메서드끼리 서로 부르지 않고 이 도우미들을 쓴다.
    # ==================================================================
    def _log(self, command: str, *args) -> None:
        """쓰기 명령 기록. *args 는 '가변 인자'(Java의 String... args)다."""
        if self._aof is None:
            return
        self._aof.append(command, *args)

    def _expire_if_needed(self, key: str) -> bool:
        """만료 시각이 지났으면 키를 지우고 True. (Lazy expiration: 누가 건드릴 때 비로소 검사)"""
        expire_at = self._expires.get(key, MISSING)
        if expire_at is MISSING:          # 만료가 설정되지 않은 키
            return False
        if self._clock() < expire_at:     # 아직 살아 있음
            return False
        # 만료 시각과 같거나 지났으면 삭제 (ttl=10 이면 정확히 10초 뒤부터 없음)
        self._data.remove(key)
        self._expires.remove(key)
        self._expired += 1
        # AOF 에는 남기지 않는다: 만료 시각을 절대 시각으로 기록해 두므로 복구 때 똑같이 만료된다.
        return True

    def _delete(self, key: str) -> bool:
        """값과 만료 정보를 함께 지운다."""
        self._expires.remove(key)
        return self._data.remove(key)

    @staticmethod
    def _check_ttl(ttl) -> None:
        # bool 은 Python에서 int 의 자식이라 True 가 1로 통과해버리므로 따로 막는다
        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
            raise TypeError("ttl은 숫자(초)여야 합니다")
        # inf(무한대)는 ttl() 의 올림 계산에서 OverflowError 를, nan(숫자 아님)은 비교가 항상 거짓이라
        # 키가 바로 지워지는 문제를 만든다 → 유한한 값만 받는다
        if not math.isfinite(ttl):
            raise ValueError("ttl은 유한한 숫자여야 합니다")

    # ==================================================================
    # 공개 메서드 (모두 with self._lock: 으로 감싼다)
    # `with` 는 블록에 들어갈 때 lock.acquire(), 나갈 때 (예외가 나도) lock.release() 를 자동으로 해준다.
    # Java의 try { lock.lock(); ... } finally { lock.unlock(); } 와 같다.
    # ==================================================================
    def set(self, key: str, value, ttl=None) -> None:
        """값 저장. 기존 TTL 은 지워지고, ttl 이 있으면 새로 설정한다 (Redis SET 과 같은 동작)."""
        if ttl is not None:
            self._check_ttl(ttl)
            if ttl <= 0:
                raise ValueError("ttl은 0보다 커야 합니다")  # Redis 도 SET EX 0 은 에러
        with self._lock:
            self._data.put(key, value)
            self._expires.remove(key)                 # 덮어쓰면 이전 TTL 제거
            if ttl is None:
                self._log("SET", key, value)
            else:
                expire_at = self._clock() + ttl       # 상대 시간(초) → 절대 시각으로 변환해 저장
                self._expires.put(key, expire_at)
                self._log("SET", key, value, expire_at)  # AOF 에도 절대 시각으로 기록

    def get(self, key: str, default=None):
        """값 조회. 없거나 만료됐으면 default (기본 None).

        저장된 값이 None 일 수도 있으므로, 서버처럼 "없음"과 구분해야 하는 쪽은
        get(key, MISSING) 으로 부르고 결과를 `is MISSING` 으로 검사한다.
        """
        with self._lock:
            self._expire_if_needed(key)
            value = self._data.get(key, MISSING)
            if value is MISSING:
                self._misses += 1
                return default
            self._hits += 1
            return value

    def delete(self, key: str) -> bool:
        with self._lock:
            if self._expire_if_needed(key):  # 이미 만료된 키는 "없는 키"를 지운 것과 같다
                return False
            removed = self._delete(key)
            if removed:
                self._log("DEL", key)
            return removed

    def exists(self, key: str) -> bool:
        """값이 None 이어도 키가 있으면 True (get 과 달리 hits/misses 는 세지 않는다)."""
        with self._lock:
            self._expire_if_needed(key)
            return self._data.contains(key)

    def expire(self, key: str, ttl) -> bool:
        """기존 키에 만료를 건다. 키가 없으면 False."""
        self._check_ttl(ttl)
        with self._lock:
            self._expire_if_needed(key)
            if not self._data.contains(key):
                return False
            if ttl <= 0:
                # Redis 처럼 0 이하 TTL 은 "지금 바로 만료" = 삭제
                self._delete(key)
                self._log("DEL", key)
                return True
            expire_at = self._clock() + ttl
            self._expires.put(key, expire_at)
            self._log("EXPIREAT", key, expire_at)  # 상대 ttl 이 아니라 절대 시각을 기록
            return True

    def ttl(self, key: str) -> int:
        """-2: 키 없음, -1: 만료 없음, 그 외: 남은 초 (올림).

        올림을 쓰는 이유: 0.3초 남은 키에 0을 돌려주면 "이미 끝난 키"처럼 보이기 때문이다.
        """
        with self._lock:
            self._expire_if_needed(key)
            if not self._data.contains(key):
                return -2
            expire_at = self._expires.get(key, MISSING)
            if expire_at is MISSING:
                return -1
            return math.ceil(expire_at - self._clock())

    def persist(self, key: str) -> bool:
        """만료를 없앤다. 만료가 걸려 있던 키에서만 True (Redis PERSIST 와 같음)."""
        with self._lock:
            self._expire_if_needed(key)
            if not self._data.contains(key):
                return False
            if not self._expires.remove(key):  # 원래 만료가 없었음
                return False
            self._log("PERSIST", key)
            return True

    def incr(self, key: str, amount: int = 1) -> int:
        """정수 값을 amount 만큼 증가. 없으면 0 에서 시작. 기존 TTL 은 유지."""
        if isinstance(amount, bool) or not isinstance(amount, int):
            raise TypeError("amount는 정수여야 합니다")
        with self._lock:
            self._expire_if_needed(key)              # 만료된 키는 지워져서 0 부터 다시 시작
            current = self._data.get(key, MISSING)
            if current is MISSING:
                current = 0
            elif isinstance(current, bool) or not isinstance(current, int):
                raise TypeError(f"키 '{key}'의 값이 정수가 아닙니다")
            new_value = current + amount
            self._data.put(key, new_value)           # expires 는 건드리지 않음 → TTL 유지
            # AOF 에는 "INCR" 대신 결과값을 SET 으로 기록한다.
            # 이유: 복구는 나중 시각에 하므로, INCR 을 다시 실행하면 그 사이 만료 여부에 따라 결과가 달라질 수 있다.
            #       결과값 + 절대 만료 시각을 남기면 언제 복구해도 같은 상태가 된다.
            expire_at = self._expires.get(key, MISSING)
            if expire_at is MISSING:
                self._log("SET", key, new_value)
            else:
                self._log("SET", key, new_value, expire_at)
            return new_value

    def keys(self, pattern: str = "*") -> list[str]:
        """패턴(*, ?)에 맞는 살아 있는 키 목록. 순서는 보장하지 않는다."""
        with self._lock:
            return self._matching_keys(pattern)

    def delete_pattern(self, pattern: str) -> int:
        """패턴에 맞는 키를 모두 지우고 지운 개수를 돌려준다 (캐시 무효화용)."""
        with self._lock:
            targets = self._matching_keys(pattern)
            for key in targets:
                self._delete(key)
                self._log("DEL", key)  # 패턴이 아니라 실제 지운 키를 기록 → 복구 결과가 명확함
            return len(targets)

    def _matching_keys(self, pattern: str) -> list[str]:
        result = []
        # list(...) 로 먼저 복사: 순회 중에 만료 키를 지우면 HashTable 구조가 바뀌기 때문
        for key in list(self._data.keys()):
            if self._expire_if_needed(key):
                continue  # 만료된 키는 결과에서 제외 (그리고 이 기회에 삭제됨)
            # fnmatchcase: 대소문자를 구분하는 버전 (Redis 도 구분함)
            if fnmatch.fnmatchcase(key, pattern):
                result.append(key)
        return result

    def sample_expire(self, sample_size: int) -> tuple[int, int]:
        """만료가 걸린 키 중 최대 sample_size 개를 무작위로 뽑아 만료된 것을 지운다 (Active expiration 한 묶음).

        반환: (뽑은 수, 그중 만료돼서 지운 수). 반복 여부 판단은 expiry.py 가 한다.
        같은 키가 두 번 뽑힐 수도 있다(복원 추출). Redis 도 정확한 표본보다 '빠르고 대충'을 택한다.
        """
        with self._lock:
            sampled = 0
            expired = 0
            for _ in range(sample_size):
                key = self._expires.random_key()  # 만료가 걸린 키만 들어 있는 테이블에서 뽑는다
                if key is None:                   # 만료 걸린 키가 하나도 없음
                    break
                sampled += 1
                if self._expire_if_needed(key):   # lazy 와 같은 삭제 로직 재사용 (expired 통계도 같이 증가)
                    expired += 1
            return sampled, expired

    # ==================================================================
    # AOF 전용 (5단계)
    # ==================================================================
    def apply_command(self, cmd: str, *args) -> None:
        """AOF 한 줄을 다시 실행한다 (복구 전용). _log 를 부르지 않으므로 AOF 에 다시 기록되지 않는다.

        만료 시각이 이미 지났어도 여기서는 지우지 않고 기록된 그대로 저장한다.
        이유: 뒤에 오는 줄이 그 키를 살릴 수 있다. 예) SET k v (10초 뒤 만료) → PERSIST k.
              SET 단계에서 지워버리면 PERSIST 가 살릴 키가 없어 영속화한 키가 사라진다.
        지난 키는 모든 줄을 다 실행한 뒤 purge_expired() 가 한 번에 버린다 (AOF.replay 가 호출).
        만료 시각은 절대 시각 그대로이므로 재시작해도 TTL 이 처음부터 다시 늘어나지 않는다.
        """
        with self._lock:
            if cmd == "SET":
                if len(args) not in (2, 3):
                    raise ValueError(f"SET 인자 개수가 잘못됨: {len(args)}")
                key, value = args[0], args[1]
                expire_at = args[2] if len(args) == 3 else None
                self._expires.remove(key)              # SET 은 이전 TTL 을 지운다 (set() 과 같은 규칙)
                self._data.put(key, value)
                if expire_at is not None:
                    self._check_expire_at(expire_at)
                    self._expires.put(key, expire_at)
            elif cmd == "EXPIREAT":
                key, expire_at = args
                self._check_expire_at(expire_at)
                if self._data.contains(key):           # 없는 키에 만료를 거는 줄은 무시 (라이브 expire 와 같음)
                    self._expires.put(key, expire_at)
            elif cmd == "PERSIST":
                (key,) = args                           # 인자가 정확히 1개인지 확인하면서 꺼내기
                self._expires.remove(key)
            elif cmd == "DEL":
                (key,) = args
                self._delete(key)
            elif cmd == "FLUSHALL":
                if args:
                    raise ValueError("FLUSHALL 은 인자가 없어야 합니다")
                self._data = HashTable()
                self._expires = HashTable()
            else:
                raise ValueError(f"알 수 없는 명령: {cmd}")

    @staticmethod
    def _check_expire_at(expire_at) -> None:
        """AOF 에서 읽은 만료 시각이 정상 숫자인지 (손상된 파일 방어)."""
        if isinstance(expire_at, bool) or not isinstance(expire_at, (int, float)) or not math.isfinite(expire_at):
            raise ValueError(f"만료 시각이 올바르지 않음: {expire_at!r}")

    def purge_expired(self) -> int:
        """만료 시각이 지난 키를 모두 지우고 개수를 돌려준다. AOF 복구가 끝난 직후 한 번 호출한다.

        복구 직후에 전부 훑는 이유: 서버가 꺼져 있던 동안 만료된 키가 메모리를 차지하지 않게 하려고.
        (평소에는 lazy/active 만료가 조금씩 지우므로 이렇게 전체를 훑지 않는다)
        """
        with self._lock:
            removed = 0
            for key in list(self._expires.keys()):   # 만료가 걸린 키만 검사하면 충분
                if self._expire_if_needed(key):
                    removed += 1
            return removed

    def snapshot(self, callback=None):
        """살아 있는 모든 키를 [(key, value, expire_at 또는 None), ...] 로 만든다.

        callback 을 주면 Lock 을 잡은 상태 그대로 callback(entries) 를 실행하고 그 결과를 돌려준다.
        AOF rewrite 가 "스냅샷 ~ 파일 교체" 사이에 다른 쓰기가 끼어들지 못하게 하려고 쓴다.
        """
        with self._lock:
            entries = []
            for key in list(self._data.keys()):
                if self._expire_if_needed(key):
                    continue                           # 만료된 키는 새 파일에 넣지 않음
                entries.append((key, self._data.get(key), self._expires.get(key, None)))
            return callback(entries) if callback is not None else entries

    def flush_all(self) -> None:
        """모든 키 삭제. 통계(hits/misses)는 Redis 처럼 유지한다."""
        with self._lock:
            self._data = HashTable()
            self._expires = HashTable()
            self._log("FLUSHALL")

    def stats(self) -> dict:
        """현재 상태 요약. (반환용 결과 묶음이라 dict 를 쓴다. 저장소 데이터는 여전히 HashTable 에만 있다.)"""
        with self._lock:
            return {
                "keys": len(self._data),
                "capacity": self._data.capacity,
                "load_factor": self._data.load_factor,
                "hits": self._hits,
                "misses": self._misses,
                "expired": self._expired,
            }
