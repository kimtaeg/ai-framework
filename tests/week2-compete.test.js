/**
 * 2주차 — 성능 개선 3차의 회귀 테스트
 *   선형 탐색의 값 사전 검색(scanFor) · id 만 읽어 인덱스 만들기(eachId) · 쓰기 묶음(group commit)
 *   · 읽기 요청의 빠른 길 · 워커가 만든 JSON 응답
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../mini_DBMS/engine.js';
import { SqlError } from '../mini_DBMS/sql.js';
import { MemoryStorage } from '../mini_DBMS/storage.js';
import { FileStorage } from '../mini_DBMS/storage-file.js';
import { createDbService } from '../mini_DBMS/service.js';
import { startDbServer } from '../mini_DBMS/server.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const SCHEMA = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };

describe('선형 탐색: 값이 들어 있는 줄만 골라 검사 (scanFor)', () => {
  test('메모리 저장소(모든 줄을 검사)와 결과 · 읽은 줄 수가 같다', () => {
    const dir = tmp('minidb-probe');
    try {
      const file = new Database(new FileStorage(dir, { schema: SCHEMA }));
      const mem = new Database(new MemoryStorage(SCHEMA));
      const names = ['김정글', 'kim', 'lee, park', 'say "hi"', 'kimchi', ' pad', 'x', 'u7@x', 'back\\slash', '줄\n바꿈'];
      for (const db of [file, mem]) {
        for (let k = 0; k < 12; k++) {
          const rows = Array.from({ length: 400 }, (_, j) => {
            const i = k * 400 + j;
            const name = names[i % names.length].replace(/'/g, "''");
            return `('${name}', ${i % 60}, 'u${i}@x')`;
          }).join(',');
          db.execute(`INSERT INTO users (name, age, email) VALUES ${rows}`);
        }
      }
      const queries = [
        "SELECT * FROM users WHERE email = 'u777@x'",
        "SELECT id FROM users WHERE email = 'u7@x'", // 이름 열에도 같은 글자가 있다 → 골라 준 줄을 다시 검사해야 한다
        "SELECT id FROM users WHERE name = 'u7@x'",
        "SELECT id FROM users WHERE name = 'kim'", // 'kimchi' 에도 들어 있다
        "SELECT id FROM users WHERE name = '김정글' AND age = 10",
        "SELECT id FROM users WHERE name = 'kimchi' LIMIT 3",
        "SELECT id FROM users WHERE name = 'lee, park'", // 따옴표로 감싸 저장되는 값 → 평소 방식
        "SELECT id FROM users WHERE name = 'say \"hi\"' LIMIT 2",
        "SELECT id FROM users WHERE name = ' pad'",
        "SELECT id FROM users WHERE name = 'x'", // 한 글자 → 평소 방식
        "SELECT id FROM users WHERE name = 'back\\slash'",
        "SELECT id FROM users WHERE email = 'nobody@x'",
        "SELECT id FROM users WHERE name != 'kim' AND email = 'u4799@x'",
        "SELECT id FROM users WHERE email = 'u4799@x' AND name = 'kim'",
        'SELECT id FROM users WHERE age = 59',
      ];
      for (const sql of queries) {
        const a = file.execute(sql)[0], b = mem.execute(sql)[0];
        assert.deepEqual(a.rows, b.rows, sql);
        assert.equal(a.plan.type, 'full-scan');
        assert.equal(a.plan.scanned, b.plan.scanned, `읽은 줄 수: ${sql}`);
      }
      file.storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('줄바꿈 없이 끝난 마지막 줄도 찾는다', () => {
    const dir = tmp('minidb-probe-tail');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      writeFileSync(join(dir, 'users.tbl'), '1,aaa,1,first@x\n2,bbb,2,second@x\n3,ccc,3,last@x');
      const storage = new FileStorage(dir, { repair: false });
      const db = new Database(storage);
      assert.deepEqual(db.execute("SELECT id FROM users WHERE email = 'last@x'")[0].rows, [[3]]);
      assert.deepEqual(db.execute("SELECT id FROM users WHERE name = 'bbb'")[0].rows, [[2]]);
      assert.equal(db.execute("SELECT id FROM users WHERE name = 'zzz'")[0].plan.scanned, 3);
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('인덱스 만들기: id 만 읽는다 (eachId)', () => {
  test('빈 줄 · 깨진 줄 · 음수 id · 긴 줄이 섞여 있어도 줄을 통째로 읽을 때와 같은 인덱스가 된다', () => {
    const dir = tmp('minidb-ids');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      const long = 'x'.repeat(300000); // 한 번에 읽는 크기(256KB)보다 긴 줄
      const text = `1,a,1,a@x\n\nabc,not,a,row\n-3,neg,2,n@x\n7,${long},3,l@x\n12\n1.5,frac,1,f@x\n20,z,9,z@x\n`;
      writeFileSync(join(dir, 'users.tbl'), text);
      const storage = new FileStorage(dir);
      const db = new Database(storage);
      const t = db.tables.users;
      t.index.check();
      assert.deepEqual([...t.index.range()].map(([k]) => k), [-3, 1, 7, 12, 20]);
      assert.equal(t.nextId, 21);
      assert.deepEqual(db.execute('SELECT id, email FROM users WHERE id = 7')[0].rows, [[7, 'l@x']]);
      assert.deepEqual(db.execute('SELECT id, name FROM users WHERE id = 20')[0].rows, [[20, 'z']]);
      assert.deepEqual(db.execute('SELECT id, name FROM users WHERE id = -3')[0].rows, [[-3, 'neg']]);
      assert.deepEqual(db.execute("INSERT INTO users (name, age, email) VALUES ('n', 1, 'new@x')")[0].ids, [21]);
      storage.close();
      // 다시 열어도 같다
      const again = new FileStorage(dir);
      assert.equal(new Database(again).tables.users.index.size, 6);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('API 서버: 쓰기 묶음 (group commit) · 읽기 빠른 길', () => {
  for (const groupCommit of [true, false]) {
    test(`groupCommit ${groupCommit}: 동시에 온 쓰기들이 섞여도 id 가 겹치지 않고, 실패한 요청만 실패한다`, async () => {
      const dir = tmp('minidb-group');
      const svc = createDbService({ dir, workers: 3, groupCommit });
      try {
        await svc.ready();
        const jobs = [];
        for (let i = 0; i < 240; i++) {
          if (i % 12 === 5) jobs.push(svc.query(`INSERT INTO users (name, age, email) VALUES ('bad', 'x', 'b${i}@x')`)); // 값 오류
          else if (i % 12 === 9) jobs.push(svc.query(`INSERT INTO users (name, age, email) VALUES ('half', 1, 'h${i}@x'); SELECT nope FROM users`)); // 앞 문장을 쓴 뒤 실패
          else if (i % 12 === 3) jobs.push(svc.query(`INSERT INTO users (name, age, email) VALUES ('two', 1, 't${i}a@x'), ('two', 2, 't${i}b@x')`));
          else jobs.push(svc.query('INSERT INTO users (name, age, email) VALUES (?, ?, ?)', { params: [`n${i}`, i % 50, `e${i}@x`] }));
        }
        const done = await Promise.allSettled(jobs);
        const ok = done.filter((d) => d.status === 'fulfilled'), failed = done.filter((d) => d.status === 'rejected');
        assert.equal(failed.length, 40);
        for (const f of failed) assert.ok(f.reason instanceof SqlError, `${f.reason?.name}: ${f.reason?.message}`);
        const ids = ok.flatMap((d) => d.value.results[0].ids).sort((a, b) => a - b);
        assert.equal(ids.length, 200 - 20 + 40);
        assert.deepEqual(ids, Array.from({ length: ids.length }, (_, k) => k + 1), 'id 가 1부터 빠짐없이 이어진다');
        assert.equal(ok[0].value.results[0].entries, undefined, '인덱스 알림용 정보는 결과에 없다');
        // 어느 워커가 받아도 모두 찾고, 실패한 요청의 행은 없다
        for (let k = 0; k < 3; k++) {
          const all = (await svc.query('SELECT id, name FROM users')).results[0].rows;
          assert.equal(all.length, ids.length);
          assert.equal(all.some((r) => r[1] === 'bad' || r[1] === 'half'), false);
          assert.deepEqual((await svc.query(`SELECT id FROM users WHERE id = ${ids.length}`)).results[0].rows, [[ids.length]]);
          assert.deepEqual((await svc.query("SELECT name FROM users WHERE email = 'e100@x'")).results[0].rows, [['n100']]);
        }
        const st = svc.status();
        assert.equal(st.writes, 200);
        assert.deepEqual(st.locks.users, { readers: 0, writer: false, waiting: 0 });
      } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("읽기 요청: 문법 오류는 SqlError 로, 'insert' 라는 글자가 값에 있어도 정상 처리", async () => {
    const dir = tmp('minidb-read');
    const svc = createDbService({ dir, workers: 2 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('insert', 1, 'a@x'), ('plain', 2, 'b@x')");
      await assert.rejects(svc.query('SELEC * FROM users'), (e) => e instanceof SqlError && /지원하지 않는 문장/.test(e.message));
      await assert.rejects(svc.query('SELECT nope FROM users'), (e) => e instanceof SqlError);
      await assert.rejects(svc.query('SELECT * FROM users WHERE id = ?'), /params/);
      assert.deepEqual((await svc.query("SELECT id FROM users WHERE name = 'insert'")).results[0].rows, [[1]]);
      const r = await svc.query('SELECT id FROM users WHERE id = ?; SELECT name FROM users WHERE id = ?', { params: [2, 1] });
      assert.deepEqual(r.results.map((x) => x.rows), [[[2]], [['insert']]]);
      assert.equal(r.lockMs, 0);
      assert.equal(typeof r.workerId, 'number');
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('HTTP: 워커가 만든 JSON 응답이 예전과 같은 모양이다', async () => {
    const dir = tmp('minidb-http');
    const s = await startDbServer({ port: 0, dir, workers: 2 });
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${s.port}/sql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    try {
      const ins = await post({ sql: "INSERT INTO users (name, age, email) VALUES ('한글 \"따옴표\"', NULL, 'k@x')" });
      assert.equal(ins.status, 200);
      assert.deepEqual(Object.keys(ins.body).sort(), ['execMs', 'lockMs', 'results', 'waitedMs', 'workerId']);
      assert.deepEqual(Object.keys(ins.body.results[0]).sort(), ['count', 'ids', 'ms', 'table', 'type']);
      assert.deepEqual(ins.body.results[0].ids, [1]);
      for (const k of ['execMs', 'lockMs', 'waitedMs', 'workerId']) assert.equal(typeof ins.body[k], 'number', k);
      const sel = await post({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] });
      assert.deepEqual(sel.body.results[0].rows, [[1, '한글 "따옴표"', null, 'k@x']]);
      assert.equal(sel.body.results[0].plan.type, 'index-lookup');
      assert.equal((await post({ sql: 'SELEC' })).status, 400);
      assert.equal((await post({ sql: "INSERT INTO users (name, age, email) VALUES ('a', 'x', 'b')" })).status, 400);
      const slow = await post({ sql: 'SELECT id FROM users', delayMs: 30 });
      assert.deepEqual(slow.body.results[0].rows, [[1]]);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
