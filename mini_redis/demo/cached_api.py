"""Mini Redis 로 캐시를 붙인 API. 포트 8002.

실행 (ai-framework 폴더에서, Mini Redis(8000)와 slow_api(8001)를 먼저 띄운 뒤):
    uvicorn mini_redis.demo.cached_api:app --port 8002
    또는 python -m mini_redis.demo.cached_api

Cache-Aside(= Lazy Loading) 패턴:
    1) 캐시(Mini Redis)에서 먼저 찾는다          → 있으면 바로 반환        X-Cache: HIT
    2) 없으면 원본(slow_api)에서 가져와 캐시에 저장 → TTL 60초               X-Cache: MISS
    3) 캐시 서버가 죽어 있으면 원본 결과를 그대로 반환 (서비스는 계속 동작)  X-Cache: BYPASS
    쓰기(PUT)는 원본을 먼저 고친 뒤 캐시 키를 "지운다"(무효화). 다음 조회 때 새 값이 다시 캐시된다.
"""

import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from ..client import AsyncMiniRedisClient, MiniRedisError
from .slow_api import ProductUpdate

logger = logging.getLogger("mini_redis.demo.cached_api")

MINI_REDIS_URL = os.environ.get("MINI_REDIS_URL", "http://127.0.0.1:8000")
SLOW_API_URL = os.environ.get("SLOW_API_URL", "http://127.0.0.1:8001")
CACHE_TTL = 60  # 초


def cache_key(product_id: int) -> str:
    return f"product:{product_id}"


def create_app(cache: AsyncMiniRedisClient | None = None, origin: httpx.AsyncClient | None = None, ttl: int = CACHE_TTL):
    """테스트는 cache/origin 에 메모리 안에서 동작하는 클라이언트를 넣는다. 안 넣으면 실제 주소로 연결."""
    own_clients = cache is None and origin is None          # 직접 만든 클라이언트만 종료 시 닫는다
    cache = cache or AsyncMiniRedisClient(MINI_REDIS_URL, timeout=1.0)
    origin = origin or httpx.AsyncClient(base_url=SLOW_API_URL, timeout=10.0)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        if own_clients:
            await cache.aclose()
            await origin.aclose()

    app = FastAPI(title="Cached Product API (Cache-Aside)", lifespan=lifespan)

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

        # 2) 캐시 없음 → 원본 조회 후 저장
        status, body = await fetch_origin(product_id)
        if status != 200:
            return JSONResponse(body, status_code=status, headers={"X-Cache": "MISS"})  # 에러 응답은 캐시하지 않음
        try:
            await cache.set(key, body, ttl=ttl)             # TTL 덕분에 무효화를 놓쳐도 최대 60초 뒤엔 새 값
            return JSONResponse(body, headers={"X-Cache": "MISS"})
        except MiniRedisError as e:                         # 조회와 저장 사이에 캐시 서버가 죽은 경우
            logger.warning("캐시 저장 실패: %s", e)
            return JSONResponse(body, headers={"X-Cache": "BYPASS"})

    @app.put("/products/{product_id}")
    async def update_product(product_id: int, body: ProductUpdate):
        # 1) 원본(진짜 데이터)을 먼저 수정
        try:
            resp = await origin.put(f"/products/{product_id}", json=body.model_dump(exclude_none=True))
        except httpx.TransportError:
            return JSONResponse({"error": "ORIGIN_UNAVAILABLE", "message": "원본 API 에 연결할 수 없습니다"}, status_code=502)
        if resp.status_code != 200:
            return JSONResponse(resp.json(), status_code=resp.status_code)
        # 2) 캐시는 새 값으로 "갱신"하지 않고 "삭제"한다
        #    갱신 방식은 동시에 들어온 두 수정의 순서가 꼬이면 옛 값이 캐시에 남을 수 있다.
        #    삭제하면 다음 조회가 원본에서 최신 값을 가져오므로 더 단순하고 안전하다.
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
