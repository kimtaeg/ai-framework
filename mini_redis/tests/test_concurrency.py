"""Active expiration 과 동시성 테스트.

실행: (ai-framework 폴더에서) python -m pytest mini_redis/tests/test_concurrency.py -v
"""

import asyncio
import random
import threading
from urllib.parse import quote

import httpx
import pytest

from mini_redis.core.expiry import active_expire_cycle
from mini_redis.core.store import MiniRedis
from mini_redis.server.app import create_app
from mini_redis.server.thread_server import running_server
from mini_redis.tests.fakes import FakeClock


@pytest.fixture
def anyio_backend():
    return "asyncio"


def k(key: str) -> str:
    return "/keys/" + quote(key, safe="")


@pytest.fixture
def server_url():
    # 동시성 테스트는 ASGITransport 가 아니라 실제 uvicorn 서버(소켓)로 한다.
    # ASGITransport 는 요청 하나를 중간에 멈추지 않고 끝까지 실행해서, gather 로 보내도 사실상 한 줄로 처리되기 때문이다.
    with running_server(create_app(MiniRedis())) as url:
        yield url


CONNECTIONS = 10  # 동시에 열어 둘 연결 수. 2개 이상이면 요청이 서버에서 섞이기에 충분하다


def make_client(base_url: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, timeout=30, limits=httpx.Limits(max_connections=CONNECTIONS))


async def gather_bounded(coros, limit: int = CONNECTIONS):
    """asyncio.gather 로 전부 동시에 시작하되, 실제로 날아가는 요청은 limit 개로 제한한다.

    제한 없이 1000개를 한꺼번에 던지면 httpx 연결 풀의 대기열 관리 비용이 커져서 테스트가 수십 초 걸린다.
    Semaphore 는 "동시에 들어갈 수 있는 자리 수"가 정해진 출입문이다 (Java 의 Semaphore 와 같다).
    """
    sem = asyncio.Semaphore(limit)

    async def run(coro):
        async with sem:
            return await coro

    return await asyncio.gather(*(run(c) for c in coros))


# ===========================================================================
# Active expiration 단위 테스트
# ===========================================================================
class StepTimer:
    """부를 때마다 step 초씩 흐르는 가짜 타이머 (25ms 제한 검증용)."""

    def __init__(self, step: float):
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


def test_active_expire_removes_only_expired():
    random.seed(42)                      # random_key 결과를 고정 → 매번 같은 결과
    clock = FakeClock()
    store = MiniRedis(clock=clock)
    for i in range(100):
        store.set(f"dead:{i}", i, ttl=5)      # 5초 뒤 만료될 키
        store.set(f"alive:{i}", i, ttl=3600)  # 1시간 남은 키 (expires 에 있으니 표본에 같이 뽑힌다)
    clock.advance(10)

    # 아무도 조회하지 않았으니 lazy 만으로는 200개가 그대로 남아 있다
    assert len(store._data) == 200

    cycles = 0
    while len(store._data) > 100 and cycles < 1000:
        active_expire_cycle(store)
        cycles += 1

    assert len(store._data) == 100                 # 만료 키 100개만 사라짐
    for i in range(100):
        assert not store._data.contains(f"dead:{i}")
        assert store._data.contains(f"alive:{i}")  # 살아 있는 키는 하나도 안 지워짐
    assert store.stats()["expired"] == 100
    assert cycles < 1000


def test_active_expire_ignores_keys_without_ttl():
    store = MiniRedis(clock=FakeClock())
    for i in range(50):
        store.set(f"k{i}", i)            # 만료 없는 키는 expires 에 없으므로 표본 대상이 아님
    assert active_expire_cycle(store) == 0
    assert len(store._data) == 50


def test_active_expire_repeats_while_ratio_high():
    random.seed(0)
    clock = FakeClock()
    store = MiniRedis(clock=clock)
    for i in range(200):
        store.set(f"dead:{i}", i, ttl=1)
    clock.advance(2)
    # 전부 만료 → 비율 100% 라서 한 묶음(20개)에서 멈추지 않고 반복한다
    removed = active_expire_cycle(store, timer=StepTimer(0.0))  # 시간이 안 흐르는 타이머 → 시간 제한 없음
    assert removed == 200
    assert len(store._data) == 0


def test_active_expire_respects_time_limit():
    random.seed(0)
    clock = FakeClock()
    store = MiniRedis(clock=clock)
    for i in range(1000):
        store.set(f"dead:{i}", i, ttl=1)
    clock.advance(2)
    # 타이머를 부를 때마다 10ms 흐름: 시작(10) → 1묶음 후(20) → 2묶음 후(30) ≥ 25ms+시작 → 멈춤
    removed = active_expire_cycle(store, timer=StepTimer(0.010))
    assert 0 < removed <= 60             # 최대 3묶음 × 20개
    assert len(store._data) >= 940       # 나머지는 다음 주기로 미뤄짐


