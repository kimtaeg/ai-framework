"""HTTP 엔드포인트. 요청을 검증하고 MiniRedis 메서드를 호출한 뒤 결과를 JSON 으로 돌려주는 얇은 껍데기다.

[중요] 모든 엔드포인트와 의존성 함수는 `async def` 로 만든다. 일반 `def` 는 쓰지 않는다.
  - FastAPI 는 일반 def 함수를 "블로킹일지도 모른다"고 보고 스레드 풀의 다른 스레드에서 실행한다.
  - 그러면 여러 요청이 동시에 여러 스레드에서 저장소를 건드리게 되어, 싱글 스레드 설계가 깨진다.
  - async def 는 이벤트 루프 스레드 하나에서만 돈다. 그리고 저장소 메서드에는 await 가 없으니
    한 요청을 처리하는 도중에 다른 요청이 끼어들 수 없다 → Redis 와 같은 싱글 스레드 동시성 모델.
"""

import json

from fastapi import APIRouter, Depends, Query, Request

from ..core.hashtable import MISSING
from ..core.store import MiniRedis
from .schemas import (
    DeletedCountResponse,
    DeletedResponse,
    ExpireRequest,
    IncrRequest,
    IncrResponse,
    KeysResponse,
    KeyValueResponse,
    PersistResponse,
    SetRequest,
    TTLResponse,
)

MAX_KEY_LENGTH = 512
MAX_VALUE_BYTES = 1024 * 1024  # 1MB
# {key:path} 는 슬래시까지 키로 받기 때문에, "foo/ttl" 이라는 키와 "foo 의 TTL 조회"가 같은 URL 이 된다.
# 이런 모호함을 없애려고 하위 경로 이름으로 끝나는 키는 아예 받지 않는다.
RESERVED_SUFFIXES = ("/ttl", "/expire", "/persist", "/incr")

router = APIRouter()


class ApiError(Exception):
    """우리 API 의 에러. app.py 의 핸들러가 {"error", "message"} JSON 으로 바꿔 응답한다."""

    def __init__(self, status_code: int, error: str, message: str):
        self.status_code = status_code
        self.error = error
        self.message = message


# ---------------------------------------------------------------------------
# 의존성 (Depends): 엔드포인트가 실행되기 전에 FastAPI 가 먼저 호출해서 결과를 인자로 넣어준다.
# 의존성도 일반 def 면 스레드 풀에서 돌기 때문에 async def 로 만든다.
# ---------------------------------------------------------------------------
async def get_store(request: Request) -> MiniRedis:
    """app.state 에 하나만 있는 저장소를 꺼낸다. 테스트는 app 을 새로 만들거나 dependency_overrides 로 교체한다."""
    return request.app.state.store


async def valid_key(key: str) -> str:
    """경로의 {key} 검증. 키 이름이 'key' 라서 FastAPI 가 경로 파라미터 값을 그대로 넣어준다."""
    if not 1 <= len(key) <= MAX_KEY_LENGTH:
        raise ApiError(400, "INVALID_KEY", f"키 길이는 1~{MAX_KEY_LENGTH}자여야 합니다 (현재 {len(key)}자)")
    if key.endswith(RESERVED_SUFFIXES):  # endswith 에 튜플을 주면 "이 중 하나로 끝나면"
        raise ApiError(400, "INVALID_KEY", f"키는 {', '.join(RESERVED_SUFFIXES)} 로 끝날 수 없습니다")
    return key


def check_value_size(value) -> None:
    """값을 JSON 으로 직렬화했을 때 1MB 를 넘으면 413. (CPU 계산만 하는 짧은 함수라 일반 def 여도 괜찮다)"""
    size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    if size > MAX_VALUE_BYTES:
        raise ApiError(413, "VALUE_TOO_LARGE", f"값은 최대 {MAX_VALUE_BYTES}바이트입니다 (현재 {size}바이트)")


def not_found(key: str) -> ApiError:
    return ApiError(404, "KEY_NOT_FOUND", f"키 '{key}' 가 없습니다")


