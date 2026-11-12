"""AOF 영속화 테스트. 실행: (ai-framework 폴더에서) python -m pytest mini_redis/tests/test_persistence.py -v

tmp_path: pytest 가 테스트마다 새로 만들어 주는 빈 임시 폴더 → 진짜 data/ 폴더를 건드리지 않는다.
"""

import json
import logging
import os
import stat
import sys
import time

import httpx
import pytest

from mini_redis.core import persistence
from mini_redis.core.persistence import AOF, AOFCorruptError, AOFWriteError
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


def test_persist_after_ttl_survives_restart(aof_path, clock):
    # SET(10초 뒤 만료) → PERSIST 순서로 기록된 키는, 원래 만료 시각이 지난 뒤 재시작해도 살아 있어야 한다
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("k", "v", ttl=10)
    clock.advance(5)
    r.persist("k")
    r.aof.close()
    clock.advance(100)
    restored = restore(aof_path, clock)
    assert restored.get("k") == "v"
    assert restored.ttl("k") == -1


def test_expireat_extends_after_original_expiry(aof_path, clock):
    # SET(10초) → EXPIREAT(100초 뒤) 순서. 20초 뒤 재시작해도 늘린 만료 시각 기준으로 살아 있어야 한다
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("k", "v", ttl=10)
    r.expire("k", 100)
    r.aof.close()
    clock.advance(20)
    restored = restore(aof_path, clock)
    assert restored.get("k") == "v"
    assert restored.ttl("k") == 80


def test_invalid_expire_at_in_file_raises(aof_path, clock):
    write_file(aof_path, '{"cmd":"SET","args":["a",1,"내일"]}\n')
    with pytest.raises(AOFCorruptError):
        restore(aof_path, clock)


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


def test_everysec_flushes_by_itself(aof_path, clock):
    # 서버 앱 없이 직접 써도 AOF 자체 flush 스레드가 주기마다 디스크에 기록한다
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="everysec", flush_interval=0.05))
    r.set("a", 1)
    deadline = time.time() + 2
    while line_count(aof_path) == 0 and time.time() < deadline:
        time.sleep(0.01)
    assert line_count(aof_path) == 1           # flush() 를 부르지 않았는데도 기록됨
    r.aof.close()
    assert r.aof._flusher is None              # close 하면 스레드도 정리


def test_always_and_no_write_immediately(aof_path, clock):
    for policy in ("always", "no"):
        path = aof_path + "." + policy
        r = MiniRedis(clock=clock, aof=AOF(path, fsync=policy))
        r.set("a", 1)
        assert line_count(path) == 1               # flush 를 기다리지 않고 바로 파일에 보임
        r.aof.close()


# ===========================================================================
# 파일 권한 (다른 사용자가 AOF 내용을 읽지 못하게)
# ===========================================================================
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX 권한 비트는 Windows 에서 의미가 다름")


@posix_only
def test_new_aof_is_owner_only(aof_path, clock):
    old_umask = os.umask(0o022)                # 흔한 기본값: 새 파일이 644(모두 읽기 가능)가 되는 설정
    try:
        r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
        r.set("secret", "pw")
        r.aof.close()
    finally:
        os.umask(old_umask)
    assert stat.S_IMODE(os.stat(aof_path).st_mode) == 0o600


@posix_only
def test_rewrite_keeps_permissions(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    os.chmod(aof_path, 0o640)                  # 운영자가 일부러 바꿔 둔 권한
    r.aof.rewrite(r)
    assert stat.S_IMODE(os.stat(aof_path).st_mode) == 0o640
    r.aof.close()


@posix_only
def test_rewrite_new_file_is_owner_only(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path))
    r.set("a", 1)                              # everysec: 아직 파일이 없을 수도 있음 → rewrite 가 새로 만든다
    old_umask = os.umask(0o022)
    try:
        os.makedirs(os.path.dirname(aof_path), exist_ok=True)
        if os.path.exists(aof_path):
            os.remove(aof_path)
        r.aof.rewrite(r)
    finally:
        os.umask(old_umask)
    assert stat.S_IMODE(os.stat(aof_path).st_mode) == 0o600
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



# ===========================================================================
# 디스크 오류 (fail-stop)
# ===========================================================================
class BrokenFile:
    """write 는 받지만 flush 할 때 디스크 오류를 내는 가짜 파일."""

    def write(self, s):
        pass

    def flush(self):
        raise OSError(5, "Input/output error")

    def fileno(self):
        return -1

    def close(self):
        pass


def test_disk_error_rejects_later_writes(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    r.aof._file.close()
    r.aof._file = BrokenFile()
    with pytest.raises(AOFWriteError):
        r.set("b", 2)
    assert not r.exists("b")                       # 기록 실패 → 메모리에도 없음
    assert r.aof.failed
    with pytest.raises(AOFWriteError):
        r.set("c", 3)                              # 한 번 실패하면 이후 쓰기도 거절 (fail-stop)
    assert r.get("a") == 1                         # 읽기는 계속 가능
    r.aof.close()                                  # 실패 상태여도 close 는 예외 없이 정리


def test_everysec_flush_error_turns_into_fail_stop(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="everysec"))
    r.set("a", 1)
    r.aof._file.close()
    r.aof._file = BrokenFile()
    with pytest.raises(AOFWriteError):
        r.aof.flush()                              # 1초 flush 가 실패 → 응답했던 쓰기가 유실될 수 있음
    with pytest.raises(AOFWriteError):
        r.set("b", 2)
    r.aof.close()


