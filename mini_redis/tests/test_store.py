"""MiniRedis 단위 테스트. 실행: (ai-framework 폴더에서) python3 -m pytest mini_redis/tests/test_store.py -v

time.sleep 대신 FakeClock 으로 시간을 직접 움직인다 → 테스트가 빠르고 결과가 항상 같다.
"""

import pytest

from mini_redis.core.hashtable import MISSING
from mini_redis.core.store import MAX_TTL_SECONDS, MiniRedis
from mini_redis.tests.fakes import FakeClock


class RecordingAOF:
    """_log 호출을 리스트에 모아두는 가짜 AOF (5단계 전이라 기록 형식만 확인)."""

    def __init__(self):
        self.entries = []

    def append(self, command, *args):
        self.entries.append((command, *args))


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def r(clock):
    # fixture: 테스트 함수 인자 이름으로 자동 주입되는 준비물 (JUnit 의 @BeforeEach 와 비슷)
    return MiniRedis(clock=clock)


# ---------------------------------------------------------------------------
# 기본 동작
# ---------------------------------------------------------------------------
def test_set_get_delete(r):
    r.set("a", "hello")
    assert r.get("a") == "hello"
    assert r.exists("a")
    assert r.delete("a") is True
    assert r.get("a") is None
    assert not r.exists("a")
    assert r.delete("a") is False


def test_store_none_value(r):
    r.set("n", None)
    assert r.exists("n") is True   # 값은 None 이지만 키는 있음
    assert r.get("n") is None
    assert r.ttl("n") == -1


def test_get_default_distinguishes_none_and_missing(r):
    r.set("n", None)
    assert r.get("n", MISSING) is None          # 값이 None
    assert r.get("ghost", MISSING) is MISSING   # 키 없음


# ---------------------------------------------------------------------------
# TTL / Lazy expiration
# ---------------------------------------------------------------------------
def test_ttl_expiration_boundary(r, clock):
    r.set("s", "v", ttl=10)
    clock.advance(9.9)
    assert r.get("s") == "v"       # 9.9초: 아직 살아 있음
    clock.advance(0.1)
    assert r.get("s") is None      # 정확히 10초: 만료
    # 조회하는 순간 내부 저장소에서도 지워져야 한다 (lazy expiration)
    assert not r._data.contains("s")
    assert not r._expires.contains("s")
    assert r.stats()["expired"] == 1


def test_expired_key_not_removed_until_touched(r, clock):
    r.set("s", "v", ttl=1)
    clock.advance(5)
    assert r._data.contains("s")   # 아무도 안 건드리면 아직 남아 있음 (lazy 의 특징)
    assert not r.exists("s")
    assert not r._data.contains("s")


def test_set_overwrite_clears_ttl(r, clock):
    r.set("k", 1, ttl=5)
    r.set("k", 2)                  # TTL 없이 덮어쓰기
    assert r.ttl("k") == -1
    clock.advance(100)
    assert r.get("k") == 2


def test_set_overwrite_with_new_ttl(r, clock):
    r.set("k", 1, ttl=5)
    r.set("k", 2, ttl=50)
    clock.advance(10)
    assert r.get("k") == 2


def test_persist(r, clock):
    r.set("k", "v", ttl=5)
    assert r.persist("k") is True
    assert r.ttl("k") == -1
    clock.advance(100)
    assert r.get("k") == "v"
    assert r.persist("k") is False        # 이미 만료 없음
    assert r.persist("missing") is False  # 없는 키


def test_expire(r, clock):
    assert r.expire("missing", 10) is False   # 없는 키
    r.set("k", "v")
    assert r.expire("k", 10) is True
    clock.advance(10)
    assert r.get("k") is None


def test_expire_on_expired_key_is_false(r, clock):
    r.set("k", "v", ttl=1)
    clock.advance(2)
    assert r.expire("k", 10) is False


def test_expire_non_positive_deletes(r):
    r.set("k", "v")
    assert r.expire("k", 0) is True
    assert not r.exists("k")


def test_invalid_ttl(r):
    with pytest.raises(ValueError):
        r.set("k", "v", ttl=0)
    with pytest.raises(TypeError):
        r.set("k", "v", ttl="10")


@pytest.mark.parametrize("ttl", [float("inf"), float("-inf"), float("nan")])
def test_non_finite_ttl_rejected(r, ttl):
    with pytest.raises(ValueError):
        r.set("k", "v", ttl=ttl)
    r.set("k", "v")
    with pytest.raises(ValueError):
        r.expire("k", ttl)
    assert r.ttl("k") == -1           # 거절된 TTL 은 적용되지 않음


