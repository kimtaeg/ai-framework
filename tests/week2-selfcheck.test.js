/**
 * 2주차 — 스스로 찾아 고친 문제의 회귀 테스트
 *   서버가 켜진 동안 다른 프로그램(CLI)이 같은 폴더에 INSERT 한 경우 · 큰 INSERT 여러 개가 동시에 온 경우
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { createDbService } from '../week2/dbms/service.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

describe('다른 프로그램이 같은 폴더에 썼을 때', () => {
  /** CLI 가 하는 일: 같은 폴더를 따로 열어 실행하고 닫는다 */
  const outside = (dir, sql) => {
    const storage = new FileStorage(dir);
    try {
      return new Database(storage).execute(sql);
    } finally {
      storage.close();
    }
  };

  test('서버가 켜진 동안 CLI 가 INSERT 해도 id 가 겹치지 않고, 그 행을 모든 워커가 찾는다', async () => {
    const dir = tmp('minidb-outside');
    const svc = createDbService({ dir, workers: 3 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('s1', 1, 's1@x')");
      for (let k = 0; k < 3; k++) await svc.query("SELECT id FROM users WHERE email = 's1@x'"); // 워커마다 해시 인덱스를 만들어 둔다
      assert.deepEqual(outside(dir, "INSERT INTO users (name, age, email) VALUES ('cli1', 2, 'c1@x'), ('cli2', 3, 'c2@x')")[0].ids, [2, 3]);
      const r = await svc.query("INSERT INTO users (name, age, email) VALUES ('s2', 4, 's2@x')");
      assert.deepEqual(r.results[0].ids, [4], '예전에는 CLI 가 쓴 것을 몰라서 2 를 다시 부여했다');
      for (let k = 0; k < 6; k++) {
        assert.deepEqual((await svc.query('SELECT id, name FROM users')).results[0].rows, [[1, 's1'], [2, 'cli1'], [3, 'cli2'], [4, 's2']]);
        assert.deepEqual((await svc.query('SELECT name FROM users WHERE id = 3')).results[0].rows, [['cli2']]);
        assert.deepEqual((await svc.query("SELECT id FROM users WHERE email = 'c1@x'")).results[0].rows, [[2]]);
      }
      // 한 번 더: CLI → 실패하는 서버 요청(되돌림) → 성공하는 서버 요청
      outside(dir, "INSERT INTO users (name, age, email) VALUES ('cli3', 5, 'c3@x')");
      await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('half', 1, 'h@x'); SELECT nope FROM users"));
      assert.deepEqual((await svc.query("INSERT INTO users (name, age, email) VALUES ('s3', 6, 's3@x')")).results[0].ids, [6]);
      for (let k = 0; k < 3; k++) {
        const rows = (await svc.query('SELECT id, name FROM users WHERE id >= 5')).results[0].rows;
        assert.deepEqual(rows, [[5, 'cli3'], [6, 's3']]);
      }
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // 다시 열어도 같다
  });

  test('엔진 두 개가 번갈아 써도 (서로 닫지 않고) id 가 이어진다', () => {
    const dir = tmp('minidb-two');
    try {
      const sa = new FileStorage(dir), sb = new FileStorage(dir, { repair: false });
      const a = new Database(sa), b = new Database(sb);
      const ids = [];
      for (let k = 0; k < 6; k++) ids.push(...(k % 2 ? b : a).execute(`INSERT INTO users (name, age, email) VALUES ('n${k}', ${k}, 'e${k}@x')`)[0].ids);
      assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
      assert.throws(() => a.execute("INSERT INTO users (name, age, email) VALUES ('x', 1, 'x'); SELECT nope FROM users"));
      assert.deepEqual(b.execute("INSERT INTO users (name, age, email) VALUES ('n6', 6, 'e6@x')")[0].ids, [7]);
      assert.deepEqual(a.execute("INSERT INTO users (name, age, email) VALUES ('n7', 7, 'e7@x')")[0].ids, [8]);
      a.tables.users.index.check();
      b.tables.users.index.check();
      sa.close(); sb.close();
      const again = new FileStorage(dir);
      assert.deepEqual(new Database(again).execute('SELECT id, name FROM users')[0].rows.map((r) => r[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('큰 INSERT 여러 개가 동시에', () => {
  test('묶음이 크기로 나뉘어도 모두 성공하고 id 가 이어진다', async () => {
    const dir = tmp('minidb-biggroup');
    const svc = createDbService({ dir, workers: 2, maxRows: 1_000_000 });
    try {
      await svc.ready();
      const big = (tag) => 'INSERT INTO users (name, age, email) VALUES ' + Array.from({ length: 3000 }, (_, i) => `('${tag}', ${i % 50}, '${tag}-${i}@example.com')`).join(',');
      const small = (i) => `INSERT INTO users (name, age, email) VALUES ('small', 1, 's${i}@x')`;
      const jobs = [];
      for (let i = 0; i < 12; i++) {
        jobs.push(svc.query(big(`b${i}`)));
        for (let j = 0; j < 5; j++) jobs.push(svc.query(small(i * 5 + j)));
      }
      const done = await Promise.all(jobs);
      const ids = done.flatMap((d) => d.results[0].ids).sort((x, y) => x - y);
      assert.equal(ids.length, 12 * 3000 + 60);
      assert.equal(ids[0], 1);
      assert.equal(ids[ids.length - 1], ids.length);
      assert.equal(new Set(ids).size, ids.length);
      for (let k = 0; k < 2; k++) assert.equal((await svc.query('SELECT id FROM users')).results[0].rows.length, ids.length);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
