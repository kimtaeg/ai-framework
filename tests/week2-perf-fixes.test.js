/**
 * 2주차 — 성능 문제 4가지를 고친 경로가 예전과 같은 결과를 내는지 확인
 *   1) 범위 조회: 작게 읽기 시작해 점점 크게   2) INFO: 키 목록을 만들지 않음
 *   3) 롤백: 전체를 다시 읽지 않고 넣은 것만 뺌 (B+ 트리 removeMax)   4) 줄 인코딩의 빠른 경로
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BPlusTree } from '../mini_DBMS/bptree.js';
import { Database } from '../mini_DBMS/engine.js';
import { MemoryStorage, encodeRow, decodeRow } from '../mini_DBMS/storage.js';
import { FileStorage } from '../mini_DBMS/storage-file.js';
import { MiniRedis } from '../mini_redis/miniredis.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const SCHEMA = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
/** 작고 재현 가능한 난수 */
const rng = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

describe('B+ 트리: 가장 큰 키 지우기 (removeMax)', () => {
  for (const order of [3, 4, 5, 8, 64]) {
    test(`차수 ${order}: 넣고 빼기를 섞어도 구조가 항상 올바르다`, () => {
      const rand = rng(order * 7 + 1);
      const tree = new BPlusTree(order);
      const model = []; // 들어 있는 키 (오름차순)
      let next = 1;
      for (let step = 0; step < 4000; step++) {
        if (model.length === 0 || rand() < 0.55) {
          // 대부분은 끝에 붙이고(id 처럼), 가끔은 중간에 끼워 넣는다
          const key = rand() < 0.8 || model.length < 2 ? next++ * 10 : model[Math.floor(rand() * (model.length - 1))] + 1 + Math.floor(rand() * 8);
          if (tree.has(key)) continue;
          tree.insert(key, `v${key}`);
          model.push(key);
          model.sort((a, b) => a - b);
        } else {
          const expected = model.pop();
          assert.equal(tree.removeMax(), expected);
          assert.equal(tree.get(expected), undefined);
        }
        if (step % 37 === 0) tree.check();
        assert.equal(tree.size, model.length);
      }
      tree.check();
      assert.deepEqual([...tree.range()].map(([k]) => k), model);
      // 끝까지 다 빼면 빈 트리 (높이 1)
      while (model.length) assert.equal(tree.removeMax(), model.pop());
      tree.check();
      assert.equal(tree.size, 0);
      assert.equal(tree.height, 1);
      assert.equal(tree.removeMax(), undefined);
      // 비운 뒤에도 다시 쓸 수 있다
      for (let k = 1; k <= 50; k++) tree.insert(k, k);
      tree.check();
      assert.equal(tree.max(), 50);
    });
  }
});