def test_finite_float_ttl_still_works(r, clock):
    r.set("k", "v", ttl=1.5)
    assert r.ttl("k") == 2
    clock.advance(1.5)
    assert r.get("k") is None


def test_ttl_values(r, clock):
    assert r.ttl("missing") == -2
    r.set("forever", 1)
    assert r.ttl("forever") == -1
    r.set("temp", 1, ttl=10)
    assert r.ttl("temp") == 10
    clock.advance(3)
    assert r.ttl("temp") == 7
    clock.advance(6.5)
    assert r.ttl("temp") == 1      # 0.5초 남음 → 올림해서 1
    clock.advance(0.5)
    assert r.ttl("temp") == -2     # 만료됨


# ---------------------------------------------------------------------------
# incr
# ---------------------------------------------------------------------------
def test_incr_new_key_and_accumulate(r):
    assert r.incr("c") == 1
    assert r.incr("c") == 2
    assert r.incr("c", 10) == 12
    assert r.incr("c", -2) == 10
    assert r.get("c") == 10


def test_incr_non_integer_raises(r):
    r.set("s", "hello")
    with pytest.raises(TypeError):
        r.incr("s")
    r.set("num_str", "5")  # 문자열 "5" 도 정수 값이 아니다
    with pytest.raises(TypeError):
        r.incr("num_str")
    r.set("f", 1.5)
    with pytest.raises(TypeError):
        r.incr("f")
    assert r.get("s") == "hello"  # 에러가 나도 값은 그대로


def test_incr_keeps_ttl(r, clock):
    r.set("c", 5, ttl=10)
    clock.advance(4)
    assert r.incr("c") == 6
    assert r.ttl("c") == 6        # TTL 이 리셋되지 않고 이어짐
    clock.advance(6)
    assert r.get("c") is None


def test_incr_expired_key_starts_from_one(r, clock):
    r.set("c", 100, ttl=1)
    clock.advance(1)
    assert r.incr("c") == 1
    assert r.ttl("c") == -1       # 새로 생긴 키라 만료 없음


# ---------------------------------------------------------------------------
# keys / delete_pattern
# ---------------------------------------------------------------------------
def test_keys_pattern(r):
    for k in ["user:1", "user:2", "user:10", "post:1", "users"]:
        r.set(k, 1)
    assert sorted(r.keys()) == ["post:1", "user:1", "user:10", "user:2", "users"]
    assert sorted(r.keys("user:*")) == ["user:1", "user:10", "user:2"]
    assert sorted(r.keys("user:?")) == ["user:1", "user:2"]  # ? 는 정확히 한 글자
    assert r.keys("nothing*") == []
    assert r.keys("USER:*") == []                            # 대소문자 구분


def test_keys_excludes_expired(r, clock):
    r.set("a:1", 1, ttl=5)
    r.set("a:2", 2)
    clock.advance(5)
    assert r.keys("a:*") == ["a:2"]
    assert not r._data.contains("a:1")  # 조회 중에 만료 키가 정리됨


def test_delete_pattern(r, clock):
    for k in ["cache:a", "cache:b", "cache:c", "keep"]:
        r.set(k, 1)
    r.set("cache:old", 1, ttl=1)
    clock.advance(2)
    assert r.delete_pattern("cache:*") == 3   # 만료된 cache:old 는 개수에서 빠짐
    assert r.keys() == ["keep"]
    assert r.delete_pattern("cache:*") == 0


def test_flush_all(r):
    r.set("a", 1)
    r.set("b", 2, ttl=10)
    r.flush_all()
    assert r.keys() == []
    assert r.ttl("b") == -2
    assert r.stats()["keys"] == 0


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------
def test_hits_and_misses(r, clock):
    r.set("a", 1)
    r.get("a")         # hit
    r.get("a")         # hit
    r.get("nope")      # miss
    r.set("t", 1, ttl=1)
    clock.advance(1)
    r.get("t")         # 만료 → miss
    r.exists("a")      # exists 는 집계하지 않음
    s = r.stats()
    assert s["hits"] == 2
    assert s["misses"] == 2
    assert s["expired"] == 1
    assert s["keys"] == 1
    assert s["capacity"] == 16
    assert s["load_factor"] == 1 / 16


