"""요청/응답 본문 모양(스키마). Pydantic 이 JSON ↔ 객체 변환과 검증을 자동으로 해준다.

Java로 치면 @Valid 가 붙은 DTO 클래스와 같다.
"""

from typing import Annotated, Any

from pydantic import BaseModel, Field

# Annotated[타입, 조건] = "이 타입인데 이런 조건도 만족해야 함"
# strict=True: "10" 같은 문자열이나 1.5 같은 실수를 정수로 몰래 바꿔주지 않고 거절한다 (true/false 도 거절)
# gt=0: 0보다 커야 함 (greater than)
PositiveTTL = Annotated[int, Field(strict=True, gt=0, description="만료까지 남은 초 (양의 정수)")]
StrictInt = Annotated[int, Field(strict=True)]


# ---------------------------------------------------------------------------
# 요청 본문
# ---------------------------------------------------------------------------
class SetRequest(BaseModel):
    value: Any                       # 기본값이 없으므로 필수. JSON 이면 무엇이든(null 포함) 가능
    ttl: PositiveTTL | None = None   # 생략하거나 null 이면 만료 없음


class ExpireRequest(BaseModel):
    ttl: PositiveTTL


class IncrRequest(BaseModel):
    amount: StrictInt = 1            # 음수를 주면 감소


# ---------------------------------------------------------------------------
# 응답 본문
# ---------------------------------------------------------------------------
class KeyValueResponse(BaseModel):
    key: str
    value: Any
    ttl: int                         # -1 = 만료 없음, 그 외 남은 초


class DeletedResponse(BaseModel):
    deleted: bool


class TTLResponse(BaseModel):
    key: str
    ttl: int


class PersistResponse(BaseModel):
    key: str
    persisted: bool                  # 원래 만료가 없던 키면 false


class IncrResponse(BaseModel):
    key: str
    value: int


class KeysResponse(BaseModel):
    keys: list[str]


class DeletedCountResponse(BaseModel):
    deleted: int


class ErrorResponse(BaseModel):
    """모든 에러 응답의 공통 모양."""
    error: str      # 기계가 읽는 코드 (예: KEY_NOT_FOUND)
    message: str    # 사람이 읽는 설명
