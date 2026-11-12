"""HTTP API 기능 테스트. 실행: (ai-framework 폴더에서) mini_redis/.venv/bin/python -m pytest mini_redis/tests/test_api.py -v

httpx.AsyncClient + ASGITransport: 실제 서버(포트)를 띄우지 않고 FastAPI 앱을 메모리 안에서 직접 호출한다.
"""

import asyncio
from urllib.parse import quote

import httpx
import pytest

from mini_redis.client import AsyncMiniRedisClient, MiniRedisClient, MiniRedisError, MiniRedisUnavailable
from mini_redis.core.store import MiniRedis
from mini_redis.demo import cached_api, slow_api
from mini_redis.server.app import create_app
from mini_redis.server.routes import MAX_VALUE_BYTES, get_store
from mini_redis.server.thread_server import running_server
from mini_redis.tests.fakes import FakeClock

# 이 파일의 async 테스트를 anyio(asyncio) 이벤트 루프에서 실행하라는 표시
pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"  # trio 는 쓰지 않음


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def app(clock):
    # 테스트마다 가짜 시계를 넣은 새 저장소 + 새 앱 → 테스트끼리 데이터가 섞이지 않음
    return create_app(MiniRedis(clock=clock))


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    # async with: 블록이 끝나면 클라이언트를 자동으로 닫는다. yield 앞은 준비, 뒤는 정리 코드.
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def k(key: str) -> str:
    """키를 URL 경로에 넣을 수 있게 인코딩 (한글·공백·슬래시·? 등)."""
    return "/keys/" + quote(key, safe="")


def assert_error(resp, status: int, code: str):
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert body["error"] == code
    assert isinstance(body["message"], str) and body["message"]
    assert set(body) == {"error", "message"}  # 에러 응답 모양 통일


# ===========================================================================
# 정상 케이스
# ===========================================================================
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


async def test_put_and_get(client):
    r = await client.put(k("user:1"), json={"value": {"name": "kim", "age": 3}})
    assert r.status_code == 200
    assert r.json() == {"key": "user:1", "value": {"name": "kim", "age": 3}, "ttl": -1}

    r = await client.get(k("user:1"))
    assert r.status_code == 200
    assert r.json() == {"key": "user:1", "value": {"name": "kim", "age": 3}, "ttl": -1}


async def test_put_with_ttl_and_get_ttl(client, clock):
    r = await client.put(k("s"), json={"value": "v", "ttl": 10})
    assert r.json()["ttl"] == 10
    clock.advance(4)
    r = await client.get(k("s"))
    assert r.json()["ttl"] == 6
    r = await client.get(k("s") + "/ttl")
    assert r.status_code == 200 and r.json() == {"key": "s", "ttl": 6}


async def test_get_missing_404(client):
    assert_error(await client.get(k("nope")), 404, "KEY_NOT_FOUND")


async def test_delete(client):
    await client.put(k("a"), json={"value": 1})
    r = await client.delete(k("a"))
    assert r.status_code == 200 and r.json() == {"deleted": True}
    assert_error(await client.delete(k("a")), 404, "KEY_NOT_FOUND")


async def test_ttl_endpoint(client):
    assert_error(await client.get(k("nope") + "/ttl"), 404, "KEY_NOT_FOUND")
    await client.put(k("forever"), json={"value": 1})
    r = await client.get(k("forever") + "/ttl")
    assert r.json()["ttl"] == -1


async def test_expire_endpoint(client, clock):
    assert_error(await client.post(k("nope") + "/expire", json={"ttl": 5}), 404, "KEY_NOT_FOUND")
    await client.put(k("a"), json={"value": 1})
    r = await client.post(k("a") + "/expire", json={"ttl": 5})
    assert r.status_code == 200 and r.json() == {"key": "a", "ttl": 5}
    clock.advance(5)
    assert_error(await client.get(k("a")), 404, "KEY_NOT_FOUND")


