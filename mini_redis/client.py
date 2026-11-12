"""Mini Redis HTTP 서버를 Python 함수처럼 쓰게 해주는 클라이언트.

사용 예:
    c = MiniRedisClient("http://127.0.0.1:8000")
    c.set("user:1", {"name": "kim"}, ttl=60)
    c.get("user:1")   # {'name': 'kim'}
"""

from urllib.parse import quote

import httpx


class MiniRedisError(Exception):
    """서버가 에러 응답({"error", "message"})을 돌려준 경우."""

    def __init__(self, status_code: int, error: str, message: str):
        super().__init__(f"[{status_code} {error}] {message}")
        self.status_code = status_code
        self.error = error
        self.message = message


class MiniRedisUnavailable(MiniRedisError):
    """서버에 연결할 수 없음 (서버 꺼짐, 타임아웃 등). 캐시라면 이 예외를 잡고 원본 데이터로 우회하면 된다."""

    def __init__(self, cause: Exception):
        super().__init__(0, "UNAVAILABLE", f"Mini Redis 서버에 연결할 수 없습니다: {cause}")


class MiniRedisClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8000", timeout: float = 2.0, http_client=None):
        # http_client: 테스트에서 실제 네트워크 대신 쓸 httpx.Client 를 넣을 수 있다
        # httpx.Client 는 연결을 재사용(keep-alive)하므로 요청마다 새로 연결하는 것보다 빠르다
        self._http = http_client or httpx.Client(base_url=base_url, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    # with MiniRedisClient(...) as c: 문법 지원 (블록이 끝나면 자동으로 close)
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------------
    @staticmethod
    def _path(key: str, suffix: str = "") -> str:
        # safe="" → '/', '?', '#', 공백, 한글까지 전부 %XX 로 인코딩.
        # 키 안의 '/' 가 URL 경로 구분자로 해석되거나 '..' 이 정리(normalize)되는 것을 막는다. 서버가 다시 디코딩한다.
        return f"/keys/{quote(key, safe='')}{suffix}"

    def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        try:
            return self._http.request(method, url, **kwargs)
        except httpx.TransportError as e:  # 연결 거부·타임아웃·네트워크 오류의 공통 부모
            raise MiniRedisUnavailable(e) from e

    @staticmethod
    def _raise_for_error(resp: httpx.Response) -> None:
        if resp.status_code >= 400:
            try:
                body = resp.json()
                raise MiniRedisError(resp.status_code, body.get("error", "HTTP_ERROR"), body.get("message", ""))
            except ValueError:  # 본문이 JSON 이 아닌 경우
                raise MiniRedisError(resp.status_code, "HTTP_ERROR", resp.text)

    # ------------------------------------------------------------------
    def get(self, key: str):
        """값을 돌려준다. 키가 없으면 None. (값 자체가 null 이어도 None 이 나오니 구분이 필요하면 ttl() 을 함께 본다)"""
        resp = self._request("GET", self._path(key))
        if resp.status_code == 404:
            return None
        self._raise_for_error(resp)
        return resp.json()["value"]

    def set(self, key: str, value, ttl: int | None = None) -> None:
        resp = self._request("PUT", self._path(key), json={"value": value, "ttl": ttl})
        self._raise_for_error(resp)

    def delete(self, key: str) -> bool:
        resp = self._request("DELETE", self._path(key))
        if resp.status_code == 404:
            return False
        self._raise_for_error(resp)
        return True

    def expire(self, key: str, ttl: int) -> bool:
        resp = self._request("POST", self._path(key, "/expire"), json={"ttl": ttl})
        if resp.status_code == 404:
            return False
        self._raise_for_error(resp)
        return True

    def ttl(self, key: str) -> int:
        """-2: 키 없음, -1: 만료 없음, 그 외 남은 초 (MiniRedis.ttl 과 같은 규칙)."""
        resp = self._request("GET", self._path(key, "/ttl"))
        if resp.status_code == 404:
            return -2
        self._raise_for_error(resp)
        return resp.json()["ttl"]

    def incr(self, key: str, amount: int = 1) -> int:
        resp = self._request("POST", self._path(key, "/incr"), json={"amount": amount})
        self._raise_for_error(resp)  # 정수가 아닌 값이면 409 → MiniRedisError
        return resp.json()["value"]

    def delete_pattern(self, pattern: str) -> int:
        resp = self._request("DELETE", "/keys", params={"pattern": pattern})
        self._raise_for_error(resp)
        return resp.json()["deleted"]


class AsyncMiniRedisClient:
    """async 버전. FastAPI 같은 async 앱 안에서는 반드시 이쪽을 쓴다.

    동기 클라이언트(MiniRedisClient)를 async 함수 안에서 쓰면, 응답을 기다리는 동안 이벤트 루프 전체가 멈춰
    다른 요청을 하나도 처리하지 못한다. await 로 기다리면 그동안 이벤트 루프가 다른 요청을 처리한다.
    메서드 이름과 반환 규칙은 MiniRedisClient 와 같다.
    """

    def __init__(self, base_url: str = "http://127.0.0.1:8000", timeout: float = 2.0, http_client=None):
        self._http = http_client or httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    # async with AsyncMiniRedisClient(...) as c: 문법 지원
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        try:
            return await self._http.request(method, url, **kwargs)
        except httpx.TransportError as e:
            raise MiniRedisUnavailable(e) from e

    # URL 만들기·에러 변환은 동기 클라이언트의 것을 그대로 재사용 (staticmethod 라 클래스 이름으로 호출 가능)
    _path = staticmethod(MiniRedisClient._path)
    _raise_for_error = staticmethod(MiniRedisClient._raise_for_error)

    async def get(self, key: str):
        resp = await self._request("GET", self._path(key))
        if resp.status_code == 404:
            return None
        self._raise_for_error(resp)
        return resp.json()["value"]

    async def set(self, key: str, value, ttl: int | None = None) -> None:
        resp = await self._request("PUT", self._path(key), json={"value": value, "ttl": ttl})
        self._raise_for_error(resp)

    async def delete(self, key: str) -> bool:
        resp = await self._request("DELETE", self._path(key))
        if resp.status_code == 404:
            return False
        self._raise_for_error(resp)
        return True

    async def expire(self, key: str, ttl: int) -> bool:
        resp = await self._request("POST", self._path(key, "/expire"), json={"ttl": ttl})
        if resp.status_code == 404:
            return False
        self._raise_for_error(resp)
        return True

    async def ttl(self, key: str) -> int:
        resp = await self._request("GET", self._path(key, "/ttl"))
        if resp.status_code == 404:
            return -2
        self._raise_for_error(resp)
        return resp.json()["ttl"]

    async def incr(self, key: str, amount: int = 1) -> int:
        resp = await self._request("POST", self._path(key, "/incr"), json={"amount": amount})
        self._raise_for_error(resp)
        return resp.json()["value"]

    async def delete_pattern(self, pattern: str) -> int:
        resp = await self._request("DELETE", "/keys", params={"pattern": pattern})
        self._raise_for_error(resp)
        return resp.json()["deleted"]
