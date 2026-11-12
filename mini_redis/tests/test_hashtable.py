"""HashTable 단위 테스트. 실행: (ai-framework 폴더에서) python3 -m pytest mini_redis/tests/test_hashtable.py -v"""

import pytest

from mini_redis.core.hashtable import MISSING, HashTable, fnv1a_64


# ---------------------------------------------------------------------------
# 테스트 도우미
# ---------------------------------------------------------------------------
SEED = 12345  # 충돌 테스트용 고정 seed (seed 를 알아야 같은 버킷에 들어갈 키를 미리 찾을 수 있다)


def colliding_keys(table: HashTable, target_index: int, count: int) -> list[str]:
    """table 의 현재 용량에서 같은 버킷(target_index)에 들어가는 키를 count 개 찾는다."""
    found = []
    i = 0
    while len(found) < count:
        k = f"key{i}"
        if table._index(k) == target_index:  # 테이블이 실제로 쓰는 인덱스 공식 (seed 포함)
            found.append(k)
        i += 1
    return found


def chain_keys(table: HashTable, index: int) -> list[str]:
    """버킷 하나의 연결 리스트를 앞에서부터 따라가며 키 목록을 만든다 (내부 구조 확인용)."""
    result = []
    node = table._buckets[index]
    while node is not None:
        result.append(node.key)
        node = node.next
    return result


# ---------------------------------------------------------------------------
# 해시 함수
# ---------------------------------------------------------------------------
def test_fnv1a_known_values():
    # FNV-1a 64비트 공개 테스트 벡터와 일치해야 직접 구현이 맞는 것
    assert fnv1a_64("") == 0xCBF29CE484222325
    assert fnv1a_64("a") == 0xAF63DC4C8601EC8C
    assert fnv1a_64("foobar") == 0x85944171F73967E8


# ---------------------------------------------------------------------------
# 기본 동작
# ---------------------------------------------------------------------------
def test_put_get_remove_basic():
    t = HashTable()
    t.put("name", "redis")
    assert t.get("name") == "redis"
    assert t.contains("name") and "name" in t
    assert len(t) == 1

    assert t.remove("name") is True
    assert t.get("name") is None
    assert not t.contains("name")
    assert len(t) == 0
    assert t.remove("name") is False  # 없는 키 삭제는 False


def test_overwrite_keeps_size():
    t = HashTable()
    t.put("k", 1)
    t.put("k", 2)  # 같은 키 덮어쓰기
    assert t.get("k") == 2
    assert len(t) == 1


def test_none_value_vs_missing():
    t = HashTable()
    t.put("nothing", None)
    assert t.get("nothing", MISSING) is None        # 키는 있고 값이 None
    assert t.get("ghost", MISSING) is MISSING        # 키 자체가 없음
    assert t.contains("nothing") is True
    assert t.get("ghost", "기본값") == "기본값"


def test_non_string_key_rejected():
    t = HashTable()
    with pytest.raises(TypeError):
        t.put(123, "x")


def test_capacity_must_be_power_of_two():
    with pytest.raises(ValueError):
        HashTable(capacity=10)


# ---------------------------------------------------------------------------
# 충돌
# ---------------------------------------------------------------------------
def test_forced_collision_all_found_and_removed():
    t = HashTable(seed=SEED)
    keys = colliding_keys(t, target_index=3, count=5)  # 5개 → 부하율 5/16 이라 리사이징 없음
    for i, k in enumerate(keys):
        t.put(k, i)

    assert t.capacity == 16
    assert sorted(chain_keys(t, 3)) == sorted(keys)  # 전부 3번 버킷 한 체인에 있음
    for i, k in enumerate(keys):
        assert t.get(k) == i

    for k in keys:
        assert t.remove(k) is True
    assert len(t) == 0
    assert t._buckets[3] is None


@pytest.mark.parametrize("position", ["head", "middle", "tail"])
def test_remove_node_in_chain(position):
    t = HashTable(seed=SEED)
    for k in colliding_keys(t, target_index=7, count=3):
        t.put(k, k.upper())
    chain = chain_keys(t, 7)  # 실제 체인 순서 [head, middle, tail]
    victim = {"head": chain[0], "middle": chain[1], "tail": chain[2]}[position]

    assert t.remove(victim) is True
    expected = [k for k in chain if k != victim]
    assert chain_keys(t, 7) == expected  # 나머지 노드 순서·연결이 유지됨
    for k in expected:
        assert t.get(k) == k.upper()
    assert not t.contains(victim)
    assert len(t) == 2


# ---------------------------------------------------------------------------
# 리사이징
# ---------------------------------------------------------------------------
def test_resize_on_13th_insert():
    t = HashTable()
    for i in range(12):
        t.put(f"k{i}", i)
    assert t.capacity == 16          # 12/16 = 0.75 → "초과"가 아니므로 그대로
    assert t.load_factor == 0.75

    t.put("k12", 12)                 # 13/16 = 0.8125 > 0.75
    assert t.capacity == 32
    assert len(t) == 13
    for i in range(13):              # 리사이징 후에도 모든 키 조회
        assert t.get(f"k{i}") == i