async def test_persist_endpoint(client, clock):
    assert_error(await client.post(k("nope") + "/persist"), 404, "KEY_NOT_FOUND")
    await client.put(k("a"), json={"value": 1, "ttl": 5})
    r = await client.post(k("a") + "/persist")
    assert r.status_code == 200 and r.json() == {"key": "a", "persisted": True}
    r = await client.post(k("a") + "/persist")
    assert r.json() == {"key": "a", "persisted": False}  # 이미 만료 없음 (키는 있으니 404 아님)
    clock.advance(100)
    assert (await client.get(k("a"))).status_code == 200


async def test_incr_endpoint(client):
    r = await client.post(k("cnt") + "/incr")                     # 본문 생략 → amount=1
    assert r.status_code == 200 and r.json() == {"key": "cnt", "value": 1}
    r = await client.post(k("cnt") + "/incr", json={"amount": 10})
    assert r.json()["value"] == 11
    r = await client.post(k("cnt") + "/incr", json={"amount": -1})
    assert r.json()["value"] == 10


async def test_incr_non_integer_409(client):
    await client.put(k("s"), json={"value": "hello"})
    assert_error(await client.post(k("s") + "/incr"), 409, "NOT_INTEGER")


async def test_incr_amount_must_be_int(client):
    assert_error(await client.post(k("c") + "/incr", json={"amount": "1"}), 422, "VALIDATION_ERROR")
    assert_error(await client.post(k("c") + "/incr", json={"amount": 1.5}), 422, "VALIDATION_ERROR")


async def test_list_keys_with_pattern(client):
    for key in ["user:1", "user:2", "post:1"]:
        await client.put(k(key), json={"value": 1})
    r = await client.get("/keys")
    assert r.json() == {"keys": ["post:1", "user:1", "user:2"]}
    r = await client.get("/keys", params={"pattern": "user:*"})
    assert r.json() == {"keys": ["user:1", "user:2"]}


async def test_delete_by_pattern(client):
    for key in ["cache:a", "cache:b", "keep"]:
        await client.put(k(key), json={"value": 1})
    r = await client.delete("/keys", params={"pattern": "cache:*"})
    assert r.status_code == 200 and r.json() == {"deleted": 2}
    assert (await client.get("/keys")).json() == {"keys": ["keep"]}


async def test_delete_by_pattern_requires_pattern(client):
    assert_error(await client.delete("/keys"), 400, "PATTERN_REQUIRED")
    assert_error(await client.delete("/keys", params={"pattern": ""}), 400, "PATTERN_REQUIRED")


async def test_flush_and_stats(client):
    await client.put(k("a"), json={"value": 1})
    await client.get(k("a"))       # hit
    await client.get(k("zz"))      # miss
    s = (await client.get("/stats")).json()
    assert s["keys"] == 1 and s["hits"] == 1 and s["misses"] == 1
    r = await client.post("/flush")
    assert r.status_code == 200 and r.json() == {"flushed": True}
    assert (await client.get("/stats")).json()["keys"] == 0


async def test_dependency_override(app, client):
    # 의존성 주입 덕분에 엔드포인트 코드를 고치지 않고 저장소를 바꿔 끼울 수 있다
    other = MiniRedis()
    other.set("from-other", "yes")

    async def fake_store():
        return other

    app.dependency_overrides[get_store] = fake_store
    r = await client.get(k("from-other"))
    assert r.json()["value"] == "yes"
    app.dependency_overrides.clear()


# ===========================================================================
# 엣지 케이스
# ===========================================================================
async def test_empty_key_400(client):
    assert_error(await client.put("/keys/", json={"value": 1}), 400, "INVALID_KEY")
    assert_error(await client.get("/keys/"), 400, "INVALID_KEY")
    assert_error(await client.get("/keys//ttl"), 400, "INVALID_KEY")


