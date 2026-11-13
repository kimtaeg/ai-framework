/**
 * 2주차 miniDBMS — 지연을 줄이는 경로가 "느린 원래 경로" 와 같은 결과를 내는지 확인
 *   해시 인덱스(autoIndex) · 범위 조회의 덩어리 읽기 · 읽기 락 없는 조회(snapshotReads)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../week2/dbms/engine.js';
import { MemoryStorage } from '../week2/dbms/storage.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { createDbService } from '../week2/dbms/service.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const SCHEMA = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
const values = (from, n) => Array.from({ length: n }, (_, k) => `('n${(from + k) % 7}', ${(from + k) % 5 === 0 ? 'NULL' : (from + k) % 40}, 'u${from + k}@x')`).join(',');
const insert = (from, n) => `INSERT INTO users (name, age, email) VALUES ${values(from, n)}`;

const QUERIES = [
  "SELECT * FROM users WHERE email = 'u17@x'",
  "SELECT * FROM users WHERE email = 'nobody@x'",
  "SELECT id, email FROM users WHERE name = 'n3'",
  "SELECT id FROM users WHERE name = 'n3' LIMIT 4",
  'SELECT id FROM users WHERE age = 12',
  'SELECT id FROM users WHERE age = 12.5',
  "SELECT id FROM users WHERE name = 'n3' AND age > 20",
  "SELECT id FROM users WHERE age = 7 AND name = 'n0'",
  'SELECT id FROM users WHERE age = NULL',
  "SELECT id FROM users WHERE name = 'n1' AND id > 30",
  "SELECT id FROM users WHERE name != 'n1' LIMIT 5",
];

describe('해시 인덱스 (autoIndex)', () => {
  for (const [label, make] of [
    ['메모리', () => ({ storage: (s) => new MemoryStorage(s), cleanup() {} })],
    ['파일', () => {
      const dirs = [];
      return { storage: (s) => { const d = tmp('minidb-auto'); dirs.push(d); return new FileStorage(d, { schema: s }); }, cleanup() { for (const d of dirs) rmSync(d, { recursive: true, force: true }); } };
    }],
  ]) {
    test(`${label}: 전체 읽기와 결과가 같고, 인덱스를 만든 뒤에는 그 줄만 읽는다`, () => {
      const env = make();
      const sa = env.storage(SCHEMA), sb = env.storage(SCHEMA);
      try {
        const plain = new Database(sa);
        const auto = new Database(sb, { autoIndex: true });
        for (const db of [plain, auto]) db.execute(insert(1, 120));
        for (const sql of QUERIES) {
          const a = plain.execute(sql)[0], b = auto.execute(sql)[0];
          assert.deepEqual(b.rows, a.rows, sql);
          assert.deepEqual(b.columns, a.columns);
        }
        // 인덱스를 만든 뒤: 한 줄만 읽는다
        const r = auto.execute("SELECT * FROM users WHERE email = 'u17@x'")[0];
        assert.equal(r.plan.type, 'hash-index');
        assert.equal(r.plan.scanned, 1);
        assert.equal(plain.execute("SELECT * FROM users WHERE email = 'u17@x'")[0].plan.type, 'full-scan');
        // id 조건이 있으면 여전히 B+ 트리가 먼저
        assert.equal(auto.execute("SELECT id FROM users WHERE id = 3 AND name = 'n3'")[0].plan.type, 'index-lookup');

        // 인덱스를 만든 뒤에 넣은 행도 찾고, 실패한 요청의 행은 남지 않는다
        for (const db of [plain, auto]) {
          db.execute(insert(500, 30));
          assert.throws(() => db.execute(`${insert(900, 5)}; SELECT nope FROM users`));
        }
        for (const sql of [...QUERIES, "SELECT id FROM users WHERE email = 'u510@x'", "SELECT id FROM users WHERE email = 'u902@x'"]) {
          assert.deepEqual(auto.execute(sql)[0].rows, plain.execute(sql)[0].rows, sql);
        }
        assert.deepEqual(auto.execute("SELECT id FROM users WHERE email = 'u510@x'")[0].rows, [[131]]);
        assert.deepEqual(auto.execute("SELECT id FROM users WHERE email = 'u902@x'")[0].rows, []);
      } finally {
        sa.close?.(); sb.close?.();
        env.cleanup();
      }
    });
  }

  test('기본값은 끔 — 과제 그대로 id 가 아닌 열은 선형 탐색', () => {
    const db = new Database(new MemoryStorage(SCHEMA));
    db.execute(insert(1, 10));
    const r = db.execute("SELECT * FROM users WHERE email = 'u3@x'")[0];
    assert.equal(r.plan.type, 'full-scan');
    assert.equal(r.plan.scanned, 10);
  });
});

describe('범위 조회의 덩어리 읽기', () => {
  test('긴 범위 · LIMIT · 다른 조건이 섞여도 한 줄씩 읽을 때와 결과가 같다', () => {
    const dir = tmp('minidb-range');
    try {
      const file = new Database(new FileStorage(dir, { schema: SCHEMA }));
      const mem = new Database(new MemoryStorage(SCHEMA));
      // 값에 한글 · 쉼표 · 따옴표를 섞어 줄 길이를 들쭉날쭉하게, 64KB 덩어리 경계도 여러 번 넘게
      for (const db of [file, mem]) {
        for (let k = 0; k < 6; k++) {
          const rows = Array.from({ length: 500 }, (_, i) => `('이름, "${'가'.repeat((k * 500 + i) % 23)}"', ${i % 50}, 'e${k * 500 + i}@x')`).join(',');
          db.execute(`INSERT INTO users (name, age, email) VALUES ${rows}`);
        }
      }
      for (const sql of [
        'SELECT * FROM users WHERE id BETWEEN 5 AND 2600',
        'SELECT * FROM users WHERE id > 1 AND id < 12',
        'SELECT id, name FROM users WHERE id >= 100 LIMIT 37',
        'SELECT id FROM users WHERE id > 20 AND age = 7',
        'SELECT * FROM users WHERE id BETWEEN 2990 AND 5000',
        'SELECT * FROM users WHERE id > 0 LIMIT 9',
        'SELECT * FROM users WHERE id > 0 LIMIT 10',
      ]) {
        assert.deepEqual(file.execute(sql)[0].rows, mem.execute(sql)[0].rows, sql);
      }
      assert.equal(file.execute('SELECT id FROM users WHERE id > 0')[0].rows.length, 3000);
      file.storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('파일 순서와 id 순서가 달라도(손으로 고친 파일) 결과는 id 순서대로 맞다', () => {
    const dir = tmp('minidb-order');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      const ids = Array.from({ length: 40 }, (_, i) => i + 1);
      const shuffled = [...ids.slice(0, 12), ...ids.slice(12).reverse()];
      writeFileSync(join(dir, 'users.tbl'), shuffled.map((id) => `${id},n${id},${id},e${id}@x`).join('\n') + '\n');
      const storage = new FileStorage(dir);
      const db = new Database(storage);
      assert.deepEqual(db.execute('SELECT id FROM users WHERE id >= 1')[0].rows.map((r) => r[0]), ids);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('API 서버의 지연 옵션', () => {
  test('autoIndex: 어느 워커가 받아도, 다른 워커가 넣은 행을 해시 인덱스로 찾는다', async () => {
    const dir = tmp('minidb-svc-auto');
    const svc = createDbService({ dir, workers: 3 });
    try {
      await svc.ready();
      await svc.query(`INSERT INTO users (name, age, email) VALUES ${values(1, 50)}`);
      const find = async (email) => (await svc.query(`SELECT id FROM users WHERE email = '${email}'`)).results[0];
      for (let k = 0; k < 6; k++) assert.deepEqual((await find('u20@x')).rows, [[20]]); // 모든 워커가 인덱스를 만든다
      for (let k = 0; k < 9; k++) {
        await svc.query(`INSERT INTO users (name, age, email) VALUES ('w', 1, 'new${k}@x')`);
        for (let j = 0; j < 3; j++) {
          const r = await find(`new${k}@x`);
          assert.deepEqual(r.rows, [[51 + k]], `new${k} · 워커`);
          assert.equal(r.plan.type, 'hash-index');
          assert.equal(r.plan.scanned, 1);
        }
      }
      // 한꺼번에 많이 넣으면 인덱스를 버렸다가 다시 만든다 → 그래도 결과는 같다
      await svc.query(`INSERT INTO users (name, age, email) VALUES ${values(1000, 400)}`);
      for (let j = 0; j < 4; j++) assert.deepEqual((await find('u1399@x')).rows, [[459]]);
      // 실패한 요청 뒤에도
      await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('z', 1, 'gone@x'); SELECT nope FROM users"));
      for (let j = 0; j < 4; j++) assert.deepEqual((await find('gone@x')).rows, []);
      for (let j = 0; j < 4; j++) assert.deepEqual((await find('new3@x')).rows, [[54]]);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('snapshotReads: 쓰는 중에도 조회는 기다리지 않고, 쓰다 만 행은 절대 보이지 않는다', async () => {
    const dir = tmp('minidb-svc-snap');
    const svc = createDbService({ dir, workers: 3, snapshotReads: true, autoIndex: false });
    try {
      await svc.ready();
      await svc.query(`INSERT INTO users (name, age, email) VALUES ${values(1, 100)}`);
      // 오래 걸리는 쓰기(300ms) 도중의 조회
      const slow = svc.query(`INSERT INTO users (name, age, email) VALUES ${values(200, 100)}`, { delayMs: 300 });
      await new Promise((r) => setTimeout(r, 60));
      const during = await svc.query('SELECT id FROM users');
      assert.ok(during.lockMs < 100, `조회가 쓰기를 기다리지 않는다 (${during.lockMs.toFixed(0)}ms)`);
      assert.equal(during.results[0].rows.length, 100);
      await slow;
      for (let k = 0; k < 3; k++) assert.equal((await svc.query('SELECT id FROM users')).results[0].rows.length, 200);

      // 쓰기와 전체 읽기를 마구 섞는다: 조회 결과는 항상 "어느 시점까지 끝난 INSERT 들" 과 정확히 같아야 한다
      let writing = true;
      const writer = (async () => {
        for (let k = 0; k < 40; k++) await svc.query(`INSERT INTO users (name, age, email) VALUES ${values(1000 + k * 50, 50)}`);
        writing = false;
      })();
      const reader = async () => {
        let reads = 0;
        while (writing) {
          const rows = (await svc.query('SELECT id, name, age, email FROM users')).results[0].rows;
          assert.equal((rows.length - 200) % 50, 0, `INSERT 하나가 통째로 보이거나 안 보이거나 (${rows.length}행)`);
          rows.forEach((r, i) => assert.equal(r[0], i + 1));
          const last = rows.at(-1);
          assert.match(last[3], /^u\d+@x$/, '마지막 행이 잘려 있지 않다');
          reads++;
        }
        return reads;
      };
      const counts = await Promise.all([reader(), reader(), writer]);
      assert.ok(counts[0] + counts[1] > 0);
      assert.equal((await svc.query('SELECT id FROM users')).results[0].rows.length, 2200);
      assert.deepEqual(svc.locks.state().users, { readers: 0, writer: false, waiting: 0 });
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