# ===========================================================================
# 폴더 fsync
# ===========================================================================
def test_new_file_and_dirs_fsync_parent(tmp_path, clock, monkeypatch):
    synced = []
    monkeypatch.setattr(AOF, "_fsync_dir", staticmethod(lambda d: synced.append(os.path.abspath(d))))
    path = tmp_path / "a" / "b" / "appendonly.aof"
    r = MiniRedis(clock=clock, aof=AOF(str(path), fsync="always"))
    r.set("k", 1)
    # 새로 만든 폴더 a, b 의 이름이 기록된 부모(tmp_path, a)와, 새 파일이 들어간 b 를 fsync
    assert synced == [str(tmp_path), str(tmp_path / "a"), str(tmp_path / "a" / "b")]
    synced.clear()
    r.aof.close()
    r2 = MiniRedis(clock=clock, aof=AOF(str(path), fsync="always"))
    r2.set("k", 2)
    assert synced == []                            # 이미 있는 파일을 다시 열 때는 폴더 fsync 불필요
    r2.aof.close()


@posix_only
def test_dir_fsync_unsupported_is_ignored_but_io_error_raises(aof_path, clock, monkeypatch):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    real_fsync = os.fsync

    def fake_fsync(fd, err):
        import stat as st
        if st.S_ISDIR(os.fstat(fd).st_mode):       # 폴더에 대한 fsync 만 실패시킨다
            raise OSError(err, os.strerror(err))
        return real_fsync(fd)

    monkeypatch.setattr(persistence.os, "fsync", lambda fd: fake_fsync(fd, persistence.errno.EINVAL))
    assert r.aof.rewrite(r) == 1                   # 지원 안 함(EINVAL) → 무시하고 성공

    monkeypatch.setattr(persistence.os, "fsync", lambda fd: fake_fsync(fd, persistence.errno.EIO))
    with pytest.raises(AOFWriteError):
        r.aof.rewrite(r)                           # 진짜 I/O 오류 → 성공으로 보고하지 않음
    monkeypatch.setattr(persistence.os, "fsync", real_fsync)
    r.aof.close()


# ===========================================================================
# rewrite 임시 파일
# ===========================================================================
def test_rewrite_replaces_leftover_temp_file(aof_path, clock):
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    write_file(aof_path + ".rewrite.tmp", "지난번에 죽으면서 남긴 쓰레기\n")
    assert r.aof.rewrite(r) == 1
    r.aof.close()
    assert state(restore(aof_path, clock)) == [("a", 1, -1)]


@posix_only
def test_rewrite_does_not_follow_symlink(aof_path, clock, tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("건드리면 안 되는 파일", encoding="utf-8")
    r = MiniRedis(clock=clock, aof=AOF(aof_path, fsync="always"))
    r.set("a", 1)
    os.symlink(victim, aof_path + ".rewrite.tmp")  # 임시 파일 자리에 다른 파일을 가리키는 링크
    r.aof.rewrite(r)
    assert victim.read_text(encoding="utf-8") == "건드리면 안 되는 파일"   # 링크를 따라가 덮어쓰지 않음
    r.aof.close()



# ===========================================================================
# 거대한 만료 시각 / 심볼릭 링크 AOF 경로
# ===========================================================================
def test_huge_expire_at_in_file_is_corrupt_not_overflow(aof_path, clock):
    write_file(aof_path, '{"cmd":"SET","args":["a",1,%d]}\n{"cmd":"SET","args":["b",2]}\n' % (10**400))
    with pytest.raises(AOFCorruptError):    # OverflowError 로 시작이 죽지 않고, 어느 줄이 문제인지 알려준다
        restore(aof_path, clock)


@posix_only
def test_symlinked_aof_path_is_rejected(tmp_path, clock):
    target = tmp_path / "elsewhere.txt"
    target.write_text("다른 파일\n", encoding="utf-8")
    link = tmp_path / "appendonly.aof"
    os.symlink(target, link)
    aof = AOF(str(link), fsync="always")
    store = MiniRedis(clock=clock, aof=aof)
    with pytest.raises(persistence.AOFUnsafePathError):
        aof.replay(store)                    # 링크를 따라가 다른 파일로 복구하지 않음
    with pytest.raises(persistence.AOFUnsafePathError):
        store.set("k", "v")                  # 링크를 따라가 다른 파일에 기록하지 않음
    assert not store.exists("k")             # 기록 못 했으니 메모리에도 없음
    with pytest.raises(persistence.AOFUnsafePathError):
        aof.rewrite(store)
    assert target.read_text(encoding="utf-8") == "다른 파일\n"   # 대상 파일은 그대로
    assert os.path.islink(link)              # 링크도 바꿔치기되지 않음


@posix_only
def test_symlink_swapped_after_check_is_not_followed(tmp_path, clock, monkeypatch):
    # 검사를 통과한 직후 링크로 바뀌는 경우(경쟁 상태)도 O_NOFOLLOW 가 막는다
    target = tmp_path / "elsewhere.txt"
    target.write_text("원본\n", encoding="utf-8")
    link = tmp_path / "appendonly.aof"
    os.symlink(target, link)
    aof = AOF(str(link), fsync="always")
    monkeypatch.setattr(AOF, "_check_safe_path", lambda self: None)   # 검사를 건너뛴 것처럼
    with pytest.raises(AOFWriteError):
        MiniRedis(clock=clock, aof=aof).set("k", "v")
    assert target.read_text(encoding="utf-8") == "원본\n"