async def test_key_length_limit(client):
    ok = "a" * 512
    assert (await client.put(k(ok), json={"value": 1})).status_code == 200
    assert_error(await client.put(k("a" * 513), json={"value": 1}), 400, "INVALID_KEY")


@pytest.mark.parametrize(
    "key",
    ["안녕", "🔥캐시", "hello world", "user:1:profile", "a/b/c", "a/../b", "50% off?", "#tag", " 앞뒤공백 "],
)
async def test_special_keys(client, key):
    r = await client.put(k(key), json={"value": key})
    assert r.status_code == 200, r.text
    assert r.json()["key"] == key
    r = await client.get(k(key))
    assert r.status_code == 200 and r.json()["value"] == key
    # 하위 경로도 같은 키로 동작
    assert (await client.post(k(key) + "/expire", json={"ttl": 100})).status_code == 200
    assert (await client.get(k(key) + "/ttl")).json() == {"key": key, "ttl": 100}
    assert (await client.delete(k(key))).status_code == 200


async def test_slash_key_without_encoding(client):
    # 인코딩 없이 그대로 보내도 {key:path} 덕분에 슬래시가 키에 포함된다
    await client.put("/keys/a/b", json={"value": 1})
    assert (await client.get("/keys/a/b")).json()["key"] == "a/b"
    assert (await client.get("/keys/a/b/ttl")).json() == {"key": "a/b", "ttl": -1}


@pytest.mark.parametrize("key", ["foo/ttl", "x/expire", "y/persist", "z/incr"])
async def test_reserved_suffix_rejected(client, key):
    assert_error(await client.put(k(key), json={"value": 1}), 400, "INVALID_KEY")


@pytest.mark.parametrize("ttl", [0, -1, "10", 1.5, True])
async def test_invalid_ttl_422(client, ttl):
    assert_error(await client.put(k("a"), json={"value": 1, "ttl": ttl}), 422, "VALIDATION_ERROR")
    await client.put(k("b"), json={"value": 1})
    assert_error(await client.post(k("b") + "/expire", json={"ttl": ttl}), 422, "VALIDATION_ERROR")


async def test_value_size_limit(client):
    # JSON 문자열은 따옴표 2개가 붙으므로 글자 수 = 1MB - 2 이면 정확히 1MB
    assert (await client.put(k("ok"), json={"value": "x" * (MAX_VALUE_BYTES - 2)})).status_code == 200
    assert_error(await client.put(k("big"), json={"value": "x" * MAX_VALUE_BYTES}), 413, "VALUE_TOO_LARGE")
    # 한글은 UTF-8 로 3바이트 → 글자 수가 아니라 바이트로 잰다
    assert_error(await client.put(k("big2"), json={"value": "가" * 400_000}), 413, "VALUE_TOO_LARGE")
    assert (await client.get(k("big"))).status_code == 404  # 거절된 값은 저장되지 않음


async def test_invalid_json_400(client):
    r = await client.put(k("a"), content=b'{"value": 1,,}', headers={"content-type": "application/json"})
    assert_error(r, 400, "INVALID_JSON")


async def test_missing_value_field_422(client):
    assert_error(await client.put(k("a"), json={"ttl": 5}), 422, "VALIDATION_ERROR")


async def test_null_value_is_not_404(client):
    r = await client.put(k("n"), json={"value": None})
    assert r.status_code == 200
    r = await client.get(k("n"))
    assert r.status_code == 200
    assert r.json() == {"key": "n", "value": None, "ttl": -1}


async def test_expired_key_get_404(client, clock):
    await client.put(k("t"), json={"value": 1, "ttl": 3})
    clock.advance(3)
    assert_error(await client.get(k("t")), 404, "KEY_NOT_FOUND")
    assert_error(await client.get(k("t") + "/ttl"), 404, "KEY_NOT_FOUND")


async def test_unknown_route_and_method(client):
    assert_error(await client.get("/nothing"), 404, "NOT_FOUND")
    assert_error(await client.post("/health"), 405, "METHOD_NOT_ALLOWED")