describe('롤백: 넣은 것만 되돌린다', () => {
  test('파일: 전체를 다시 읽지 않고, 인덱스 · 다음 id · 파일이 요청 전과 같다', () => {
    const dir = tmp('minidb-rb');
    try {
      const storage = new FileStorage(dir, { schema: SCHEMA });
      const db = new Database(storage, { order: 4 });
      const rows = (from, n) => Array.from({ length: n }, (_, i) => `('n${from + i}', ${(from + i) % 50}, 'e${from + i}@x')`).join(',');
      db.execute(`INSERT INTO users (name, age, email) VALUES ${rows(1, 3000)}`);
      const before = readFileSync(join(dir, 'users.tbl'), 'utf8');
      const readsBefore = storage.reads;
      assert.throws(() => db.execute(`INSERT INTO users (name, age, email) VALUES ${rows(5000, 40)}; INSERT INTO users (name, age, email) VALUES ${rows(6000, 25)}; SELECT nope FROM users`));
      assert.ok(storage.reads - readsBefore < 200, `되돌리면서 읽은 줄 ${storage.reads - readsBefore} (전체는 3000줄)`);
      assert.equal(readFileSync(join(dir, 'users.tbl'), 'utf8'), before);
      const t = db.tables.users;
      t.index.check();
      assert.equal(t.index.size, 3000);
      assert.equal(t.nextId, 3001);
      assert.deepEqual(db.execute(`INSERT INTO users (name, age, email) VALUES ${rows(7000, 2)}`)[0].ids, [3001, 3002]);
      assert.deepEqual(db.execute('SELECT id, name FROM users WHERE id >= 2999')[0].rows, [[2999, 'n2999'], [3000, 'n3000'], [3001, 'n7000'], [3002, 'n7001']]);
      assert.equal(db.execute('SELECT id FROM users').length, 1);
      assert.equal(db.execute('SELECT id FROM users')[0].rows.length, 3002);
      t.index.check();
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('해시 인덱스가 있어도 되돌린 행은 인덱스에 남지 않는다 (선형 탐색과 결과가 같다)', () => {
    const make = (autoIndex) => {
      const db = new Database(new MemoryStorage(SCHEMA), { autoIndex });
      db.execute(`INSERT INTO users (name, age, email) VALUES ${Array.from({ length: 200 }, (_, i) => `('n${i % 9}', ${i % 7}, 'e${i}@x')`).join(',')}`);
      return db;
    };
    const auto = make(true), plain = make(false);
    const queries = ["SELECT id FROM users WHERE name = 'n3'", 'SELECT id FROM users WHERE age = 4', "SELECT id FROM users WHERE email = 'dup@x'", "SELECT id FROM users WHERE name = 'only-once'", "SELECT id FROM users WHERE email = 'e5@x'"];
    for (const q of queries) auto.execute(q); // 인덱스를 미리 만들어 둔다
    const bad = "INSERT INTO users (name, age, email) VALUES ('n3', 4, 'dup@x'), ('only-once', 4, 'dup@x'), ('n3', 4, 'e5@x'); SELECT nope FROM users";
    for (let k = 0; k < 3; k++) for (const db of [auto, plain]) assert.throws(() => db.execute(bad));
    for (const q of queries) {
      const a = auto.execute(q)[0];
      assert.deepEqual(a.rows, plain.execute(q)[0].rows, q);
      assert.equal(a.plan.built, undefined, '인덱스를 다시 만들지 않았다');
    }
    // 되돌린 뒤 같은 값을 실제로 넣으면 찾는다
    for (const db of [auto, plain]) db.execute("INSERT INTO users (name, age, email) VALUES ('only-once', 4, 'dup@x')");
    for (const q of queries) assert.deepEqual(auto.execute(q)[0].rows, plain.execute(q)[0].rows, q);
    assert.deepEqual(auto.execute("SELECT id FROM users WHERE name = 'only-once'")[0].rows, [[201]]);
    auto.tables.users.index.check();
  });
});

describe('범위 조회: 작게 읽기 시작해 점점 크게', () => {
  test('줄 길이가 들쭉날쭉하고 첫 덩어리(2KB)보다 긴 줄이 있어도 한 줄씩 읽을 때와 같다', () => {
    const dir = tmp('minidb-grow');
    try {
      const file = new Database(new FileStorage(dir, { schema: SCHEMA }));
      const mem = new Database(new MemoryStorage(SCHEMA));
      const rand = rng(11);
      for (const db of [file, mem]) {
        const r = rng(11);
        for (let k = 0; k < 8; k++) {
          const rows = Array.from({ length: 150 }, (_, i) => {
            const len = r() < 0.03 ? 3000 + Math.floor(r() * 6000) : Math.floor(r() * 60);
            return `('${'가'.repeat(len % 40)}${'x'.repeat(len)}', ${i % 50}, 'e${k * 150 + i}@x')`;
          }).join(',');
          db.execute(`INSERT INTO users (name, age, email) VALUES ${rows}`);
        }
      }
      for (let k = 0; k < 60; k++) {
        const lo = 1 + Math.floor(rand() * 1150);
        const n = [1, 7, 8, 9, 10, 20, 64, 300][k % 8];
        const sql = k % 3 === 0 ? `SELECT * FROM users WHERE id >= ${lo} LIMIT ${n}` : `SELECT id, name FROM users WHERE id BETWEEN ${lo} AND ${lo + n - 1}`;
        assert.deepEqual(file.execute(sql)[0].rows, mem.execute(sql)[0].rows, sql);
      }
      assert.deepEqual(file.execute('SELECT * FROM users WHERE id > 0')[0].rows, mem.execute('SELECT * FROM users WHERE id > 0')[0].rows);
      assert.deepEqual(file.execute('SELECT id FROM users WHERE age = 7')[0].rows, mem.execute('SELECT id FROM users WHERE age = 7')[0].rows);
      file.storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('INFO', () => {
  test('모든 키 목록을 만들지 않고도 같은 통계를 낸다', () => {
    const r = new MiniRedis();
    for (let i = 0; i < 500; i++) r.command(['SET', `k${i}`, 'v', ...(i % 2 ? ['EX', '100'] : [])]);
    r.command(['TAG', 'k1', 'a', 'b']);
    const snap = r.data.snapshot();
    r.data.snapshot = () => { throw new Error('INFO 가 snapshot 을 불렀다'); };
    const info = r.command(['INFO']);
    assert.equal(info.keys, 500);
    assert.equal(info.keysWithTtl, 250);
    assert.equal(info.tags, 2);
    assert.deepEqual(info.hashTable, {
      buckets: (snap.tables[1] ?? snap.tables[0]).size,
      loadFactor: Number(snap.loadFactor.toFixed(3)),
      rehashing: snap.rehashIdx !== -1,
      resizes: snap.stats.resizes,
      collisions: snap.stats.collisions,
    });
  });
});

describe('줄 인코딩의 빠른 경로', () => {
  test('어떤 값이든 인코딩 → 디코딩하면 원래 값(문자열)으로 돌아온다', () => {
    const values = [
      'plain', '한글 값', 'a b', '', ' ', ' lead', 'trail ', '\ttab', 'a,b', 'say "hi"', '"', ',', 'line\nbreak', 'cr\rhere', 'back\\slash', '\\N', '\\\\N', '\\n', 'N', '0', '-1',
      0, -1, 42, 3.14, 1e21, -0, null, undefined, true, 'a\\,b"c\nd', "it's", 'x'.repeat(5000),
    ];
    const back = (v) => (v === null || v === undefined ? null : String(v));
    for (const v of values) {
      const line = encodeRow([1, v, v]);
      assert.equal(line.includes('\n'), false, `줄바꿈이 줄에 남으면 안 된다: ${JSON.stringify(v)}`);
      assert.deepEqual(decodeRow(line), ['1', back(v), back(v)], JSON.stringify(v));
    }
    // 평범한 값은 따옴표 없이 그대로 저장된다 (파일 형식이 바뀌지 않았다)
    assert.equal(encodeRow([7, '김정글', 25, 'jungle@ex.com', null]), '7,김정글,25,jungle@ex.com,\\N');
    assert.equal(encodeRow([8, '이, 리액트', '']), '8,"이, 리액트",""');
  });
});
