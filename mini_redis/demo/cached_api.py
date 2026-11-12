"""Mini Redis 로 캐시를 붙인 API. 포트 8002.

실행 (ai-framework 폴더에서, Mini Redis(8000)와 slow_api(8001)를 먼저 띄운 뒤):
    uvicorn mini_redis.demo.cached_api:app --port 8002
    또는 python -m mini_redis.demo.cached_api

Cache-Aside(= Lazy Loading) 패턴:
    1) 캐시(Mini Redis)에서 먼저 찾는다          → 있으면 바로 반환        X-Cache: HIT
    2) 없으면 원본(slow_api)에서 가져와 캐시에 저장 → TTL 60초               X-Cache: MISS
    3) 캐시 서버가 죽어 있으면 원본 결과를 그대로 반환 (서비스는 계속 동작)  X-Cache: BYPASS
    쓰기(PUT)는 원본을 먼저 고친 뒤 캐시 키를 "지운다"(무효화). 다음 조회 때 새 값이 다시 캐시된다.

같은 상품의 "캐시 미스 GET(원본 조회 + 캐시 저장)" 과 "PUT(원본 수정 + 캐시 삭제)" 은 상품별 asyncio.Lock 으로 한 줄로 세운다.
  - 막는 문제 1 (오래된 값 부활): GET 이 수정 전 v1 을 읽음 → PUT 이 v2 로 고치고 캐시 삭제 → GET 이 늦게 v1 을 저장
  - 막는 문제 2 (cache stampede): 같은 상품을 동시에 처음 요청하면 원본을 여러 번 부름
    → Lock 을 얻은 뒤 캐시를 한 번 더 확인하므로 원본 호출은 한 번뿐
  HIT 경로는 Lock 을 잡지 않으므로 빠르다. 단, 이 Lock 은 cached_api 프로세스 하나 안에서만 유효하다
  (여러 대로 늘리면 분산 락이나 버전 비교가 필요하다).
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from ..client import AsyncMiniRedisClient, MiniRedisError
from ..core.hashtable import HashTable
from .slow_api import ProductUpdate

logger = logging.getLogger("mini_redis.demo.cached_api")

MINI_REDIS_URL = os.environ.get("MINI_REDIS_URL", "http://127.0.0.1:8000")
SLOW_API_URL = os.environ.get("SLOW_API_URL", "http://127.0.0.1:8001")
CACHE_TTL = 60  # 초


def cache_key(product_id: int) -> str:
    return f"product:{product_id}"


def create_app(cache: AsyncMiniRedisClient | None = None, origin: httpx.AsyncClient | None = None, ttl: int = CACHE_TTL):
    """테스트는 cache/origin 에 메모리 안에서 동작하는 클라이언트를 넣는다. 안 넣으면 실제 주소로 연결."""
    # 클라이언트마다 "이 앱이 직접 만들었는가"를 따로 기억한다 → 종료 시 직접 만든 것만 닫는다
    # (주입받은 클라이언트는 만든 쪽이 닫을 책임이 있다)
    owns_cache = cache is None
    owns_origin = origin is None
    if owns_cache:
        cache = AsyncMiniRedisClient(MINI_REDIS_URL, timeout=1.0)
    if owns_origin:
        origin = httpx.AsyncClient(base_url=SLOW_API_URL, timeout=10.0)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        if owns_cache:
            await cache.aclose()
        if owns_origin:
            await origin.aclose()

    app = FastAPI(title="Cached Product API (Cache-Aside)", lifespan=lifespan)
    # 상품 id → [asyncio.Lock, 사용 중인 요청 수]. 아무도 안 쓰면 바로 지워서,
    # 존재하지 않는 id 를 마구 요청해도 Lock 이 계속 쌓이지 않는다 (메모리 고갈 방지)
    locks = HashTable()

    @asynccontextmanager
    async def product_lock(product_id: int):
        """같은 상품끼리만 순서를 정한다. 다른 상품 요청은 서로 기다리지 않는다.

        asyncio.Lock 은 스레드용 Lock 과 달리, 기다리는 동안 이벤트 루프가 다른 요청을 처리한다(await).
        "찾기 → 없으면 만들기 → 사용 수 +1" 과 "사용 수 -1 → 0이면 지우기" 사이에는 await 가 없어서
        다른 요청이 끼어들 수 없다 (싱글 스레드 이벤트 루프).
        """
        key = str(product_id)
        entry = locks.get(key)
        if entry is None:
            entry = [asyncio.Lock(), 0]
            locks.put(key, entry)
        entry[1] += 1                     # 기다리는 요청도 센다 → 기다리는 중에 Lock 이 지워지지 않음
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0:
                locks.remove(key)         # 마지막 사용자가 나가면 회수

    app.state.locks = locks               # 테스트에서 회수 여부를 확인할 때 사용

    app.state.cache = cache                # 테스트에서 연결 상태를 확인할 때 사용
    app.state.origin = origin

    async def fetch_origin(product_id: int):
        """원본 조회. (상태 코드, 본문) 을 돌려준다."""
        try:
            resp = await origin.get(f"/products/{product_id}")
        except httpx.TransportError:
            return 502, {"error": "ORIGIN_UNAVAILABLE", "message": "원본 API 에 연결할 수 없습니다"}
        return resp.status_code, resp.json()

    @app.get("/products/{product_id}")
    async def get_product(product_id: int):
        key = cache_key(product_id)

        # 1) 캐시 조회
        try:
            cached = await cache.get(key)
        except MiniRedisError as e:                         # 캐시 서버 다운(MiniRedisUnavailable 포함)
            logger.warning("캐시 조회 실패, 원본으로 우회: %s", e)
            status, body = await fetch_origin(product_id)
            return JSONResponse(body, status_code=status, headers={"X-Cache": "BYPASS"})
        if cached is not None:
            return JSONResponse(cached, headers={"X-Cache": "HIT"})

        # 2) 캐시 없음 → 같은 상품의 다른 미스/수정과 순서를 맞춘 뒤 원본 조회 후 저장
        async with product_lock(product_id):
            # 기다리는 동안 앞선 요청이 캐시를 채웠을 수 있으니 한 번 더 확인 (double-checked)
            try:
                cached = await cache.get(key)
            except MiniRedisError:
                cached = None
            if cached is not None:
                return JSONResponse(cached, headers={"X-Cache": "HIT"})

            status, body = await fetch_origin(product_id)
            if status != 200:
                return JSONResponse(body, status_code=status, headers={"X-Cache": "MISS"})  # 에러 응답은 캐시하지 않음
            try:
                # Lock 안에서 저장하므로, 이 사이에 PUT 의 무효화가 먼저 끝나 버리는 일이 없다
                await cache.set(key, body, ttl=ttl)         # TTL 은 최후의 안전망 (다른 프로세스가 원본을 고친 경우 등)
                return JSONResponse(body, headers={"X-Cache": "MISS"})
            except MiniRedisError as e:                     # 조회와 저장 사이에 캐시 서버가 죽은 경우
                logger.warning("캐시 저장 실패: %s", e)
                return JSONResponse(body, headers={"X-Cache": "BYPASS"})

    @app.put("/products/{product_id}")
    async def update_product(product_id: int, body: ProductUpdate):
        # 진행 중인 캐시 미스 GET 이 있으면 그 GET 이 저장까지 끝낸 뒤에 수정·삭제한다
        # → 수정 전 값을 읽은 GET 이 무효화 "뒤에" 옛 값을 다시 저장하는 순서가 생기지 않는다
        async with product_lock(product_id):
            # 1) 원본(진짜 데이터)을 먼저 수정
            try:
                resp = await origin.put(f"/products/{product_id}", json=body.model_dump(exclude_none=True))
            except httpx.TransportError:
                return JSONResponse({"error": "ORIGIN_UNAVAILABLE", "message": "원본 API 에 연결할 수 없습니다"}, status_code=502)
            if resp.status_code != 200:
                return JSONResponse(resp.json(), status_code=resp.status_code)
            # 2) 캐시는 새 값으로 "갱신"하지 않고 "삭제"한다
            #    갱신 방식은 동시에 들어온 두 수정의 순서가 꼬이면 옛 값이 캐시에 남을 수 있다.
            #    삭제하면 다음 조회가 원본에서 최신 값을 가져온다.
            try:
                await cache.delete(cache_key(product_id))
                invalidated = "true"
            except MiniRedisError as e:
                logger.warning("캐시 무효화 실패 (TTL 이 지나면 자동으로 사라짐): %s", e)
                invalidated = "false"
            return JSONResponse(resp.json(), headers={"X-Cache-Invalidated": invalidated})

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8002)