# ===========================================================================
# client.py (MiniRedisClient)
# 실제 uvicorn 서버를 백그라운드 스레드에서 띄워서 진짜 HTTP(소켓)로 통신해 본다.
# → URL 인코딩된 한글·슬래시 키가 실제 서버에서도 제대로 디코딩되는지까지 확인된다.
# ===========================================================================
@pytest.fixture
def server_url(app):
    with running_server(app) as url:
        yield url


@pytest.fixture
def redis_client(server_url):
    with MiniRedisClient(server_url) as c:
        yield c


def test_client_roundtrip(redis_client, clock):
    c = redis_client
    assert c.get("nope") is None                  # 404 → None
    c.set("user:1 이름/a", {"n": 1}, ttl=10)
    assert c.get("user:1 이름/a") == {"n": 1}
    assert c.ttl("user:1 이름/a") == 10
    assert c.ttl("nope") == -2
    assert c.expire("user:1 이름/a", 3) is True
    assert c.expire("nope", 3) is False
    assert c.incr("cnt") == 1
    assert c.incr("cnt", 5) == 6
    c.set("p:1", 1)
    c.set("p:2", 2)
    assert c.delete_pattern("p:*") == 2
    assert c.delete("cnt") is True
    assert c.delete("cnt") is False
    clock.advance(3)
    assert c.get("user:1 이름/a") is None


def test_client_error_mapping(redis_client):
    redis_client.set("s", "text")
    with pytest.raises(MiniRedisError) as e:
        redis_client.incr("s")
    assert e.value.status_code == 409 and e.value.error == "NOT_INTEGER"
    with pytest.raises(MiniRedisError) as e:
        redis_client.set("k", 1, ttl=0)
    assert e.value.status_code == 422


def test_client_unavailable():
    # 1번 포트는 열려 있지 않으므로 즉시 연결 거부 → MiniRedisUnavailable
    with MiniRedisClient("http://127.0.0.1:1", timeout=0.5) as c:
        with pytest.raises(MiniRedisUnavailable):
            c.get("a")
        with pytest.raises(MiniRedisError):  # MiniRedisError 의 자식이라 한 번에 잡을 수도 있다
            c.set("a", 1)


# ===========================================================================
# 데모 흐름 기능 테스트: Cache-Aside (cached_api → Mini Redis / slow_api)
# 세 앱을 모두 ASGITransport 로 메모리 안에서 연결한다 (포트 불필요, slow_api 지연 0초).
# ===========================================================================
@pytest.fixture
async def demo(app):
    origin_app = slow_api.create_app(delay=0)
    redis_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://redis")
    origin_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=origin_app), base_url="http://origin")
    cached_app = cached_api.create_app(cache=AsyncMiniRedisClient(http_client=redis_http), origin=origin_http)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=cached_app), base_url="http://cached") as c:
        yield c, origin_app
    await redis_http.aclose()
    await origin_http.aclose()


async def test_demo_miss_hit_invalidate(demo, client):
    c, origin_app = demo
    r1 = await c.get("/products/7")
    assert r1.status_code == 200 and r1.headers["X-Cache"] == "MISS"     # 첫 요청: 원본에서 가져옴
    assert r1.json()["name"] == "상품 7"

    r2 = await c.get("/products/7")
    assert r2.headers["X-Cache"] == "HIT"                                  # 두 번째: 캐시에서
    assert r2.json() == r1.json()                                          # served_at 까지 같음 = 원본을 다시 안 부름
    assert origin_app.state.calls == 1

    ttl = (await client.get("/keys/product:7/ttl")).json()["ttl"]
    assert ttl == 60                                                       # TTL 60초로 저장됨

    r3 = await c.put("/products/7", json={"price": 99})
    assert r3.status_code == 200 and r3.headers["X-Cache-Invalidated"] == "true"
    assert (await client.get("/keys/product:7")).status_code == 404        # 캐시 키가 지워짐

    r4 = await c.get("/products/7")
    assert r4.headers["X-Cache"] == "MISS"                                 # 무효화 후 다시 MISS
    assert r4.json()["price"] == 99 and r4.json()["version"] == 2          # 수정된 최신 값
    assert (await c.get("/products/7")).headers["X-Cache"] == "HIT"


