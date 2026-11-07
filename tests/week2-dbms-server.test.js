/**
 * 2주차 미니 DBMS — Phase 3: 읽기/쓰기 락, 스레드 풀, API 서버 기능 테스트
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RWLock, LockManager } from '../week2/dbms/lock.js';
import { startDbServer } from '../week2/dbms/server.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('읽기/쓰기 락', () => {
  test('읽기끼리는 동시에, 쓰기는 혼자', async () => {
    const l = new RWLock();
    const r1 = await l.acquire('read');
    const r2 = await l.acquire('read');
    assert.equal(l.state().readers, 2);
    let wrote = false;
    const w = l.acquire('write').then((rel) => { wrote = true; return rel; });
    await tick();
    assert.equal(wrote, false, '읽는 중에는 쓰기 대기');
    r1();
    await tick();
    assert.equal(wrote, false);
    r2();
    const relW = await w;
    assert.equal(wrote, true);
    assert.equal(l.state().writer, true);
    relW();
    assert.deepEqual(l.state(), { readers: 0, writer: false, waiting: 0 });
  });

  test('기다리는 쓰기가 있으면 새 읽기는 뒤에 (쓰기 기아 방지)', async () => {
    const l = new RWLock();
    const order = [];
    const r1 = await l.acquire('read');
    const w = l.acquire('write').then((rel) => { order.push('write'); return rel; });
    const r2 = l.acquire('read').then((rel) => { order.push('read2'); return rel; });
    await tick();
    assert.deepEqual(order, [], 'read2 는 r1 과 함께 들어가지 않음');
    r1();
    (await w)();
    (await r2)();
    assert.deepEqual(order, ['write', 'read2']);
  });

  test('해제 함수를 두 번 불러도 안전', async () => {
    const l = new RWLock();
    const rel = await l.acquire('read');
    rel();
    rel();
    assert.equal(l.state().readers, 0);
  });

  test('LockManager: 같은 테이블을 읽고 쓰면 쓰기 락, 여러 테이블은 이름 순서로', async () => {
    const m = new LockManager();
    const rel = await m.acquire({ read: ['users', 'products'], write: ['users'] });
    assert.deepEqual(m.state(), { products: { readers: 1, writer: false, waiting: 0 }, users: { readers: 0, writer: true, waiting: 0 } });
    rel();
    assert.equal(m.state().users.writer, false);
  });
});

describe('API 서버 (스레드 풀 4개)', () => {
  let s, dir, post;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidb-srv-'));
    s = await startDbServer({ port: 0, dir, workers: 4 });
    post = async (sql, delayMs) => {
      const r = await fetch(`http://127.0.0.1:${s.port}/sql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, delayMs }) });
      return { status: r.status, body: await r.json() };
    };
  });
  after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('동시에 INSERT 60개 → id 가 겹치지 않고 1~60 으로 빈틈없이', async () => {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => post(`INSERT INTO users (name, age, email) VALUES ('u${i}', ${20 + (i % 10)}, 'u${i}@x')`)));
    assert.ok(rs.every((r) => r.status === 200));
    const ids = rs.flatMap((r) => r.body.results[0].ids).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 60 }, (_, i) => i + 1));
    assert.ok(new Set(rs.map((r) => r.body.workerId)).size > 1, '여러 워커가 돌아가며 처리');
  });

  test('어느 워커가 받아도 다른 워커가 넣은 레코드를 인덱스로 찾는다', async () => {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => post(`SELECT name FROM users WHERE id = ${i + 1}`)));
    assert.ok(rs.every((r) => r.body.results[0].rows.length === 1 && r.body.results[0].plan.type === 'index-lookup'));
    assert.equal(new Set(rs.map((r) => r.body.workerId)).size, 4, '워커 4개 모두 사용');
  });

  test('조회는 병렬: 300ms 걸리는 조회 4개가 약 300ms 에 끝난다 (순서대로면 1200ms)', async () => {
    const t0 = performance.now();
    const rs = await Promise.all([0, 1, 2, 3].map(() => post('SELECT id FROM users WHERE id = 1', 300)));
    const ms = performance.now() - t0;
    assert.equal(new Set(rs.map((r) => r.body.workerId)).size, 4);
    assert.ok(ms < 900, `${ms.toFixed(0)}ms`);
  });

  test('쓰는 동안 같은 테이블 읽기는 기다린다 (반쯤 쓴 데이터를 읽지 않게)', async () => {
    const slowWrite = post("INSERT INTO users (name) VALUES ('slow')", 300);
    await new Promise((r) => setTimeout(r, 50));
    const read = await post("SELECT id FROM users WHERE name = 'slow'");
    assert.equal(read.body.results[0].rows.length, 1, '쓰기가 끝난 뒤에 읽어서 새 행이 보임');
    assert.ok(read.body.lockMs > 100, `락 대기 ${read.body.lockMs.toFixed(0)}ms`);
    await slowWrite;
  });

  test('다른 테이블은 서로 막지 않는다', async () => {
    const slowWrite = post("INSERT INTO products (name, price) VALUES ('p', 1)", 300);
    await new Promise((r) => setTimeout(r, 30));
    const read = await post('SELECT id FROM users WHERE id = 1');
    assert.ok(read.body.lockMs < 100, `users 읽기 락 대기 ${read.body.lockMs.toFixed(0)}ms`);
    await slowWrite;
  });

  test('한 요청에 여러 문장 + 대용량 범위 조회', async () => {
    const values = Array.from({ length: 500 }, (_, i) => `('bulk${i}', 1, 'b${i}@x')`).join(',');
    const r = await post(`INSERT INTO users (name, age, email) VALUES ${values}; SELECT id FROM users WHERE id BETWEEN 100 AND 199`);
    assert.equal(r.body.results[0].count, 500);
    assert.equal(r.body.results[1].rows.length, 100);
    assert.equal(r.body.results[1].plan.type, 'index-range');
  });

  test('에러: SQL 문법 400, 없는 테이블 400, sql 없음 400, JSON 아님 400, 없는 주소 404', async () => {
    assert.equal((await post('SELEC * FROM users')).status, 400);
    const noTable = await post('SELECT * FROM ghosts');
    assert.equal(noTable.status, 400);
    assert.match(noTable.body.message, /ghosts/);
    assert.equal((await post('   ')).status, 400);
    const base = `http://127.0.0.1:${s.port}`;
    assert.equal((await fetch(`${base}/sql`, { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(`${base}/sql`, { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  });

  test('실패한 요청 뒤에도 서버는 계속 정상 (락이 풀려 있음)', async () => {
    await post("INSERT INTO users (name, age) VALUES ('x', 'not-int')");
    const ok = await post("INSERT INTO users (name) VALUES ('after-error')");
    assert.equal(ok.status, 200);
    assert.deepEqual(s.svc.locks.state().users, { readers: 0, writer: false, waiting: 0 });
  });

  test('상태 / 테이블 정보', async () => {
    const st = await (await fetch(`http://127.0.0.1:${s.port}/sql/status`)).json();
    assert.equal(st.pool.size, 4);
    assert.ok(st.pool.completed > 100);
    assert.ok(st.maxActive >= 2, '동시에 2개 이상 처리한 적이 있음');
    const tb = await (await fetch(`http://127.0.0.1:${s.port}/sql/tables`)).json();
    const users = tb.tables.find((t) => t.table === 'users');
    assert.ok(users.rows >= 562);
  });

  test('서버를 다시 켜도 데이터와 다음 id 가 이어진다', async () => {
    const before = (await post('SELECT id FROM users')).body.results[0].rows.length;
    await s.close();
    s = await startDbServer({ port: 0, dir, workers: 2 });
    const r = await post("INSERT INTO users (name) VALUES ('restart')");
    assert.equal(r.body.results[0].ids[0], before + 1);
  });
});
