"""왜 서버 쪽 incr 과 Lock 이 필요한가 보여주는 데모.

실행 (ai-framework 폴더에서):
    python -m mini_redis.demo.race_demo

실험 1 (HTTP): 클라이언트가 GET 후 SET 으로 +1 하는 방식 vs 서버의 incr
실험 2 (스레드): 저장소에서 Lock 을 뺀 경우 vs Lock 이 있는 경우
"""

import asyncio
import contextlib
import sys
import threading

import httpx

from ..core.store import MiniRedis
from ..server.app import create_app
from ..server.thread_server import running_server

N = 1000


CONNECTIONS = 10  # 동시에 열어 둘 연결 수. 2개 이상이면 서버에서 요청이 섞인다


async def gather_bounded(coros, limit: int = CONNECTIONS):
    """전부 동시에 시작하되 실제로 날아가는 요청은 limit 개로 제한 (httpx 대기열 비용을 줄여 빠르게)."""
    sem = asyncio.Semaphore(limit)

    async def run(coro):
        async with sem:
            return await coro

    return await asyncio.gather(*(run(c) for c in coros))


async def http_experiment(base_url: str) -> None:
    limits = httpx.Limits(max_connections=CONNECTIONS)
    async with httpx.AsyncClient(base_url=base_url, timeout=30, limits=limits) as c:
        # (a) 클라이언트 쪽 증가: 읽기와 쓰기가 서로 다른 요청 → 그 사이에 남이 끼어든다
        await c.put("/keys/unsafe", json={"value": 0})

        async def get_then_set():
            v = (await c.get("/keys/unsafe")).json()["value"]
            await c.put("/keys/unsafe", json={"value": v + 1})

        await gather_bounded([get_then_set() for _ in range(N)])
        unsafe = (await c.get("/keys/unsafe")).json()["value"]

        # (b) 서버 쪽 incr: 읽기-수정-쓰기가 요청 하나 안에서 끝난다
        await gather_bounded([c.post("/keys/safe/incr") for _ in range(N)])
        safe = (await c.get("/keys/safe")).json()["value"]

    print(f"[실험 1] HTTP 동시 요청 {N}개")
    print(f"  GET 후 SET (클라이언트 증가): {unsafe:5d}  ← {N - unsafe}번의 증가가 사라짐")
    print(f"  POST /incr (서버 증가)      : {safe:5d}")


def thread_experiment(use_lock: bool, n_threads: int = 8, per_thread: int = 20_000) -> int:
    store = MiniRedis()
    if not use_lock:
        # nullcontext(): with 문에서 아무것도 하지 않는 가짜 자물쇠 → Lock 을 뺀 것과 같다
        store._lock = contextlib.nullcontext()

    def worker():
        for _ in range(per_thread):
            store.incr("c")

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return store.get("c")


def main() -> None:
    with running_server(create_app(MiniRedis())) as url:  # 실제 uvicorn 서버를 잠깐 띄움
        asyncio.run(http_experiment(url))

    # 스레드 전환을 아주 잦게 만들어서 "읽기와 쓰기 사이에 끼어들기"가 잘 보이게 한다 (기본 5ms → 1µs)
    sys.setswitchinterval(1e-6)
    expected = 8 * 20_000
    print(f"\n[실험 2] 스레드 8개 × 20,000번 store.incr (기대값 {expected:,})")
    no_lock = thread_experiment(use_lock=False)
    print(f"  Lock 없음: {no_lock:,}  ← {expected - no_lock:,}번 유실")
    with_lock = thread_experiment(use_lock=True)
    print(f"  Lock 있음: {with_lock:,}")


if __name__ == "__main__":
    main()
