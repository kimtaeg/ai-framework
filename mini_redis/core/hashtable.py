"""분리 체이닝(separate chaining) 방식의 해시 테이블.

Python 내장 dict / collections 를 쓰지 않고 직접 구현한다.
버킷 배열은 평범한 list(= C의 배열)이고, 각 버킷은 Node 로 이어진 단일 연결 리스트다.
"""

import random   # random_key() 에서 무작위 버킷을 고르기 위해 사용
import secrets  # 테이블마다 예측할 수 없는 해시 seed 를 만들기 위해 사용 (random 보다 안전한 난수)

# ---------------------------------------------------------------------------
# FNV-1a 64비트 해시 상수 (표준값)
# ---------------------------------------------------------------------------
FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325  # 해시 시작값
FNV_PRIME_64 = 0x100000001B3              # 매 바이트마다 곱하는 소수
MASK_64 = 0xFFFFFFFFFFFFFFFF              # Python int는 크기 제한이 없어서, 64비트로 잘라내는 마스크

INITIAL_CAPACITY = 16  # 초기 버킷 수 (2의 거듭제곱이어야 & 연산으로 인덱스를 구할 수 있음)
MAX_LOAD_FACTOR = 0.75  # 이 값을 "초과"하면 용량을 2배로 늘린다
MIN_LOAD_FACTOR = 0.1   # 이 값보다 작아지면 용량을 절반으로 줄인다 (Redis 도 10% 미만이면 축소)
RANDOM_PROBES = 32      # random_key() 가 무작위 버킷을 찔러보는 최대 횟수 (실패하면 순서대로 찾음)

# "키 없음"을 나타내는 센티넬 객체.
# 값으로 None 을 저장할 수 있으므로 None 만으로는 "없음"과 "값이 None"을 구분할 수 없다.
# object() 는 세상에 하나뿐인 객체라서 `is MISSING` 으로 비교하면 절대 헷갈리지 않는다.
MISSING = object()


def fnv1a_64(key: str, seed: int = 0) -> int:
    """문자열을 UTF-8 바이트로 바꾼 뒤 FNV-1a 64비트 해시를 계산한다.

    seed=0 이면 표준 FNV-1a 와 같은 값이다. seed 를 주면 시작값에 섞어서 테이블마다 다른 해시가 나온다.
    """
    h = FNV_OFFSET_BASIS_64 ^ seed    # 시작값에 비밀 seed 를 XOR → seed 를 모르면 결과를 미리 계산할 수 없음
    for byte in key.encode("utf-8"):  # 한글·이모지도 바이트 단위로 처리됨
        h ^= byte                     # 1) 먼저 XOR (FNV-1a 는 XOR → 곱셈 순서)
        h = (h * FNV_PRIME_64) & MASK_64  # 2) 소수를 곱하고 64비트로 자름 (C의 uint64 오버플로 흉내)
    return h


def mix64(h: int) -> int:
    """64비트 값의 모든 비트를 골고루 섞는다 (MurmurHash3 의 fmix64 finalizer).

    인덱스는 해시의 하위 비트만 쓰는데, FNV 의 하위 비트는 시작값의 하위 비트에만 영향을 받는다.
    이 함수로 상위 비트까지 섞어 두면, seed 전체를 모르는 한 어느 버킷에 들어갈지 예측할 수 없다.
    """
    h ^= h >> 33
    h = (h * 0xFF51AFD7ED558CCD) & MASK_64
    h ^= h >> 33
    h = (h * 0xC4CEB9FE1A85EC53) & MASK_64
    h ^= h >> 33
    return h


class Node:
    """연결 리스트의 한 칸. C의 struct node { key; value; next; } 와 같다."""

    __slots__ = ("key", "value", "next")  # 속성을 고정해 메모리를 아끼고 오타로 새 속성이 생기는 것을 막음

    def __init__(self, key, value, next=None):
        self.key = key
        self.value = value
        self.next = next  # 같은 버킷의 다음 노드 (없으면 None)


