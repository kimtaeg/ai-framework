/**
 * 2주차 miniRedis · miniDBMS — 안정성 회귀 테스트
 *   실제로 틀린 결과를 냈던 버그와, 서버가 죽거나 오래 켜져 있을 때 생기는 문제를 다시 만들지 않도록 고정한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashTable, fnv1a } from '../week2/redis/hashtable.js';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { openPersistentRedis } from '../week2/redis/persistence.js';
import { Database } from '../week2/dbms/engine.js';
import { MemoryStorage } from '../week2/dbms/storage.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { createDbService } from '../week2/dbms/service.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const SCHEMA = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }] } };

describe('miniRedis 안정성', () => {
  test('randomEntry 는 체인 뒤쪽 원소도 뽑는다', () => {
    // 모든 키가 한 버킷에 몰리게 해서 체인 하나를 만든다
    const t = new HashTable({ hash: () => 0 });
    t.resizable = false;
    for (const k of ['a', 'b', 'c', 'd']) t.set(k, 1);
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(t.randomEntry()[0]);
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
  });

  test('randomEntry 는 리해시 중에 두 테이블의 원소를 모두 뽑는다', () => {
    const t = new HashTable();
    for (let i = 0; i < 64; i++) t.set(`k${i}`, i);
    t.finishRehash();
    t.set('k64', 64); // 확장 시작 → 옛 테이블과 새 테이블에 나뉘어 있음
    assert.equal(t.isRehashing, true);
    const seen = new Set();
    for (let i = 0; i < 20000; i++) seen.add(t.randomEntry()[0]);
    assert.equal(seen.size, 65);
  });

  test('주기 삭제는 TTL 이 긴 키 뒤에 매달린 만료 키도 결국 지운다', () => {
    let now = 0;
    const r = new MiniRedis({ now: () => now });
    for (let i = 0; i < 4000; i++) r.command(['SET', `k${i}`, 'v', 'PX', i % 2 ? '100' : '100000000']);
    now = 1000;
    // 남은 만료 키가 줄수록 뽑힐 확률도 줄어서 꽤 여러 번 돌아야 한다. 고치기 전에는 몇 번을 돌아도 1천 개 넘게 남았다
    const staleCount = () => r.dump().filter((e) => e.expired).length;
    for (let c = 0; c < 60 && staleCount() > 0; c++) for (let k = 0; k < 500; k++) r.activeExpireCycle();
    const stale = staleCount();
    assert.equal(stale, 0, '만료됐는데 남은 키가 없어야 한다');
    assert.equal(r.command(['DBSIZE']), 2000);
  });

  test('해시 시드: 시드가 다르면 버킷 배치가 달라지고, 동작은 같다', () => {
    assert.equal(fnv1a('hello', 0), fnv1a('hello'));
    assert.notEqual(fnv1a('hello', 12345), fnv1a('hello'));
    const a = new MiniRedis({ hashSeed: 1 });
    const b = new MiniRedis({ hashSeed: 987654321 });
    for (const r of [a, b]) {
      for (let i = 0; i < 200; i++) r.command(['SET', `k${i}`, String(i)]);
      r.command(['TAG', 'k1', 't']);
      assert.equal(r.command(['GET', 'k150']), '150');
      assert.equal(r.command(['INVALIDATE', 't']), 1);
      assert.equal(r.command(['DBSIZE']), 199);
    }
    const layout = (r) => JSON.stringify(r.data.snapshot().tables[0].buckets);
    assert.notEqual(layout(a), layout(b));
  });

  test('MGET 도 hit / miss 통계에 들어간다', () => {
    const r = new MiniRedis();
    r.command(['SET', 'a', '1']);
    r.command(['MGET', 'a', 'nope', 'a']);
    assert.equal(r.stats.hits, 2);
    assert.equal(r.stats.misses, 1);
  });

  test('너무 큰 만료 값은 에러 (AOF 에 복원할 수 없는 숫자가 남지 않게)', () => {
    const r = new MiniRedis();
    r.command(['SET', 'a', '1']);
    assert.throws(() => r.command(['EXPIRE', 'a', String(Number.MAX_SAFE_INTEGER)]), /너무 큽니다/);
    assert.throws(() => r.command(['SET', 'b', '1', 'EX', String(Number.MAX_SAFE_INTEGER)]), /너무 큽니다/);
    assert.equal(r.command(['TTL', 'a']), -1);
    assert.equal(r.command(['EXISTS', 'b']), 0);
  });

  test('AOF 자동 재작성: 같은 키를 계속 덮어써도 파일이 끝없이 커지지 않는다', () => {
    const dir = tmp('miniredis-auto');
    const path = join(dir, 'r.aof');
    try {
      const { redis, aof } = openPersistentRedis(path, { fsync: 'no', autoRewriteMinSize: 2000 });
      redis.command(['SET', 'keep', 'x', 'PX', '100000000']);
      redis.command(['TAG', 'keep', 'grp']);
      for (let i = 0; i < 3000; i++) redis.command(['SET', 'counter', String(i)]);
      assert.ok(aof.rewrites >= 1, '자동 재작성이 일어나야 한다');
      aof.flush();
      assert.ok(statSync(path).size < 10000, `파일이 작게 유지돼야 한다 (${statSync(path).size})`);
      aof.close();
      // 다시 열어도 값 · TTL · 태그가 그대로
      const again = openPersistentRedis(path, { fsync: 'always' });
      assert.equal(again.redis.command(['GET', 'counter']), '2999');
      assert.ok(again.redis.command(['PTTL', 'keep']) > 0);
      assert.equal(again.redis.command(['INVALIDATE', 'grp']), 1);
      again.aof.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AOF 자동 재작성은 여러 키를 건드리는 명령 도중에 일어나도 결과가 같다', () => {
    const dir = tmp('miniredis-mid');
    const path = join(dir, 'r.aof');
    try {
      const { redis, aof } = openPersistentRedis(path, { fsync: 'always', autoRewriteMinSize: 1 });
      const pairs = [];
      for (let i = 0; i < 50; i++) pairs.push(`k${i}`, `v${i}`);
      redis.command(['MSET', ...pairs]); // 키마다 기록 → 그때마다 재작성
      redis.command(['DEL', ...Array.from({ length: 25 }, (_, i) => `k${i}`)]);
      assert.ok(aof.rewrites >= 3, `재작성 ${aof.rewrites}번`);
      aof.close();
      const again = openPersistentRedis(path, { fsync: 'always' });
      assert.equal(again.redis.command(['DBSIZE']), 25);
      assert.equal(again.redis.command(['GET', 'k49']), 'v49');
      assert.equal(again.redis.command(['GET', 'k0']), null);
      again.aof.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('miniDBMS 안정성', () => {
  test('여러 문장 중 하나가 실패하면 앞 문장의 INSERT 도 되돌린다 (메모리)', () => {
    const storage = new MemoryStorage(SCHEMA);
    const db = new Database(storage);
    db.execute("INSERT INTO users (name, age) VALUES ('a', 1)");
    assert.throws(() => db.execute("INSERT INTO users (name, age) VALUES ('b', 2), ('c', 3); SELECT nope FROM users"));
    assert.equal(db.execute('SELECT * FROM users')[0].rows.length, 1);
    assert.equal(storage.text('users'), '1,a,1');
    // id 도 이어서 2 부터
    assert.deepEqual(db.execute("INSERT INTO users (name, age) VALUES ('d', 4)")[0].ids, [2]);
    db.tables.users.index.check();
  });

  test('여러 문장 중 하나가 실패하면 앞 문장의 INSERT 도 되돌린다 (파일)', () => {
    const dir = tmp('minidb-rollback');
    try {
      const storage = new FileStorage(dir, { schema: SCHEMA });
      const db = new Database(storage);
      db.execute("INSERT INTO users (name, age) VALUES ('a', 1)");
      const before = readFileSync(join(dir, 'users.tbl'), 'utf8');
      assert.throws(() => db.execute("INSERT INTO users (name, age) VALUES ('b', 2); INSERT INTO users (name, age) VALUES ('c', 'x')"));
      assert.equal(readFileSync(join(dir, 'users.tbl'), 'utf8'), before);
      assert.deepEqual(db.execute('SELECT id FROM users WHERE id >= 1')[0].rows, [[1]]);
      assert.deepEqual(db.execute("INSERT INTO users (name, age) VALUES ('d', 4)")[0].ids, [2]);
      assert.deepEqual(db.execute('SELECT name FROM users WHERE id = 2')[0].rows, [['d']]);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('쓰다 만 마지막 줄은 열 때 잘라 낸다 → 다음 INSERT 가 그 줄에 이어 붙지 않는다', () => {
    const dir = tmp('minidb-torn');
    try {
      let storage = new FileStorage(dir, { schema: SCHEMA });
      let db = new Database(storage);
      db.execute("INSERT INTO users (name, age) VALUES ('a', 1), ('b', 2)");
      storage.close();
      appendFileSync(join(dir, 'users.tbl'), '3,"cho'); // 서버가 쓰는 도중 죽음

      storage = new FileStorage(dir);
      assert.equal(storage.repaired, 1);
      db = new Database(storage);
      assert.equal(db.info().users.rows, 2);
      assert.deepEqual(db.execute("INSERT INTO users (name, age) VALUES ('c', 3)")[0].ids, [3]);
      storage.close();

      // 다시 켜도 세 줄이 온전하다
      storage = new FileStorage(dir);
      assert.equal(storage.repaired, 0);
      db = new Database(storage);
      assert.deepEqual(db.execute('SELECT * FROM users')[0].rows, [[1, 'a', 1], [2, 'b', 2], [3, 'c', 3]]);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('줄바꿈만 빠진 온전한 마지막 줄은 버리지 않고 줄바꿈을 붙인다', () => {
    const dir = tmp('minidb-nonl');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      appendFileSync(join(dir, 'users.tbl'), '1,a,1\n2,b,2'); // 손으로 만든 파일
      const storage = new FileStorage(dir);
      const db = new Database(storage);
      assert.equal(db.info().users.rows, 2);
      db.execute("INSERT INTO users (name, age) VALUES ('c', 3)");
      storage.close();
      assert.equal(readFileSync(join(dir, 'users.tbl'), 'utf8'), '1,a,1\n2,b,2\n3,c,3\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('파일 전체가 쓰다 만 한 줄이어도 정리된다', () => {
    const dir = tmp('minidb-only');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      appendFileSync(join(dir, 'users.tbl'), '1,"a');
      const storage = new FileStorage(dir);
      const db = new Database(storage);
      assert.equal(db.info().users.rows, 0);
      assert.deepEqual(db.execute("INSERT INTO users (name, age) VALUES ('a', 1)")[0].ids, [1]);
      storage.close();
      assert.equal(readFileSync(join(dir, 'users.tbl'), 'utf8'), '1,a,1\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('테이블 이름의 대소문자가 달라도 같은 쓰기 락 → 동시 INSERT 에서 id 가 겹치지 않는다', async () => {
    const dir = tmp('minidb-case');
    const svc = createDbService({ dir, workers: 2 });
    try {
      await svc.ready();
      const many = (table) => `INSERT INTO ${table} (name, age, email) VALUES ` + Array.from({ length: 500 }, (_, i) => `('u${i}', ${i % 90}, 'e${i}')`).join(',');
      await Promise.all([
        svc.query(many('users'), { delayMs: 30 }),
        svc.query(many('USERS'), { delayMs: 30 }),
        svc.query(many('Users'), { delayMs: 30 }),
      ]);
      const ids = (await svc.query('SELECT id FROM users')).results[0].rows.map((r) => r[0]);
      assert.equal(ids.length, 1500);
      assert.equal(new Set(ids).size, 1500, 'id 가 겹치면 안 된다');
      // 어느 워커가 받아도 모든 id 를 인덱스로 찾는다
      for (const id of [1, 500, 501, 1000, 1001, 1500]) {
        for (let k = 0; k < 2; k++) {
          const r = await svc.query(`SELECT id FROM USERS WHERE id = ${id}`);
          assert.deepEqual(r.results[0].rows, [[id]], `id ${id}`);
        }
      }
      assert.deepEqual(Object.keys(svc.locks.state()), ['users']);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('서비스: 실패한 요청의 INSERT 는 남지 않고, 다른 워커의 id 도 어긋나지 않는다', async () => {
    const dir = tmp('minidb-svc-rollback');
    const svc = createDbService({ dir, workers: 2 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x')");
      await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('b', 2, 'b@x'); SELECT nope FROM users"));
      for (let k = 0; k < 4; k++) {
        const r = await svc.query("INSERT INTO users (name, age, email) VALUES ('n', 3, 'n@x')");
        assert.deepEqual(r.results[0].ids, [2 + k]);
      }
      const rows = (await svc.query('SELECT id, name FROM users')).results[0].rows;
      assert.deepEqual(rows, [[1, 'a'], [2, 'n'], [3, 'n'], [4, 'n'], [5, 'n']]);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
