"""FastAPI 앱 조립: 저장소 1개 생성 + 라우터 등록 + 에러 응답 형식 통일.

실행 (ai-framework 폴더에서):
    uvicorn mini_redis.server.app:app --workers 1
워커를 1개로 두는 이유: 워커(프로세스)가 여러 개면 프로세스마다 저장소가 따로 생겨 데이터가 갈라진다.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..core.store import MiniRedis
from .routes import ApiError, router

# 프레임워크 기본 에러(없는 경로, 허용 안 된 메서드)를 우리 에러 코드로 바꾸는 표
HTTP_ERROR_CODES = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}  # 응답 변환용 상수 표 (저장소 데이터 아님)


def error_response(status_code: int, error: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error, "message": message})


def create_app(store: MiniRedis | None = None) -> FastAPI:
    """앱을 만든다. 테스트는 가짜 시계를 넣은 store 를 넘겨서 독립된 앱을 만든다."""
    app = FastAPI(title="Mini Redis")
    # app.state: 앱 전체에서 공유하는 보관함. 저장소는 여기에 딱 하나만 둔다.
    app.state.store = store if store is not None else MiniRedis()
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