async def test_demo_bypass_when_cache_down():
    origin_app = slow_api.create_app(delay=0)
    origin_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=origin_app), base_url="http://origin")
    dead_cache = AsyncMiniRedisClient("http://127.0.0.1:1", timeout=0.5)  # 아무도 없는 포트 = 캐시 서버 다운
    cached_app = cached_api.create_app(cache=dead_cache, origin=origin_http)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=cached_app), base_url="http://cached") as c:
        r = await c.get("/products/3")
        assert r.status_code == 200 and r.headers["X-Cache"] == "BYPASS"   # 캐시가 죽어도 서비스는 응답
        assert r.json()["id"] == 3
        r = await c.put("/products/3", json={"name": "새 이름"})
        assert r.status_code == 200 and r.headers["X-Cache-Invalidated"] == "false"
    await origin_http.aclose()
    await dead_cache.aclose()


async def test_demo_unknown_product_not_cached(demo, client):
    c, _ = demo
    r = await c.get("/products/5000")
    assert r.status_code == 404
    assert (await client.get("/keys/product:5000")).status_code == 404     # 에러 응답은 캐시하지 않음


async def test_demo_stale_get_does_not_survive_put(app, client):
    # 경합 재현: 캐시 미스 GET 이 원본에서 v1 을 읽고 느리게(0.2초) 돌아오는 사이,
    # PUT 이 원본을 v2 로 고치고 캐시를 지운다. Lock 이 없으면 GET 이 뒤늦게 v1 을 저장해 60초간 옛 값이 남는다.
    origin_app = slow_api.create_app(delay=0.2, write_delay=0)
    redis_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://redis")
    origin_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=origin_app), base_url="http://origin")
    cached_app = cached_api.create_app(cache=AsyncMiniRedisClient(http_client=redis_http), origin=origin_http)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=cached_app), base_url="http://cached") as c:
        calls_before = origin_app.state.calls
        get_task = asyncio.create_task(c.get("/products/9"))   # v1 을 읽는 중인 GET
        # 고정 시간 대신 "GET 이 원본에 도착해 v1 을 읽었다" 는 사실을 기다린다 (느린 컴퓨터에서도 안정적)
        deadline = asyncio.get_running_loop().time() + 2
        while origin_app.state.calls == calls_before:
            assert asyncio.get_running_loop().time() < deadline, "GET 이 2초 안에 원본에 도착하지 않음"
            await asyncio.sleep(0.001)
        put = await c.put("/products/9", json={"price": 1})    # Lock 때문에 GET 이 끝날 때까지 기다린다
        assert put.status_code == 200 and put.json()["version"] == 2
        assert (await get_task).json()["version"] == 1          # GET 은 수정 전 값을 받았지만
        after = await c.get("/products/9")
        assert after.json()["version"] == 2                     # 캐시에는 옛 값이 남지 않았다
        assert after.json()["price"] == 1
    await redis_http.aclose()
    await origin_http.aclose()


async def test_demo_concurrent_misses_call_origin_once(app):
    origin_app = slow_api.create_app(delay=0.1)
    redis_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://redis")
    origin_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=origin_app), base_url="http://origin")
    cached_app = cached_api.create_app(cache=AsyncMiniRedisClient(http_client=redis_http), origin=origin_http)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=cached_app), base_url="http://cached") as c:
        responses = await asyncio.gather(*(c.get("/products/4") for _ in range(10)))
    assert all(r.status_code == 200 for r in responses)
    assert origin_app.state.calls == 1                          # cache stampede 없음: 원본은 한 번만
    assert sorted(r.headers["X-Cache"] for r in responses) == ["HIT"] * 9 + ["MISS"]
    await redis_http.aclose()
    await origin_http.aclose()