def test_capacity_stays_power_of_two():
    t = HashTable()
    for i in range(1000):
        t.put(str(i), i)
        cap = t.capacity
        assert cap & (cap - 1) == 0
        assert t.load_factor <= 0.75


# ---------------------------------------------------------------------------
# 대량 데이터
# ---------------------------------------------------------------------------
def test_10000_items_then_remove_half():
    t = HashTable()
    n = 10_000
    for i in range(n):
        t.put(f"user:{i}", i)
    assert len(t) == n
    for i in range(n):
        assert t.get(f"user:{i}") == i

    for i in range(0, n, 2):  # 짝수 번호만 삭제
        assert t.remove(f"user:{i}") is True
    assert len(t) == n // 2
    for i in range(n):
        assert t.contains(f"user:{i}") == (i % 2 == 1)


# ---------------------------------------------------------------------------
# 해시 seed (충돌 DoS 방어)
# ---------------------------------------------------------------------------
def test_seed_changes_bucket_layout():
    keys = [f"k{i}" for i in range(64)]
    a, b = HashTable(seed=1), HashTable(seed=2)
    # seed 가 다르면 같은 키도 다른 버킷으로 간다 → 한 테이블용으로 만든 충돌 키가 다른 테이블에선 흩어진다
    assert [a._index(k) for k in keys] != [b._index(k) for k in keys]


def test_collision_keys_scatter_with_another_seed():
    victim = HashTable(seed=SEED)
    attack = colliding_keys(victim, target_index=0, count=12)  # seed 를 아는 공격자가 만든 키
    other = HashTable(seed=SEED + 1)                           # 실제 서버는 seed 를 모른다
    assert len({other._index(k) for k in attack}) > 1


def test_default_seed_is_random():
    assert HashTable()._seed != HashTable()._seed


def test_same_seed_is_deterministic():
    assert HashTable(seed=7)._index("abc") == HashTable(seed=7)._index("abc")


# ---------------------------------------------------------------------------
# 축소 (희소 테이블)
# ---------------------------------------------------------------------------
def test_shrink_after_mass_delete():
    t = HashTable()
    for i in range(1000):
        t.put(f"k{i}", i)
    assert t.capacity == 2048
    for i in range(995):
        t.remove(f"k{i}")
    assert t.capacity == 32                      # 5개 / 32칸 = 0.156 ≥ 0.1 → 여기서 멈춤 (16이면 0.31)
    assert t.load_factor >= 0.1
    for i in range(995, 1000):
        assert t.get(f"k{i}") == i               # 축소(rehash) 후에도 남은 키는 그대로
    assert t.random_key() in {f"k{i}" for i in range(995, 1000)}


def test_no_shrink_below_initial_capacity():
    t = HashTable(capacity=64)
    t.put("a", 1)
    t.remove("a")
    assert t.capacity == 64


def test_random_key_after_shrink_stays_cheap():
    t = HashTable()
    for i in range(100_000):
        t.put(f"k{i}", i)
    for i in range(99_990):
        t.remove(f"k{i}")
    # 축소 덕분에 버킷 배열이 키 수에 맞게 작아져서, 빈 버킷만 잔뜩 훑는 일이 없다
    assert t.capacity <= 128
    for _ in range(100):
        assert t.random_key() is not None


def test_keys_generator_returns_all():
    t = HashTable()
    expected = {f"k{i}" for i in range(50)}  # 테스트 쪽 비교용 set 은 저장소가 아니므로 사용 OK
    for k in expected:
        t.put(k, 0)
    gen = t.keys()
    assert iter(gen) is gen  # 리스트가 아니라 제너레이터
    assert set(gen) == expected


# ---------------------------------------------------------------------------
# 특수 키
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("key", ["안녕하세요", "레디스:세션", "🔥", "👨‍👩‍👧", ""])
def test_unicode_and_empty_keys(key):
    t = HashTable()
    t.put(key, "v")
    t.put("other", "o")
    assert t.get(key) == "v"
    assert t.contains(key)
    assert t.remove(key) is True
    assert not t.contains(key)
    assert t.get("other") == "o"


# ---------------------------------------------------------------------------
# random_key
# ---------------------------------------------------------------------------
def test_random_key_empty_returns_none():
    assert HashTable().random_key() is None


def test_random_key_returns_existing_key():
    t = HashTable()
    keys = [f"k{i}" for i in range(20)]
    for k in keys:
        t.put(k, 1)
    seen = set()
    for _ in range(500):
        k = t.random_key()
        assert t.contains(k)
        seen.add(k)
    assert len(seen) > 1  # 늘 같은 키만 나오지 않음


def test_random_key_single_item():
    t = HashTable()
    t.put("only", 1)
    assert t.random_key() == "only"
