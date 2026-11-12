/**
 * 2주차 성능 개선의 회귀 테스트
 *   - 미니 DBMS: 버퍼 풀 (한 줄 읽기를 8KB 페이지 캐시로)
 *   - 미니 레디스: 캐시 스탬피드 방어 (같은 키를 동시에 놓쳐도 DB 조회는 한 번)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { Database } from '../week2/dbms/engine.js';
import { seedRows } from '../week2/dbms/seed.js';
import { MiniRedisClient, createSingleFlight } from '../week2/redis/client.js';
import { LocalCache } from '../week2/redis/demo-api.js';
import { startRedisServer } from '../week2/redis/server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'minidb-perf-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = (db, sql) => db.execute(sql)[0];

describe('미니 DBMS 버퍼 풀', () => {
  test('풀을 켜도 끈 것과 모든 행이 같게 읽힌다 (페이지 경계에 걸친 줄 포함)', () => {
    const dir = tmp();
    const a = new FileStorage(dir);
    const dbA = new Database(a);
    seedRows(dbA, 'products', 3000); // 8KB 페이지 여러 장 → 경계에 걸친 줄이 생긴다
    a.close();
    const on = new FileStorage(dir);
    const off = new FileStorage(dir, { poolPages: 0 });
    const dbOn = new Database(on), dbOff = new Database(off);
    for (let id = 1; id <= 3000; id++) {
      assert.deepEqual(one(dbOn, `SELECT * FROM products WHERE id = ${id}`).rows, one(dbOff, `SELECT * FROM products WHERE id = ${id}`).rows, `id ${id}`);
    }
    assert.ok(on.pool.hits > on.pool.misses, `대부분 메모리에서: hits ${on.pool.hits}, misses ${on.pool.misses}`);
    assert.equal(off.pool.hits + off.pool.misses, 0, '끄면 풀을 거치지 않는다');
    on.close(); off.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('같은 페이지를 다시 읽으면 디스크에 가지 않는다 (hit), 가득 차면 오래된 페이지를 버린다 (LRU)', () => {
    const dir = tmp();
    const s0 = new FileStorage(dir);
    seedRows(new Database(s0), 'products', 3000);
    s0.close();
    const s = new FileStorage(dir, { poolPages: 2 });
    const db = new Database(s);
    one(db, 'SELECT * FROM products WHERE id = 1');
    assert.deepEqual(s.pool, { hits: 0, misses: 1, evictions: 0 });
    one(db, 'SELECT * FROM products WHERE id = 2');
    assert.deepEqual(s.pool, { hits: 1, misses: 1, evictions: 0 });
    one(db, 'SELECT * FROM products WHERE id = 1000');
    one(db, 'SELECT * FROM products WHERE id = 2000'); // 세 번째 페이지 → 가장 오래 안 쓴 첫 페이지를 버린다
    assert.equal(s.pool.evictions, 1);
    const before = s.pool.misses;
    one(db, 'SELECT * FROM products WHERE id = 1'); // 버려졌으므로 다시 디스크에서
    assert.equal(s.pool.misses, before + 1);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('실패한 요청을 되돌린 뒤 같은 자리에 쓰인 새 행을 정확히 읽는다 (낡은 페이지를 읽지 않음)', () => {
    const dir = tmp();
    const s = new FileStorage(dir);
    const db = new Database(s);
    seedRows(db, 'users', 2000);
    for (let id = 1; id <= 2000; id += 7) one(db, `SELECT * FROM users WHERE id = ${id}`); // 풀을 채운다
    // 앞 문장은 400행을 넣고(여러 페이지), 뒤 문장이 실패 → 모두 되돌린다
    const many = Array.from({ length: 400 }, (_, i) => `('rolled-back-${i}', 1, 'x@x.io')`).join(',');
    assert.throws(() => db.execute(`INSERT INTO users (name, age, email) VALUES ${many}; SELECT * FROM nope`));
    const fresh = Array.from({ length: 400 }, (_, i) => `('fresh-${i}', 2, 'y@y.io')`).join(',');
    const ids = one(db, `INSERT INTO users (name, age, email) VALUES ${fresh}`).ids;
    assert.equal(ids[0], 2001, '되돌린 id 를 다시 쓴다');
    ids.forEach((id, i) => assert.equal(one(db, `SELECT name FROM users WHERE id = ${id}`).rows[0][0], `fresh-${i}`));
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('다른 인스턴스(워커)가 되돌리고 다시 쓴 자리도 낡은 내용을 읽지 않는다', () => {
    const dir = tmp();
    const seed = new FileStorage(dir);
    seedRows(new Database(seed), 'users', 1000);
    seed.close();
    const sa = new FileStorage(dir, { repair: false }), sb = new FileStorage(dir, { repair: false });
    const a = new Database(sa), b = new Database(sb);
    const values = (tag, n) => Array.from({ length: n }, (_, i) => `('${tag}-${i}', 1, 'x@x.io')`).join(',');
    // 워커 A 가 넣고 → B 에 알림 → B 가 읽어 풀에 담는다
    const r1 = one(a, `INSERT INTO users (name, age, email) VALUES ${values('first', 600)}`);
    b.applyIndex('users', r1.entries);
    for (const id of r1.ids) assert.match(one(b, `SELECT name FROM users WHERE id = ${id}`).rows[0][0], /^first-/);
    // A 의 요청이 실패해 되돌림 (B 에는 알림이 가지 않았다) → 서비스는 모든 워커에 reload 를 보낸다
    assert.throws(() => a.execute(`INSERT INTO users (name, age, email) VALUES ${values('gone', 600)}; SELECT * FROM nope`));
    b.loadIndexes();
    const r2 = one(a, `INSERT INTO users (name, age, email) VALUES ${values('second', 600)}`);
    b.applyIndex('users', r2.entries);
    r2.ids.forEach((id, i) => assert.equal(one(b, `SELECT name FROM users WHERE id = ${id}`).rows[0][0], `second-${i}`));
    sa.close(); sb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('INSERT 직후의 행(아직 페이지가 덜 찬 꼬리)도 바로 읽힌다', () => {
    const dir = tmp();
    const s = new FileStorage(dir);
    const db = new Database(s);
    for (let i = 1; i <= 500; i++) {
      const id = one(db, `INSERT INTO users (name, age, email) VALUES ('n${i}', ${i % 90}, 'n${i}@x.io')`).ids[0];
      assert.deepEqual(one(db, `SELECT name FROM users WHERE id = ${id}`).rows, [[`n${i}`]]);
    }
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('캐시 스탬피드 방어 (single-flight)', () => {
  test('같은 키로 동시에 100번 불러도 함수는 한 번만 실행되고, 모두 같은 값을 받는다', async () => {
    const flights = createSingleFlight();
    let calls = 0;
    const load = async () => { calls++; await sleep(30); return { n: 42 }; };
    const rs = await Promise.all(Array.from({ length: 100 }, () => flights.run('k', load)));
    assert.equal(calls, 1);
    assert.ok(rs.every((r) => r.value.n === 42));
    assert.equal(rs.filter((r) => !r.shared).length, 1, '직접 실행한 요청은 하나');
    rs[1].value.n = 0; // 한 요청이 고쳐도
    assert.equal(rs[2].value.n, 42, '다른 요청의 값은 그대로');
    assert.equal(flights.size, 0, '끝나면 비운다');
  });

  test('키가 다르면 따로 실행하고, 실패는 함께 기다린 모두에게 전달된 뒤 다음 요청은 새로 시도한다', async () => {
    const flights = createSingleFlight();
    let calls = 0;
    await Promise.all(['a', 'b', 'c'].map((k) => flights.run(k, async () => { calls++; await sleep(5); })));
    assert.equal(calls, 3);
    const boom = async () => { calls++; await sleep(10); throw new Error('DB 장애'); };
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => flights.run('x', boom)));
    assert.ok(rs.every((r) => r.status === 'rejected' && r.reason.message === 'DB 장애'));
    assert.equal(calls, 4, '실패한 조회도 한 번만');
    assert.equal((await flights.run('x', async () => 'ok')).value, 'ok');
  });

  test('LocalCache.getOrLoad: 동시에 놓친 50개 요청이 loader 를 한 번만 부른다', async () => {
    const cache = new LocalCache();
    let calls = 0;
    const rs = await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad('rank', async () => { calls++; await sleep(20); return [1, 2, 3]; }, { ttl: 60 })));
    assert.equal(calls, 1);
    assert.ok(rs.every((r) => r.hit === false && r.value.length === 3));
    assert.equal((await cache.getOrLoad('rank', async () => { calls++; return []; })).hit, true, '그 뒤로는 캐시에서');
    assert.equal(calls, 1);
  });

  describe('서버', () => {
    let s, base;
    before(async () => {
      s = await startRedisServer({ port: 0, latencyMs: 60 });
      base = `http://127.0.0.1:${s.port}`;
    });
    after(() => s.close());

    test('MiniRedisClient.getOrLoad: 동시에 놓친 30개 요청이 loader 를 한 번만 부른다', async () => {
      const c = new MiniRedisClient(base);
      let calls = 0;
      const rs = await Promise.all(Array.from({ length: 30 }, () => c.getOrLoad('top100', async () => { calls++; await sleep(40); return { rows: 100 }; }, { ttl: 60 })));
      assert.equal(calls, 1);
      assert.ok(rs.every((r) => r.value.rows === 100));
      assert.equal((await c.getOrLoad('top100', async () => { calls++; return null; })).hit, true);
    });

    test('데모 API: 캐시가 빈 상품을 동시에 40명이 조회해도 DB 조회는 한 번 (전에는 40번)', async () => {
      const before = s.products.counters.dbQueries;
      const rs = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/demo/products/3`)));
      assert.ok(rs.every((r) => r.status === 200));
      assert.equal(s.products.counters.dbQueries - before, 1);
      const bodies = await Promise.all(rs.map((r) => r.json()));
      assert.ok(bodies.every((b) => b.id === 3 && b.name === '27인치 모니터'));
      // 없는 상품(404)도 한 번만
      const b2 = s.products.counters.dbQueries;
      const miss = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/demo/products/999`)));
      assert.ok(miss.every((r) => r.status === 404));
      assert.equal(s.products.counters.dbQueries - b2, 1);
    });
  });
});
