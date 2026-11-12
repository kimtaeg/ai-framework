"""느린 원본 API (데이터베이스 역할). 포트 8001.

실행 (ai-framework 폴더에서):
    uvicorn mini_redis.demo.slow_api:app --port 8001
    또는 python -m mini_redis.demo.slow_api

GET /products/{id} 는 일부러 0.5초 쉰 뒤 응답한다. 실제 서비스의 느린 DB 쿼리·외부 API 호출을 흉내 낸 것이다.
"""

import asyncio
import os
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..core.hashtable import HashTable

MAX_PRODUCT_ID = 1000
DEFAULT_DELAY = float(os.environ.get("SLOW_API_DELAY", "0.5"))  # 환경 변수로 지연 시간 조절 가능


class ProductUpdate(BaseModel):
    name: str | None = None
    price: int | None = None


def base_product(product_id: int) -> dict:
    """수정된 적 없는 상품의 기본 모양 (id 로 항상 같은 값이 나온다)."""
    return {"id": product_id, "name": f"상품 {product_id}", "price": 1000 + product_id * 100, "version": 1}


def not_found(product_id: int) -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": "PRODUCT_NOT_FOUND", "message": f"상품 {product_id} 이 없습니다"})


def create_app(delay: float = DEFAULT_DELAY, write_delay: float | None = None) -> FastAPI:
    """delay: 조회 지연, write_delay: 수정 지연 (생략하면 delay 와 같음). 테스트는 경합 상황을 만들려고 따로 준다."""
    write_delay = delay if write_delay is None else write_delay
    app = FastAPI(title="Slow Product API (원본)")
    # 수정된 상품만 따로 보관한다. 데모용 '원본 DB'지만 1단계 HashTable 을 그대로 재사용했다.
    app.state.products = HashTable()
    app.state.calls = 0               # 원본까지 온 조회 횟수 (캐시가 얼마나 원본 부하를 줄였는지 보기 위함)

    @app.get("/products/{product_id}")
    async def get_product(product_id: int):
        if not 1 <= product_id <= MAX_PRODUCT_ID:
            return not_found(product_id)
        app.state.calls += 1
        # 실제 DB 처럼 "읽는 시점"의 값을 먼저 확정하고, 응답은 느리게 돌아온다
        product = app.state.products.get(str(product_id)) or base_product(product_id)
        await asyncio.sleep(delay)   # 느린 DB·네트워크 흉내. await 라서 기다리는 동안 다른 요청은 처리된다
        return {**product, "served_at": time.time()}   # {**a, ...}: a 를 복사하면서 키 추가 (JS 의 스프레드와 같음)

    @app.put("/products/{product_id}")
    async def update_product(product_id: int, body: ProductUpdate):
        if not 1 <= product_id <= MAX_PRODUCT_ID:
            return not_found(product_id)
        await asyncio.sleep(write_delay)
        current = app.state.products.get(str(product_id)) or base_product(product_id)
        # exclude_none: 보내지 않은(None) 필드는 빼고 → 보낸 필드만 덮어쓴다
        updated = {**current, **body.model_dump(exclude_none=True), "version": current["version"] + 1}
        app.state.products.put(str(product_id), updated)
        return updated

    @app.get("/stats")
    async def stats():
        return {"origin_calls": app.state.calls}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8001)
