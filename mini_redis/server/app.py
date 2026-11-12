"""FastAPI 앱 조립: 저장소 1개 생성 + 라우터 등록 + 에러 응답 형식 통일.

실행 (ai-framework 폴더에서):
    uvicorn mini_redis.server.app:app --workers 1
워커를 1개로 두는 이유: 워커(프로세스)가 여러 개면 프로세스마다 저장소가 따로 생겨 데이터가 갈라진다.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..core.expiry import active_expire_cycle
from ..core.store import MiniRedis
from .routes import ApiError, router

logger = logging.getLogger("mini_redis")

ACTIVE_EXPIRE_INTERVAL = 0.1  # 100ms 마다 만료 키 청소

# 프레임워크 기본 에러(없는 경로, 허용 안 된 메서드)를 우리 에러 코드로 바꾸는 표
HTTP_ERROR_CODES = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}  # 응답 변환용 상수 표 (저장소 데이터 아님)


def error_response(status_code: int, error: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error, "message": message})


async def active_expire_loop(store: MiniRedis, interval: float) -> None:
    """interval 초마다 active_expire_cycle 을 실행하는 무한 루프 (서버가 꺼질 때 취소된다).

    [왜 저장소와 동시에 실행되지 않는가]
    이 루프는 asyncio 태스크라서, 요청을 처리하는 것과 "같은 이벤트 루프 = 같은 스레드"에서 돈다.
    이벤트 루프는 한 번에 코루틴 하나만 실행하고, 다른 코루틴으로 넘어가는 것은 await 지점에서만 일어난다.
      - 이 루프의 await 는 asyncio.sleep() 하나뿐이고,
      - active_expire_cycle() 과 저장소 메서드 안에는 await 가 없다.
    그래서 청소가 도는 동안 요청 핸들러가 끼어들 수 없고, 반대로 요청 처리 중에 청소가 끼어들 수도 없다.
    (Java 처럼 별도 스레드로 만들었다면 Lock 이 꼭 필요했을 것이다.)
    대신 청소가 오래 걸리면 그동안 요청이 멈추므로, 한 번에 최대 25ms 로 제한한다.
    """
    while True:
        await asyncio.sleep(interval)       # 여기서 이벤트 루프에 제어권을 넘겨 요청들이 처리된다
        try:
            active_expire_cycle(store)      # await 없음 → 끝날 때까지 다른 코루틴이 끼어들지 않음
        except Exception:                   # 청소 중 예외가 나도 서버 전체가 죽지 않고 다음 주기에 다시 시도
            logger.exception("active expiration 실패")


def create_app(
    store: MiniRedis | None = None,
    active_expire: bool = True,
    expire_interval: float = ACTIVE_EXPIRE_INTERVAL,
) -> FastAPI:
    """앱을 만든다. 테스트는 가짜 시계를 넣은 store 를 넘겨서 독립된 앱을 만든다."""
    store = store if store is not None else MiniRedis()

    # lifespan: 서버가 켜질 때 yield 앞부분, 꺼질 때 yield 뒷부분이 실행된다 (try/finally 와 비슷한 흐름)
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = None
        if active_expire:
            # create_task: 코루틴을 백그라운드에서 돌리기 시작 (스레드를 만드는 게 아니라 같은 루프에 예약)
            # app.state.store 를 시작 시점에 읽어서, 테스트가 저장소를 바꿔 끼웠어도 그 저장소를 청소한다
            task = asyncio.create_task(active_expire_loop(app.state.store, expire_interval))
        yield                               # ← 서버가 요청을 받는 동안 여기서 대기
        if task is not None:
            task.cancel()                   # 종료 시 태스크 취소: sleep 중이던 태스크에 CancelledError 가 발생
            try:
                await task                  # 취소가 실제로 끝날 때까지 기다림
            except asyncio.CancelledError:
                pass                        # 우리가 취소한 것이니 정상

    app = FastAPI(title="Mini Redis", lifespan=lifespan)
    # app.state: 앱 전체에서 공유하는 보관함. 저장소는 여기에 딱 하나만 둔다.
    app.state.store = store
    app.include_router(router)

    # --- 에러 핸들러: 어떤 에러든 {"error": 코드, "message": 설명} 형식으로 응답 ---
    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError):
        return error_response(exc.status_code, exc.error, exc.message)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        # 본문이 JSON 문법부터 틀렸으면 400, 문법은 맞는데 값이 규칙에 안 맞으면 422
        if any(e.get("type") == "json_invalid" for e in errors):
            return error_response(400, "INVALID_JSON", "요청 본문이 올바른 JSON 이 아닙니다")
        # loc 예: ("body", "ttl") → "body.ttl"
        message = "; ".join(".".join(str(p) for p in e["loc"]) + ": " + e["msg"] for e in errors)
        return error_response(422, "VALIDATION_ERROR", message)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException):
        code = HTTP_ERROR_CODES.get(exc.status_code, "HTTP_ERROR")
        return error_response(exc.status_code, code, str(exc.detail))

    return app


# uvicorn 이 찾는 모듈 수준 app 객체 (mini_redis.server.app:app)
app = create_app()
