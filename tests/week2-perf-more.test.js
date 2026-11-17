/**
 * 2주차 — 성능 수정 2차: 스키마에 적어 둔 해시 인덱스 · 버퍼 풀 건너뛰기 · 정적 파일 gzip 캐시
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Database } from '../mini_DBMS/engine.js';
import { MemoryStorage } from '../mini_DBMS/storage.js';
import { FileStorage } from '../mini_DBMS/storage-file.js';
import { createDbService } from '../mini_DBMS/service.js';
import { createApp, createWeek2 } from '../server.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const COLS = ['id', 'name', 'age', 'email', 'city', 'job', 'team', 'tag'].map((name) => ({ name, type: name === 'id' || name === 'age' ? 'INT' : 'TEXT' }));
const SCHEMA = { users: { columns: COLS, indexes: ['email'] } };
const PLAIN = { users: { columns: COLS } };
const rows = (from, n) => Array.from({ length: n }, (_, k) => { const i = from + k; return `('n${i % 9}', ${i % 40}, 'e${i}@x', 'c${i % 5}', 'j${i % 6}', 't${i % 7}', 'g${i % 8}')`; }).join(',');
const insert = (from, n) => `INSERT INTO users (name, age, email, city, job, team, tag) VALUES ${rows(from, n)}`;

describe('스키마에 적어 둔 해시 인덱스 (indexes)', () => {
  test('시작할 때 만들어져서 첫 조회부터 한 줄만 읽는다 (autoIndex 를 꺼도)', () => {
    const dir = tmp('minidb-decl');
    try {
      let storage = new FileStorage(dir, { schema: SCHEMA });
      let db = new Database(storage);
      db.execute(insert(1, 500));
      storage.close();

      storage = new FileStorage(dir);
      db = new Database(storage); // autoIndex 끔
      const readsAtStart = storage.reads;
      const r = db.execute("SELECT id FROM users WHERE email = 'e77@x'")[0];
      assert.deepEqual(r.rows, [[77]]);
      assert.equal(r.plan.type, 'hash-index');
      assert.equal(r.plan.built, undefined, '조회할 때 새로 만들지 않았다');
      assert.equal(r.plan.scanned, 1);
      assert.equal(storage.reads - readsAtStart, 1);
      // 적어 두지 않은 열은 그대로 선형 탐색 (autoIndex 가 꺼져 있으므로)
      const n = db.execute("SELECT id FROM users WHERE name = 'n3'")[0];
      assert.equal(n.plan.type, 'full-scan');
      // 조건이 섞여 있으면 적어 둔 열로 찾고 나머지는 걸러 낸다
      assert.deepEqual(db.execute("SELECT id FROM users WHERE name = 'n5' AND email = 'e77@x'")[0].rows, [[77]]);
      assert.deepEqual(db.execute("SELECT id FROM users WHERE name = 'n4' AND email = 'e77@x'")[0].rows, []);
      // 넣은 행 · 되돌린 행 · 다시 읽은 뒤
      db.execute(insert(1000, 3));
      assert.deepEqual(db.execute("SELECT id FROM users WHERE email = 'e1001@x'")[0].rows, [[502]]);
      assert.throws(() => db.execute(`${insert(2000, 2)}; SELECT nope FROM users`));
      assert.deepEqual(db.execute("SELECT id FROM users WHERE email = 'e2000@x'")[0].rows, []);
      db.loadIndexes();
      const again = db.execute("SELECT id FROM users WHERE email = 'e1002@x'")[0];
      assert.deepEqual(again.rows, [[503]]);
      assert.equal(again.plan.built, undefined);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('autoIndex 와 함께: 다른 열을 많이 조회해도 적어 둔 인덱스는 버려지지 않고, 결과는 선형 탐색과 같다', () => {
    const decl = new Database(new MemoryStorage(SCHEMA), { autoIndex: true });
    const plain = new Database(new MemoryStorage(PLAIN));
    for (const db of [decl, plain]) db.execute(insert(1, 400));
    for (const col of ['name', 'city', 'job', 'team', 'tag', 'age']) decl.execute(`SELECT id FROM users WHERE ${col} = ${col === 'age' ? 3 : "'zz'"}`);
    const t = decl.tables.users;
    assert.ok(t.secondary.has(3), 'email 인덱스가 남아 있다');
    assert.equal(t.secondary.size, 5, '적어 둔 것 1개 + 자동으로 만든 것 최대 4개');
    const r = decl.execute("SELECT id FROM users WHERE email = 'e9@x'")[0];
    assert.equal(r.plan.built, undefined);
    for (const sql of ["SELECT id FROM users WHERE email = 'e9@x'", "SELECT id FROM users WHERE city = 'c2' AND job = 'j1'", "SELECT id FROM users WHERE name = 'n1' AND email = 'e10@x'", 'SELECT id FROM users WHERE age = 7 LIMIT 3', "SELECT id FROM users WHERE tag = 'g3' AND team = 't3'"]) {
      assert.deepEqual(decl.execute(sql)[0].rows, plain.execute(sql)[0].rows, sql);
    }
  });

  test('없는 열을 적으면 시작할 때 알려 준다. id 는 무시한다', () => {
    assert.throws(() => new Database(new MemoryStorage({ users: { columns: COLS, indexes: ['nope'] } })), /indexes 에 없는 열/);
    const db = new Database(new MemoryStorage({ users: { columns: COLS, indexes: ['id', 'EMAIL'] } }));
    assert.deepEqual([...db.tables.users.declared], [3]);
  });

  test('API 서버: 어느 워커가 받아도 첫 조회부터 인덱스를 쓴다', async () => {
    const dir = tmp('minidb-decl-svc');
    try {
      const storage = new FileStorage(dir, { schema: SCHEMA });
      new Database(storage).execute(insert(1, 300));
      storage.close();
      const svc = createDbService({ dir, workers: 3 });
      try {
        await svc.ready();
        for (let k = 0; k < 6; k++) {
          const r = (await svc.query(`SELECT id FROM users WHERE email = 'e${10 + k}@x'`)).results[0];
          assert.deepEqual(r.rows, [[10 + k]]);
          assert.equal(r.plan.built, undefined, `${k}번째 조회에서 인덱스를 새로 만들지 않았다`);
          assert.equal(r.plan.scanned, 1);
        }
        await svc.query(insert(5000, 2));
        for (let k = 0; k < 3; k++) assert.deepEqual((await svc.query("SELECT id FROM users WHERE email = 'e5001@x'")).results[0].rows, [[302]]);
      } finally {
        await svc.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('버퍼 풀: 적중률이 낮으면 건너뛴다', () => {
  test('고르게 흩어진 조회에서는 풀을 건너뛰고, 좁은 구간을 반복하면 다시 쓴다. 결과는 언제나 같다', () => {
    const dir = tmp('minidb-pool');
    try {
      const storage = new FileStorage(dir, { schema: PLAIN, poolPages: 4 });
      const db = new Database(storage);
      for (let k = 0; k < 10; k++) db.execute(insert(1 + k * 2000, 2000)); // 약 1MB = 8KB 페이지 100여 개, 풀은 4개
      const check = (id) => assert.deepEqual(db.execute(`SELECT id, email FROM users WHERE id = ${id}`)[0].rows, [[id, `e${id}@x`]]);
      // 1) 전체에 고르게 흩어진 조회: 대부분 빗나간다 → 건너뛰기 시작
      for (let i = 0; i < 12000; i++) check(1 + ((i * 7919) % 20000));
      assert.ok(storage.pool.bypassed > 0, `건너뛴 조회 ${storage.pool.bypassed}`);
      const missesAfterRandom = storage.pool.misses;
      assert.ok(missesAfterRandom < 9000, `빗나간 횟수 ${missesAfterRandom} (건너뛰지 않았다면 1만 번 넘게 빗나간다)`);
      // 2) 좁은 구간 반복: 건너뛰는 기간이 끝나면 다시 풀을 쓰고, 이번에는 잘 맞으므로 계속 쓴다
      const hitsBefore = storage.pool.hits;
      for (let i = 0; i < 60000; i++) check(100 + (i % 50));
      assert.ok(storage.pool.hits - hitsBefore > 30000, `적중 ${storage.pool.hits - hitsBefore}`);
      const bypassedHot = storage.pool.bypassed;
      for (let i = 0; i < 5000; i++) check(100 + (i % 50));
      assert.equal(storage.pool.bypassed, bypassedHot, '잘 맞는 동안에는 건너뛰지 않는다');
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('웹 서버: gzip 캐시', () => {
  test('같은 파일을 여러 번 요청해도 내용이 원본과 같다 (두 번째부터는 압축해 둔 것을 쓴다)', async () => {
    const dir = tmp('week2-web');
    const app = createApp({ week2: createWeek2(dir) });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const original = readFileSync(new URL('../styles/base.css', import.meta.url));
      for (let k = 0; k < 3; k++) {
        // fetch 는 gzip 을 알아서 풀어 준다 → 원본과 비교
        const res = await fetch(`${base}/styles/base.css`);
        assert.equal(res.headers.get('content-encoding'), 'gzip');
        assert.equal(Buffer.from(await res.arrayBuffer()).equals(original), true);
      }
      // gzip 을 받지 않는 요청은 원본 그대로
      const plain = await fetch(`${base}/styles/base.css`, { headers: { 'Accept-Encoding': 'identity' } });
      assert.equal(plain.headers.get('content-encoding'), null);
      assert.equal(Number(plain.headers.get('content-length')), original.length);
      assert.equal(Buffer.from(await plain.arrayBuffer()).equals(original), true);
      assert.ok(gunzipSync);
    } finally {
      await app.week2.close();
      app.closeAllConnections?.();
      await new Promise((r) => app.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