# ---------------------------------------------------------------------------
# AOF 기록 형식 (5단계 준비)
# ---------------------------------------------------------------------------
def test_write_commands_are_logged_with_absolute_time(clock):
    aof = RecordingAOF()
    r = MiniRedis(clock=clock, aof=aof)
    start = clock.now
    r.set("a", "v")
    r.set("b", 5, ttl=10)
    r.expire("a", 5)
    r.persist("a")
    r.incr("b")                # INCR 은 결과값 SET + 기존 절대 만료 시각으로 기록
    r.incr("new")              # 만료 없는 키는 만료 시각 없이 기록
    r.delete("a")
    r.get("b")                 # 읽기는 기록 안 함
    r.delete("missing")        # 실패한 쓰기도 기록 안 함
    r.persist("b")
    r.persist("b")             # 두 번째는 실패(False) → 기록 안 함
    r.delete_pattern("*")
    r.flush_all()
    assert aof.entries[:8] == [
        ("SET", "a", "v"),
        ("SET", "b", 5, start + 10),
        ("EXPIREAT", "a", start + 5),
        ("PERSIST", "a"),
        ("SET", "b", 6, start + 10),
        ("SET", "new", 1),
        ("DEL", "a"),
        ("PERSIST", "b"),
    ]
    # delete_pattern 의 DEL 순서는 해시 순서라 정해져 있지 않으므로 정렬해서 비교
    assert sorted(aof.entries[8:10]) == [("DEL", "b"), ("DEL", "new")]
    assert aof.entries[10:] == [("FLUSHALL",)]



# ---------------------------------------------------------------------------
# "기록 먼저, 메모리는 그다음" 규칙
# ---------------------------------------------------------------------------
class FailingAOF:
    """append 할 때마다 실패하는 가짜 AOF (디스크 오류 흉내)."""

    def append(self, command, *args):
        raise OSError("디스크 오류")


@pytest.mark.parametrize(
    "action",
    [
        lambda r: r.set("k", 999),
        lambda r: r.set("k", 999, ttl=5),
        lambda r: r.delete("k"),
        lambda r: r.expire("k", 5),
        lambda r: r.expire("k", 0),
        lambda r: r.persist("t"),
        lambda r: r.incr("n"),
        lambda r: r.delete_pattern("*"),
        lambda r: r.flush_all(),
    ],
)
def test_failed_log_leaves_memory_unchanged(clock, action):
    r = MiniRedis(clock=clock)
    r.set("k", "v")
    r.set("t", "v", ttl=100)
    r.set("n", 1)
    before = sorted((k, r.get(k), r.ttl(k)) for k in r.keys())
    r._aof = FailingAOF()
    with pytest.raises(OSError):
        action(r)
    r._aof = None
    assert sorted((k, r.get(k), r.ttl(k)) for k in r.keys()) == before   # 아무것도 바뀌지 않음


def test_incr_retry_after_log_failure_does_not_double_count(clock):
    r = MiniRedis(clock=clock)
    r.set("n", 1)
    r._aof = FailingAOF()
    with pytest.raises(OSError):
        r.incr("n")
    r._aof = None
    assert r.incr("n") == 2          # 실패한 증가는 반영되지 않았으므로 재시도는 1 → 2


def test_unserializable_value_is_not_stored(tmp_path, clock):
    from mini_redis.core.persistence import AOF

    r = MiniRedis(clock=clock, aof=AOF(str(tmp_path / "a.aof"), fsync="always"))
    with pytest.raises(TypeError):
        r.set("obj", object())       # JSON 으로 바꿀 수 없는 값 → 기록 실패
    assert not r.exists("obj")       # 메모리에도 없음 (재시작하면 사라질 값을 받아두지 않음)
    r.set("ok", 1)                   # 값 문제는 디스크 오류가 아니므로 이후 쓰기는 정상
    assert r.get("ok") == 1
    r.aof.close()



# ---------------------------------------------------------------------------
# 거대한 정수 TTL (float 변환 OverflowError 방지)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("ttl", [10**400, MAX_TTL_SECONDS + 1])
def test_oversized_int_ttl_rejected(r, ttl):
    with pytest.raises(ValueError):         # OverflowError 가 아니라 검증 에러
        r.set("k", "v", ttl=ttl)
    r.set("k", "v")
    with pytest.raises(ValueError):
        r.expire("k", ttl)
    assert r.ttl("k") == -1


def test_max_ttl_allowed(r):
    r.set("k", "v", ttl=MAX_TTL_SECONDS)    # 상한 자체는 허용
    assert r.ttl("k") == MAX_TTL_SECONDS