class HashTable:
    """문자열 키 → 임의의 값 을 저장하는 해시 테이블."""

    def __init__(self, capacity: int = INITIAL_CAPACITY, seed: int | None = None):
        # 용량은 반드시 2의 거듭제곱: n & (n - 1) == 0 이면 2의 거듭제곱
        if capacity < 1 or capacity & (capacity - 1) != 0:
            raise ValueError("capacity는 2의 거듭제곱이어야 합니다")
        self._buckets = [None] * capacity  # 각 칸은 연결 리스트의 head 노드 (비어 있으면 None)
        self._size = 0                     # 저장된 키 개수
        self._min_capacity = capacity      # 축소해도 이보다 작아지지 않음
        # 해시 seed: 테이블마다 무작위 64비트. 공격자가 "같은 버킷에 몰리는 키"를 미리 만들어
        # 체인을 길게 늘이는 해시 충돌 DoS 공격을 막는다. (Python dict 와 Redis 도 같은 이유로 seed 를 쓴다)
        # 테스트는 seed 를 고정해서 결과를 재현할 수 있다.
        self._seed = secrets.randbits(64) if seed is None else seed

    # ------------------------------------------------------------------
    # 내부 도우미
    # ------------------------------------------------------------------
    def _index(self, key: str, capacity: int | None = None) -> int:
        """키가 들어갈 버킷 번호. hash % capacity 와 같지만 & 가 더 빠르다(용량이 2의 거듭제곱일 때만 성립)."""
        if not isinstance(key, str):
            raise TypeError("키는 문자열(str)이어야 합니다")
        cap = len(self._buckets) if capacity is None else capacity
        # 같은 테이블은 put/get/remove/rehash 모두 같은 seed 를 쓰므로 항상 같은 버킷을 가리킨다
        return mix64(fnv1a_64(key, self._seed)) & (cap - 1)

    def _resize(self, new_capacity: int) -> None:
        """버킷 배열을 새로 만들고 모든 노드를 새 위치로 옮긴다(rehash)."""
        new_buckets = [None] * new_capacity
        for head in self._buckets:          # 옛 버킷을 하나씩 돌면서
            node = head
            while node is not None:
                nxt = node.next             # 노드를 옮기면 next 가 바뀌므로 미리 저장
                idx = self._index(node.key, new_capacity)  # 새 용량 기준으로 인덱스 재계산
                node.next = new_buckets[idx]  # 새 버킷의 맨 앞에 끼워 넣기 (노드 객체를 재사용 → 새로 할당 안 함)
                new_buckets[idx] = node
                node = nxt
        self._buckets = new_buckets

    # ------------------------------------------------------------------
    # 공개 메서드
    # ------------------------------------------------------------------
    def put(self, key: str, value) -> None:
        """키가 있으면 값을 덮어쓰고, 없으면 새 노드를 추가한다."""
        idx = self._index(key)
        node = self._buckets[idx]
        while node is not None:        # 1) 같은 키가 이미 있는지 체인을 따라가며 확인
            if node.key == key:
                node.value = value     #    있으면 값만 교체 → 개수는 그대로
                return
            node = node.next
        # 2) 없으면 체인 맨 앞에 새 노드 삽입 (O(1))
        self._buckets[idx] = Node(key, value, self._buckets[idx])
        self._size += 1
        # 3) 부하율이 0.75 를 넘으면 용량 2배 + 전체 rehash
        if self._size > len(self._buckets) * MAX_LOAD_FACTOR:
            self._resize(len(self._buckets) * 2)

    def get(self, key: str, default=None):
        """값을 돌려준다. 키가 없으면 default.

        값이 None 일 수도 있으니, 확실히 구분하려면 get(key, MISSING) 으로 부르고
        결과를 `is MISSING` 으로 검사한다.
        """
        node = self._buckets[self._index(key)]
        while node is not None:
            if node.key == key:
                return node.value
            node = node.next
        return default

    def remove(self, key: str) -> bool:
        """키를 지우고 True. 없으면 False."""
        idx = self._index(key)
        prev = None                     # 바로 앞 노드 (C에서 단일 연결 리스트 삭제할 때와 같은 방식)
        node = self._buckets[idx]
        while node is not None:
            if node.key == key:
                if prev is None:
                    self._buckets[idx] = node.next  # 맨 앞 노드 삭제: head 를 다음 노드로
                else:
                    prev.next = node.next           # 중간/끝 노드 삭제: 앞 노드가 나를 건너뛰게
                self._size -= 1
                # 많이 넣었다가 대부분 지우면 빈 버킷만 잔뜩 남는다 → 절반으로 축소
                # (빈 배열이 크면 random_key() 와 keys() 가 빈칸을 오래 훑게 된다)
                cap = len(self._buckets)
                if cap > self._min_capacity and self._size < cap * MIN_LOAD_FACTOR:
                    self._resize(cap // 2)
                return True
            prev = node
            node = node.next
        return False

    def contains(self, key: str) -> bool:
        """키 존재 여부. 값이 None 이어도 키가 있으면 True."""
        return self.get(key, MISSING) is not MISSING

    def __contains__(self, key) -> bool:
        """`key in table` 문법 지원 (Java의 containsKey 와 같은 역할)."""
        return self.contains(key)

    def keys(self):
        """모든 키를 하나씩 내보내는 제너레이터.

        yield 는 값을 하나 돌려주고 함수를 그 자리에서 '일시정지'한다(Java의 Iterator 와 비슷).
        순회 도중에 put/remove 를 하면 결과가 보장되지 않으니, 지우면서 돌 때는 list(t.keys()) 로 먼저 복사한다.
        """
        for head in self._buckets:
            node = head
            while node is not None:
                yield node.key
                node = node.next

    def __len__(self) -> int:
        """len(table) 로 키 개수를 얻는다."""
        return self._size

    @property
    def capacity(self) -> int:
        """현재 버킷 수. @property 덕분에 t.capacity 처럼 괄호 없이 읽는다."""
        return len(self._buckets)

    @property
    def load_factor(self) -> float:
        """부하율 = 키 개수 / 버킷 수."""
        return self._size / len(self._buckets)

    def random_key(self):
        """비어 있지 않은 버킷을 무작위로 골라 그 안의 키 하나를 반환. 비어 있으면 None.

        Redis 의 만료 샘플링처럼 '대충 무작위'면 충분한 용도라, 완벽히 균등하지는 않다
        (체인이 긴 버킷의 키는 조금 덜 뽑힌다).
        """
        if self._size == 0:
            return None
        cap = len(self._buckets)
        # 1) 무작위 버킷을 최대 RANDOM_PROBES 번 찔러본다. 축소 덕분에 부하율이 0.1 이상이라 거의 여기서 끝난다.
        for _ in range(RANDOM_PROBES):
            head = self._buckets[random.randrange(cap)]
            if head is not None:
                return self._random_in_chain(head)
        # 2) 운이 나빴으면 무작위 위치에서 시작해 다음 칸으로 (한 바퀴 안에 반드시 찾음)
        start = random.randrange(cap)
        for step in range(cap):
            head = self._buckets[(start + step) & (cap - 1)]  # & (cap-1) 은 끝에서 0으로 되돌아가는 % cap
            if head is not None:
                return self._random_in_chain(head)
        return None  # _size > 0 이면 여기 오지 않음 (안전장치)

    @staticmethod
    def _random_in_chain(head: Node) -> str:
        """체인 길이를 센 뒤 그중 하나를 무작위로 고른다."""
        length = 0
        node = head
        while node is not None:
            length += 1
            node = node.next
        node = head
        for _ in range(random.randrange(length)):
            node = node.next
        return node.key
