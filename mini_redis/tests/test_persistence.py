"""AOF 영속화 테스트. 실행: (ai-framework 폴더에서) python -m pytest mini_redis/tests/test_persistence.py -v

tmp_path: pytest 가 테스트마다 새로 만들어 주는 빈 임시 폴더 → 진짜 data/ 폴더를 건드리지 않는다.
"""

import json
import logging
import os

import httpx
import pytest

from mini_redis.core.persistence import AOF, AOFCorruptError
from mini_redis.core.store import MiniRedis
from mini_redis.server.app import create_app
from mini_redis.tests.fakes import FakeClock


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def aof_path(tmp_path):
    return str(tmp_path / "data" / "appendonly.aof")  # data/ 폴더가 없어도 AOF 가 만들어야 함


def state(store: MiniRedis) -> list:
    """비교하기 쉽게 저장소 상태를 [(key, value, ttl), ...] 정렬 리스트로."""
    return sorted((k, store.get(k), store.ttl(k)) for k in store.keys())


def write_file(path: str, text: str) -> None:
    """AOF 파일을 직접 만든다 (손상된 파일 흉내용). 폴더가 없으면 먼저 만든다."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def line_count(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def restore(path: str, clock) -> MiniRedis:
    """서버 재시작 흉내: 새 저장소를 만들고 AOF 를 다시 실행."""
    store = MiniRedis(clock=clock, aof=AOF(path))
    store.aof.replay(store)
    return store


# ===========================================================================
# 기록 → 복구
# ===========================================================================
def test_replay_restores_same_state(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("user:1", {"name": "김", "tags": ["a", "b"]})
    r.set("user:2", "bye")
    r.set("temp", 1, ttl=100)
    r.set("null", None)
    r.set("이모지🔥", "값")
    r.delete("user:2")
    r.expire("user:1", 50)
    r.incr("counter")
    r.incr("counter", 9)
    r.set("will_persist", 1, ttl=10)
    r.persist("will_persist")
    r.set("cache:a", 1)
    r.set("cache:b", 1)
    r.delete_pattern("cache:*")
    expected = state(r)
    r.aof.close()

    restored = restore(aof_path, clock)
    assert state(restored) == expected
    assert restored.get("null", "없음") is None  # None 값도 그대로 복구
    assert restored.get("counter") == 10


def test_flushall_replay(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    r.flush_all()
    r.set("b", 2)
    r.aof.close()
    assert state(restore(aof_path, clock)) == [("b", 2, -1)]


def test_file_format_is_json_lines(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("한글", "값", ttl=10)
    r.aof.close()
    with open(aof_path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    assert lines == ['{"cmd":"SET","args":["한글","값",%s]}' % json.dumps(clock.now + 10)]


def test_replay_does_not_append_again(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    for i in range(10):
        r.set(f"k{i}", i)
    r.aof.close()
    before = line_count(aof_path)
    restored = restore(aof_path, clock)
    restored.aof.close()
    assert line_count(aof_path) == before        # 복구하면서 같은 줄이 또 쌓이지 않음


def test_replay_missing_file_is_empty(aof_path, clock):
    store = MiniRedis(clock=clock, aof=AOF(aof_path))
    assert store.aof.replay(store) == 0
    assert store.keys() == []


# ===========================================================================
# TTL 은 절대 시각 기준
# ===========================================================================
def test_ttl_uses_absolute_time_after_restart(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("session", "s", ttl=100)
    r.set("short", "x", ttl=10)
    r.set("k", "v")
    r.expire("k", 60)
    r.aof.close()

    clock.advance(30)                             # 서버가 30초 동안 꺼져 있었다고 가정
    restored = restore(aof_path, clock)
    assert restored.ttl("session") == 70          # 100 으로 되돌아가지 않고 남은 70초
    assert restored.ttl("k") == 30
    # 꺼져 있는 동안 만료된 키는 복구 단계에서 바로 버려진다 (조회 전에도 내부에 없음)
    assert not restored._data.contains("short")
    assert restored.ttl("short") == -2


def test_incr_on_key_with_ttl_keeps_absolute_expiry(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("c", 1, ttl=10)
    clock.advance(5)
    r.incr("c")
    r.aof.close()
    clock.advance(6)                              # 원래 만료 시각(10초)을 지남
    assert restore(aof_path, clock).get("c") is None


# ===========================================================================
# 손상된 파일
# ===========================================================================
def test_truncated_last_line_is_skipped(aof_path, clock, caplog):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    r.set("b", 2)
    r.aof.close()
    with open(aof_path, "a", encoding="utf-8") as f:
        f.write('{"cmd":"SET","args":["c",')        # 기록 도중 서버가 죽은 것처럼 잘린 줄

    with caplog.at_level(logging.WARNING, logger="mini_redis.aof"):
        restored = restore(aof_path, clock)
    assert state(restored) == [("a", 1, -1), ("b", 2, -1)]
    assert "손상" in caplog.text                  # 경고가 남음

    # 잘린 꼬리를 정리했으므로, 이어서 기록하고 다시 복구해도 문제없다
    restored.set("d", 4)
    restored.aof.close()
    again = restore(aof_path, clock)
    assert state(again) == [("a", 1, -1), ("b", 2, -1), ("d", 4, -1)]


def test_last_line_without_newline_is_kept(aof_path, clock):
    write_file(aof_path, '{"cmd":"SET","args":["a",1]}')  # 완전한 JSON 이지만 줄바꿈만 없음
    restored = restore(aof_path, clock)
    assert restored.get("a") == 1
    restored.set("b", 2)                           # 같은 줄에 붙으면 안 됨
    restored.aof.close()
    assert state(restore(aof_path, clock)) == [("a", 1, -1), ("b", 2, -1)]


def test_corrupted_middle_line_raises(aof_path, clock):
    write_file(
        aof_path,
        '{"cmd":"SET","args":["a",1]}\n'
        '{"cmd":"SET","ar\n'                        # 중간 줄 손상
        '{"cmd":"SET","args":["b",2]}\n',
    )
    with pytest.raises(AOFCorruptError, match="2번째 줄"):
        restore(aof_path, clock)


def test_unknown_command_raises(aof_path, clock):
    write_file(aof_path, '{"cmd":"HACK","args":[]}\n')
    with pytest.raises(AOFCorruptError):
        restore(aof_path, clock)


# ===========================================================================
# fsync 정책
# ===========================================================================
def test_everysec_buffers_until_flush(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="everysec"))
    r.set("a", 1)
    with open(aof_path, encoding="utf-8") as f:
        assert f.read() == ""                      # 아직 메모리 버퍼에만 있음
    r.aof.flush()                                  # 1초 주기 태스크가 하는 일
    with open(aof_path, encoding="utf-8") as f:
        assert f.read().strip() == '{"cmd":"SET","args":["a",1]}'


def test_always_and_no_write_immediately(aof_path, clock):
    for policy in ("always", "no"):
        path = aof_path + "." + policy
        r = MiniRedis(clock=clock, aof=AOF(path, fsync=policy))
        r.set("a", 1)
        assert line_count(path) == 1               # flush 를 기다리지 않고 바로 파일에 보임
        r.aof.close()


def test_invalid_fsync_policy():
    with pytest.raises(ValueError):
        AOF("x.aof", fsync="sometimes")


# ===========================================================================
# rewrite
# ===========================================================================
def test_rewrite_shrinks_file_and_keeps_state(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    for _ in range(100):
        r.incr("counter")                          # 100줄
    for i in range(50):
        r.set(f"tmp:{i}", i)
    r.delete_pattern("tmp:*")                      # +50줄 +50줄, 결과는 0개
    r.set("session", "s", ttl=100)
    r.set("gone", "x", ttl=5)
    clock.advance(10)                              # gone 은 만료
    expected = state(r)
    before = line_count(aof_path)

    written = r.aof.rewrite(r)
    after = line_count(aof_path)
    assert written == 2                            # counter, session 만 남음
    assert after == 2 and before > 200

    r.set("after", "rewrite")                      # 교체 후에도 새 파일에 이어서 기록
    r.aof.close()
    restored = restore(aof_path, clock)
    assert state(restored) == sorted(expected + [("after", "rewrite", -1)])
    assert restored.ttl("session") == 90           # 만료 시각도 절대 시각 그대로 보존


def test_rewrite_leaves_no_temp_file(aof_path, clock, tmp_path):
    r = MiniRedis(clock=clock, aof=AOF(aof_path))
    r.set("a", 1)
    r.aof.rewrite(r)
    files = sorted(p.name for p in (tmp_path / "data").iterdir())
    assert files == ["appendonly.aof"]


# ===========================================================================
# app 연결: 시작 시 replay → 요청 수신, 종료 시 flush
# ===========================================================================
@pytest.mark.anyio
async def test_app_replays_on_startup_and_flushes_on_shutdown(aof_path):
    write_file(aof_path, '{"cmd":"SET","args":["restored","yes"]}\n')  # 이전 실행에서 남은 AOF

    app = create_app(MiniRedis(aof=AOF(aof_path, fsync="everysec")), active_expire=False)
    transport = httpx.ASGITransport(app=app)
    # lifespan_context: uvicorn 이 서버 시작/종료 때 하는 일을 직접 실행 (ASGITransport 는 lifespan 을 안 돌려줌)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.get("/keys/restored")
            assert r.status_code == 200 and r.json()["value"] == "yes"   # 요청 전에 복구가 끝나 있음
            await c.put("/keys/new", json={"value": 1})
            # everysec: 아직 1초가 안 지났으므로 파일에는 없을 수 있다
        # ← 여기서 lifespan 종료 → aof.close() 로 버퍼가 디스크에 기록됨
    assert line_count(aof_path) == 2

    restored = MiniRedis(aof=AOF(aof_path))
    restored.aof.replay(restored)
    assert restored.get("new") == 1


@pytest.mark.anyio
async def test_admin_rewrite_endpoint(aof_path):
    app = create_app(MiniRedis(aof=AOF(aof_path, fsync="always")), active_expire=False)
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            for _ in range(20):
                await c.post("/keys/cnt/incr")
            assert line_count(aof_path) == 20
            r = await c.post("/admin/rewrite-aof")
            assert r.status_code == 200 and r.json() == {"rewritten": True, "commands": 1}
            assert line_count(aof_path) == 1


@pytest.mark.anyio
async def test_admin_rewrite_without_aof_409():
    app = create_app(MiniRedis(), active_expire=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/admin/rewrite-aof")
        assert r.status_code == 409 and r.json()["error"] == "AOF_DISABLED"