# ---------------------------------------------------------------------------
# 하위 경로(/ttl, /expire, /persist, /incr)를 /keys/{key:path} 보다 "먼저" 등록한다.
# 라우터는 등록 순서대로 경로를 맞춰보기 때문에, 순서가 바뀌면 "foo/ttl" 전체가 키로 잡혀버린다.
# ---------------------------------------------------------------------------
@router.get("/keys/{key:path}/ttl", response_model=TTLResponse)
async def get_ttl(key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    ttl = store.ttl(key)
    if ttl == -2:
        raise not_found(key)
    return {"key": key, "ttl": ttl}


@router.post("/keys/{key:path}/expire", response_model=TTLResponse)
async def expire_key(body: ExpireRequest, key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    if not store.expire(key, body.ttl):
        raise not_found(key)
    return {"key": key, "ttl": body.ttl}


@router.post("/keys/{key:path}/persist", response_model=PersistResponse)
async def persist_key(key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    if not store.exists(key):
        raise not_found(key)
    return {"key": key, "persisted": store.persist(key)}


@router.post("/keys/{key:path}/incr", response_model=IncrResponse)
async def incr_key(
    body: IncrRequest | None = None,  # 본문을 생략하면 amount=1
    key: str = Depends(valid_key),
    store: MiniRedis = Depends(get_store),
):
    amount = body.amount if body is not None else 1
    try:
        value = store.incr(key, amount)
    except TypeError:
        raise ApiError(409, "NOT_INTEGER", f"키 '{key}' 의 값이 정수가 아니라 증가시킬 수 없습니다")
    return {"key": key, "value": value}


# ---------------------------------------------------------------------------
# 단일 키
# ---------------------------------------------------------------------------
@router.put("/keys/{key:path}", response_model=KeyValueResponse)
async def set_key(body: SetRequest, key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    check_value_size(body.value)
    store.set(key, body.value, ttl=body.ttl)
    return {"key": key, "value": body.value, "ttl": body.ttl if body.ttl is not None else -1}


@router.get("/keys/{key:path}", response_model=KeyValueResponse)
async def get_key(key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    value = store.get(key, MISSING)  # MISSING 센티넬로 "값이 null" 과 "키 없음"을 구분
    if value is MISSING:
        raise not_found(key)
    ttl = store.ttl(key)
    if ttl == -2:  # get 과 ttl 사이 아주 짧은 순간에 만료된 경우
        raise not_found(key)
    return {"key": key, "value": value, "ttl": ttl}


@router.delete("/keys/{key:path}", response_model=DeletedResponse)
async def delete_key(key: str = Depends(valid_key), store: MiniRedis = Depends(get_store)):
    if not store.delete(key):
        raise not_found(key)
    return {"deleted": True}


# ---------------------------------------------------------------------------
# 여러 키
# ---------------------------------------------------------------------------
@router.get("/keys", response_model=KeysResponse)
async def list_keys(pattern: str = Query("*"), store: MiniRedis = Depends(get_store)):
    return {"keys": sorted(store.keys(pattern))}  # 응답은 보기 좋게 정렬


@router.delete("/keys", response_model=DeletedCountResponse)
async def delete_keys(pattern: str | None = Query(None), store: MiniRedis = Depends(get_store)):
    # 실수로 전체를 지우는 것을 막기 위해 pattern 을 반드시 요구한다 (전체 삭제는 POST /flush)
    if not pattern:
        raise ApiError(400, "PATTERN_REQUIRED", "pattern 쿼리 파라미터가 필요합니다 (예: ?pattern=user:*)")
    return {"deleted": store.delete_pattern(pattern)}


# ---------------------------------------------------------------------------
# 관리
# ---------------------------------------------------------------------------
@router.post("/flush")
async def flush(store: MiniRedis = Depends(get_store)):
    store.flush_all()
    return {"flushed": True}


@router.get("/stats")
async def stats(store: MiniRedis = Depends(get_store)):
    return store.stats()


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.post("/admin/rewrite-aof")
async def rewrite_aof(store: MiniRedis = Depends(get_store)):
    """AOF 파일을 살아 있는 키만으로 다시 써서 크기를 줄인다."""
    if store.aof is None:
        raise ApiError(409, "AOF_DISABLED", "AOF 가 켜져 있지 않습니다")
    commands = store.aof.rewrite(store)
    return {"rewritten": True, "commands": commands}