def test_active_expire_stops_when_ratio_low():
    random.seed(1)
    clock = FakeClock()
    store = MiniRedis(clock=clock)
    store.set("dead", 1, ttl=1)
    for i in range(999):
        store.set(f"alive:{i}", i, ttl=3600)
    clock.advance(2)
    sampled_batches = []
    original = store.sample_expire

    def spy(n):                           # 몇 묶음을 돌았는지 세는 감시용 래퍼
        result = original(n)
        sampled_batches.append(result)
        return result

    store.sample_expire = spy
    active_expire_cycle(store, timer=StepTimer(0.0))
    assert len(sampled_batches) == 1      # 만료 비율 ≤ 25% → 한 묶음만 보고 멈춤


@pytest.mark.anyio
async def test_lifespan_runs_active_expire_in_background():
    clock = FakeClock()
    store = MiniRedis(clock=clock)
    store.set("temp", 1, ttl=1)
    store.set("keep", 1)
    clock.advance(2)
    app = create_app(store, expire_interval=0.01)
    # lifespan_context: uvicorn 이 서버 시작/종료 때 하는 일을 테스트에서 직접 실행
    async with app.router.lifespan_context(app):
        for _ in range(100):              # 최대 1초까지 기다림
            if not store._data.contains("temp"):
                break
            await asyncio.sleep(0.01)     # 여기서 제어권을 넘겨야 백그라운드 태스크가 돈다
        assert not store._data.contains("temp")   # 아무도 조회 안 했는데 지워짐
        assert store._data.contains("keep")
    # 블록을 나오면 태스크가 취소된다: 남아 있는 다른 태스크가 없어야 함
    names = [t.get_coro().__name__ for t in asyncio.all_tasks()]
    assert "active_expire_loop" not in names


# ===========================================================================
# 동시성 테스트 (실제 서버에 HTTP 요청 1000개를 동시에)
# ===========================================================================
@pytest.mark.anyio
async def test_concurrent_incr_same_key(server_url):
    async with make_client(server_url) as c:
        # gather: 코루틴 1000개를 한꺼번에 시작하고 전부 끝날 때까지 기다린다 (Java 의 CompletableFuture.allOf)
        # 연결 10개로 동시에 보내므로 서버에는 항상 여러 요청이 섞여 들어간다
        responses = await gather_bounded([c.post(k("counter") + "/incr") for _ in range(1000)])
        assert all(r.status_code == 200 for r in responses)
        values = sorted(r.json()["value"] for r in responses)
        assert values == list(range(1, 1001))      # 1~1000 이 정확히 한 번씩 → 중복·유실 없음
        assert (await c.get(k("counter"))).json()["value"] == 1000


@pytest.mark.anyio
async def test_concurrent_set_get_mixed(server_url):
    async with make_client(server_url) as c:

        async def write_then_read(i: int):
            key = f"user:{i}"
            r = await c.put(k(key), json={"value": {"id": i, "name": f"이름{i}"}})
            assert r.status_code == 200
            r = await c.get(k(key))
            return i, r.json()["value"]

        tasks = [write_then_read(i) for i in range(500)]
        random.shuffle(tasks)                       # 순서까지 섞어서 동시에 실행
        results = await gather_bounded(tasks)
        for i, value in results:
            assert value == {"id": i, "name": f"이름{i}"}
        keys = (await c.get("/keys", params={"pattern": "user:*"})).json()["keys"]
        assert len(keys) == 500


# ===========================================================================
# 스레드 안전망: 서버는 싱글 스레드지만, 저장소를 여러 스레드가 직접 써도 Lock 덕분에 정확하다
# ===========================================================================
def test_threads_incr_with_lock_is_exact():
    store = MiniRedis()
    n_threads, per_thread = 8, 2000

    def worker():
        for _ in range(per_thread):
            store.incr("c")

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert store.get("c") == n_threads * per_thread


# ===========================================================================
# 참고 실험: 클라이언트가 GET 후 SET 으로 직접 증가시키면 값이 틀어진다
# 서버의 Lock 이나 싱글 스레드는 "요청 하나"만 지켜줄 뿐, GET 과 SET 두 요청 사이는 지켜주지 못한다.
# 그래서 읽기-수정-쓰기를 서버 안에서 한 번에 하는 incr 이 필요하다.
# ===========================================================================
@pytest.mark.anyio
@pytest.mark.xfail(
    reason="GET→SET 사이에 다른 요청이 끼어들어 증가분이 사라진다 (lost update). 서버 쪽 incr 이 필요한 이유",
    strict=True,  # 만약 통과해버리면(=유실이 안 생기면) 오히려 실패로 표시 → 실험이 의미 있는지도 검증
)
async def test_client_side_increment_loses_updates(server_url):
    async with make_client(server_url) as c:
        await c.put(k("counter"), json={"value": 0})

        async def unsafe_increment():
            current = (await c.get(k("counter"))).json()["value"]        # 1) 읽기
            # ← 이 await 사이에 다른 999개 요청도 같은 옛날 값을 읽어 간다
            await c.put(k("counter"), json={"value": current + 1})      # 2) 쓰기 (다른 요청의 결과를 덮어씀)

        await gather_bounded([unsafe_increment() for _ in range(1000)])
        final = (await c.get(k("counter"))).json()["value"]
        assert final == 1000, f"1000 번 증가했지만 최종 값은 {final}"