async def test_cached_api_closes_only_clients_it_created():
    injected_cache = AsyncMiniRedisClient("http://127.0.0.1:1")
    cached_app = cached_api.create_app(cache=injected_cache)    # origin 은 앱이 직접 만든다
    async with cached_app.router.lifespan_context(cached_app):
        pass
    assert cached_app.state.origin.is_closed                    # 직접 만든 클라이언트는 닫고
    assert not injected_cache._http.is_closed                   # 주입받은 클라이언트는 그대로 둔다
    await injected_cache.aclose()

    injected_origin = httpx.AsyncClient(base_url="http://127.0.0.1:1")
    cached_app = cached_api.create_app(origin=injected_origin)  # 반대로 cache 만 직접 만든다
    async with cached_app.router.lifespan_context(cached_app):
        pass
    assert cached_app.state.cache._http.is_closed
    assert not injected_origin.is_closed
    await injected_origin.aclose()


def test_running_server_cleans_up_on_startup_timeout(app):
    import threading
    import time

    before = threading.active_count()
    with pytest.raises(RuntimeError):
        with running_server(app, startup_timeout=0):   # 시작을 기다리지 못하고 바로 시간 초과
            pass
    deadline = time.time() + 5
    while threading.active_count() > before and time.time() < deadline:
        time.sleep(0.01)
    assert threading.active_count() == before          # 뒤늦게 시작한 서버 스레드까지 정리됨


async def test_demo_product_locks_are_reclaimed(app):
    origin_app = slow_api.create_app(delay=0)
    redis_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://redis")
    origin_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=origin_app), base_url="http://origin")
    cached_app = cached_api.create_app(cache=AsyncMiniRedisClient(http_client=redis_http), origin=origin_http)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=cached_app), base_url="http://cached") as c:
        # 존재하지 않는 id 를 많이 요청해도 Lock 이 쌓이지 않아야 한다
        await asyncio.gather(*(c.get(f"/products/{10_000 + i}") for i in range(50)))
        await asyncio.gather(*(c.get("/products/1") for _ in range(5)), c.put("/products/1", json={"price": 5}))
    assert len(cached_app.state.locks) == 0      # 모든 요청이 끝나면 Lock 회수
    await redis_http.aclose()
    await origin_http.aclose()


async def test_write_returns_503_when_aof_fails(tmp_path):
    from mini_redis.core.persistence import AOF

    aof = AOF(str(tmp_path / "a.aof"), fsync="always")
    store = MiniRedis(aof=aof)
    fail_app = create_app(store, active_expire=False)
    aof._error = OSError(28, "No space left on device")   # 디스크 가득 참 상태를 흉내
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=fail_app), base_url="http://test") as c:
        r = await c.put("/keys/a", json={"value": 1})
        assert r.status_code == 503 and r.json()["error"] == "PERSISTENCE_FAILED"
        assert (await c.get("/keys/a")).status_code == 404   # 기록 못 한 쓰기는 메모리에도 없음
        assert (await c.get("/health")).status_code == 200    # 읽기·상태 확인은 계속 가능



@pytest.mark.parametrize("ttl", [10**30, 10**400])
async def test_huge_ttl_422_not_500(client, ttl):
    # JSON 에는 정수 크기 제한이 없다. 거대한 TTL 이 500 이 아니라 검증 에러로 끝나야 한다
    body = '{"value": 1, "ttl": %d}' % ttl
    r = await client.put(k("a"), content=body, headers={"content-type": "application/json"})
    assert r.status_code in (400, 422), r.text
    assert set(r.json()) == {"error", "message"}
    await client.put(k("b"), json={"value": 1})
    r = await client.post(k("b") + "/expire", content='{"ttl": %d}' % ttl, headers={"content-type": "application/json"})
    assert r.status_code in (400, 422), r.text
