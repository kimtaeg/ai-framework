/**
 * 2주차 — 코드 리뷰에서 나온 작은 문제 5가지의 회귀 테스트
 *   Redis : GET + TTL 을 한 번에(GETTTL) · getOrLoad 의 undefined · 메모리 상한보다 큰 값
 *   DBMS  : LIMIT ? · autoIndex 의 열 선택과 인덱스 수 상한
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MiniRedis } from '../mini_redis/miniredis.js';
import { startRedisServer } from '../mini_redis/server.js';
import { MiniRedisClient } from '../mini_redis/client.js';
import { Database } from '../mini_DBMS/engine.js';
import { MemoryStorage } from '../mini_DBMS/storage.js';
import { parse } from '../mini_DBMS/sql.js';

describe('GET + TTL 을 한 번에 (GETTTL)', () => {
  test('GETTTL: 값과 남은 초를 함께, 통계는 한 번만', () => {
    let now = 0;
    const r = new MiniRedis({ now: () => now });
    r.command(['SET', 'a', 'v', 'PX', '2500']);
    r.command(['SET', 'b', 'w']);
    const before = r.stats.commands;
    assert.deepEqual(r.command(['GETTTL', 'a']), ['v', 3]);
    assert.deepEqual(r.command(['GETTTL', 'b']), ['w', -1]);
    assert.equal(r.command(['GETTTL', 'none']), null);
    assert.equal(r.stats.commands - before, 3);
    assert.equal(r.stats.hits, 2);
    assert.equal(r.stats.misses, 1);
    now = 2500;
    assert.equal(r.command(['GETTTL', 'a']), null, '만료된 키');
  });

  test('HTTP GET /keys/:key 는 명령 하나로 답한다 (예전에는 GET, TTL 두 번)', async () => {
    const s = await startRedisServer({ port: 0, aofPath: null });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      await fetch(`${base}/keys/k`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'v', ttl: 60 }) });
      const before = { ...s.redis.stats };
      const body = await (await fetch(`${base}/keys/k`)).json();
      assert.deepEqual(body, { key: 'k', value: 'v', ttl: 60 });
      assert.equal(s.redis.stats.commands - before.commands, 1);
      assert.equal(s.redis.stats.hits - before.hits, 1);
      assert.equal((await fetch(`${base}/keys/none`)).status, 404);
    } finally {
      await s.close();
    }
  });
});

describe('getOrLoad 의 undefined', () => {
  test('loader 가 undefined 를 돌려줘도 오류 없이 null 로 캐시한다', async () => {
    const s = await startRedisServer({ port: 0, aofPath: null });
    const c = new MiniRedisClient(`http://127.0.0.1:${s.port}`);
    try {
      let calls = 0;
      const loader = async () => { calls++; };
      assert.deepEqual(await c.getOrLoad('u', loader), { value: null, hit: false });
      assert.deepEqual(await c.getOrLoad('u', loader), { value: null, hit: true });
      assert.equal(calls, 1);
      assert.deepEqual(await c.getOrLoad('u2', loader, { lockMs: 1000 }), { value: null, hit: false });
      assert.equal(await c.get('u2'), 'null');
    } finally {
      await s.close();
    }
  });
});

describe('메모리 상한보다 큰 값', () => {
  test('넣기 전에 거부하고, 다른 키는 그대로 남는다 (예전에는 전부 축출됐다)', () => {
    const log = [];
    const r = new MiniRedis({ maxMemory: 1000, onWrite: (a) => log.push(a) });
    r.command(['SET', 'a', '1']);
    r.command(['SET', 'b', '2']);
    log.length = 0;
    assert.throws(() => r.command(['SET', 'big', 'x'.repeat(600)]), /값이 너무 큽니다/);
    assert.throws(() => r.command(['SET', 'a', 'x'.repeat(600)]), /값이 너무 큽니다/);
    assert.throws(() => r.command(['MSET', 'c', '3', 'big', 'x'.repeat(600)]), /값이 너무 큽니다/);
    assert.deepEqual(r.command(['MGET', 'a', 'b', 'c', 'big']), ['1', '2', null, null]);
    assert.equal(r.evicted, 0);
    assert.deepEqual(log, []);
    // 상한 안의 값은 평소대로
    assert.equal(r.command(['SET', 'ok', 'x'.repeat(100)]), 'OK');
    // 상한이 없으면 검사하지 않는다
    assert.equal(new MiniRedis().command(['SET', 'big', 'x'.repeat(100000)]), 'OK');
  });
});

describe('LIMIT ?', () => {
  const SCHEMA = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
  test('LIMIT 자리에도 params 를 쓸 수 있다', () => {
    const db = new Database(new MemoryStorage(SCHEMA));
    db.execute("INSERT INTO users (name, age, email) VALUES ('a', 1, 'a'), ('b', 2, 'b'), ('c', 3, 'c')");
    assert.deepEqual(db.execute('SELECT id FROM users WHERE id >= ? LIMIT ?', [2, 1])[0].rows, [[2]]);
    assert.deepEqual(db.execute('SELECT id FROM users LIMIT ?', [0])[0].rows, []);
    assert.deepEqual(db.execute('SELECT id FROM users LIMIT 2')[0].rows, [[1], [2]]);
    for (const bad of [-1, 1.5, 'x', null]) assert.throws(() => db.execute('SELECT id FROM users LIMIT ?', [bad]), /LIMIT 은 0 이상의 정수/);
    assert.throws(() => parse('SELECT id FROM users LIMIT ?'), /params/);
  });
});

describe('autoIndex 의 열 선택과 인덱스 수 상한', () => {
  const wide = { t: { columns: ['id', 'grp', 'email', 'c1', 'c2', 'c3', 'c4'].map((name) => ({ name, type: name === 'id' ? 'INT' : 'TEXT' })) } };
  const make = (autoIndex) => {
    const db = new Database(new MemoryStorage(wide), { autoIndex });
    const rows = Array.from({ length: 600 }, (_, i) => `('g${i % 3}', 'e${i}', 'x${i % 5}', 'y${i % 7}', 'z${i % 11}', 'w${i % 13}')`).join(',');
    db.execute(`INSERT INTO t (grp, email, c1, c2, c3, c4) VALUES ${rows}`);
    return db;
  };
  const q = "SELECT id FROM t WHERE grp = 'g1' AND email = 'e100'";

  test('조건이 여러 열이면 가장 적게 걸리는 열의 인덱스를 쓴다', () => {
    const auto = make(true), plain = make(false);
    // grp 는 200줄씩 걸리고 email 은 한 줄 → 조건 순서와 상관없이 email 인덱스를 쓴다
    const first = auto.execute(q)[0];
    assert.deepEqual(first.rows, [[101]]);
    assert.equal(first.plan.column, 'email');
    assert.equal(first.plan.scanned, 1);
    const again = auto.execute(q)[0];
    assert.equal(again.plan.column, 'email');
    assert.equal(again.plan.built, undefined, '두 번째부터는 새로 만들지 않는다');
    assert.match(again.plan.reason, /email/);
    // 걸리는 줄이 적은 열이 먼저 오면 다른 인덱스를 만들지 않는다
    const db2 = make(true);
    assert.equal(db2.execute("SELECT id FROM t WHERE email = 'e5' AND grp = 'g2'")[0].plan.column, 'email');
    assert.deepEqual([...db2.tables.t.secondary.keys()], [2]);
    // 여러 조합에서 선형 탐색과 결과가 같다
    for (const sql of [q, "SELECT id FROM t WHERE grp = 'g0' AND c1 = 'x0'", "SELECT id FROM t WHERE c2 = 'y3' AND c3 = 'z4' AND c4 = 'w5'", "SELECT id FROM t WHERE grp = 'g2' LIMIT 7", "SELECT id FROM t WHERE email = 'nope' AND grp = 'g1'"]) {
      assert.deepEqual(auto.execute(sql)[0].rows, plain.execute(sql)[0].rows, sql);
    }
  });

  test('열마다 한 번씩 조회해도 인덱스는 4개까지만 두고, 버렸다 다시 만들어도 결과가 맞다', () => {
    const auto = make(true);
    for (const col of ['grp', 'email', 'c1', 'c2', 'c3', 'c4']) auto.execute(`SELECT id FROM t WHERE ${col} = 'zzz'`);
    assert.equal(auto.tables.t.secondary.size, 4);
    assert.deepEqual(auto.execute(q)[0].rows, [[101]]);
    auto.execute("INSERT INTO t (grp, email, c1, c2, c3, c4) VALUES ('g9', 'new', 'a', 'b', 'c', 'd')");
    assert.deepEqual(auto.execute("SELECT id FROM t WHERE grp = 'g9'")[0].rows, [[601]]);
    assert.deepEqual(auto.execute("SELECT id FROM t WHERE email = 'new'")[0].rows, [[601]]);
    assert.ok(auto.tables.t.secondary.size <= 4);
  });
});
