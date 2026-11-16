/**
 * 2주차 — 성능 개선 4차의 회귀 테스트
 *   선형 탐색의 숫자 열 사전 검사(scanNum) · 같은 SQL 재사용 · 토크나이저 가속 · 다른 워커의 보조 인덱스 갱신
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../week2/dbms/engine.js';
import { tokenize, parse, SqlError } from '../week2/dbms/sql.js';
import { MemoryStorage } from '../week2/dbms/storage.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { createDbService } from '../week2/dbms/service.js';
import { MiniRedis } from '../week2/redis/miniredis.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const SCHEMA = { items: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'qty', type: 'INT' }, { name: 'price', type: 'REAL' }, { name: 'tag', type: 'TEXT' }] } };

describe('선형 탐색: 숫자 열을 바이트에서 바로 비교 (scanNum)', () => {
  test('NULL · 음수 · 소수 · 따옴표가 있는 줄이 섞여도 모든 줄을 검사할 때와 결과 · 읽은 줄 수가 같다', () => {
    const dir = tmp('minidb-num');
    try {
      const file = new Database(new FileStorage(dir, { schema: SCHEMA }));
      const mem = new Database(new MemoryStorage(SCHEMA));
      for (const db of [file, mem]) {
        for (let k = 0; k < 10; k++) {
          const rows = Array.from({ length: 600 }, (_, j) => {
            const i = k * 600 + j;
            const name = i % 17 === 0 ? 'has, comma' : i % 23 === 0 ? 'say "q"' : `n${i % 9}`;
            const qty = i % 13 === 0 ? 'NULL' : i % 11 === 0 ? -(i % 40) : i % 40;
            const price = i % 7 === 0 ? 'NULL' : i % 5 === 0 ? (i % 30) + 0.5 : i % 30;
            return `('${name.replace(/'/g, "''")}', ${qty}, ${price}, 't${i % 4}')`;
          }).join(',');
          db.execute(`INSERT INTO items (name, qty, price, tag) VALUES ${rows}`);
        }
      }
      const queries = [
        'SELECT id FROM items WHERE qty = 7',
        'SELECT id FROM items WHERE qty = -22',
        'SELECT id FROM items WHERE qty = 0',
        'SELECT * FROM items WHERE qty = 7 AND tag = \'t3\'',
        'SELECT id FROM items WHERE qty > 35',
        'SELECT id FROM items WHERE qty >= 0', // 대부분 맞는다 → 덩어리 방식으로 바뀐다
        'SELECT id FROM items WHERE qty < -30',
        'SELECT id FROM items WHERE qty <= 1 AND qty >= -1',
        'SELECT id FROM items WHERE qty = 7 LIMIT 5',
        'SELECT id FROM items WHERE qty > 10 LIMIT 3',
        'SELECT id FROM items WHERE qty = 7.5',
        'SELECT id FROM items WHERE price = 12',
        'SELECT id FROM items WHERE price = 10.5', // 소수로 저장된 값 → 바이트만으로는 판단 못 해 평소 검사로
        'SELECT id FROM items WHERE price > 28',
        'SELECT id FROM items WHERE price < 1',
        'SELECT id FROM items WHERE qty = 4 AND price = 4',
        'SELECT id FROM items WHERE qty != 7 AND price = 3',
        'SELECT id FROM items WHERE id != 100 AND qty = 20',
        'SELECT id FROM items WHERE qty = 999',
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

  test('손으로 쓴 파일: 00012 · 12.0 · 1e1 같은 표기와 열이 모자란 줄도 예전과 같이 비교한다', () => {
    const dir = tmp('minidb-num-hand');
    try {
      new FileStorage(dir, { schema: SCHEMA }).close();
      const lines = ['1,a,12,1,x', '2,b,00012,2,x', '3,c,12.0,3,x', '4,d,1e1,4,x', '5,e', '6,"f,g",12,6,x', '7,h,\\N,7,x', '8,i,-12,8,x', '9,j,120,9,x'];
      writeFileSync(join(dir, 'items.tbl'), lines.join('\n') + '\n');
      const file = new Database(new FileStorage(dir));
      const mem = new Database(new MemoryStorage(SCHEMA));
      for (const l of lines) mem.storage.append('items', l);
      mem.loadIndexes();
      for (const sql of ['SELECT id FROM items WHERE qty = 12', 'SELECT id FROM items WHERE qty = 10', 'SELECT id FROM items WHERE qty > 11', 'SELECT id FROM items WHERE qty < 0', 'SELECT id FROM items WHERE qty <= 12']) {
        assert.deepEqual(file.execute(sql)[0].rows, mem.execute(sql)[0].rows, sql);
      }
      assert.deepEqual(file.execute('SELECT id FROM items WHERE qty = 12')[0].rows, [[1], [2], [3], [6]]);
      file.storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('같은 SQL 재사용 (파싱 캐시)', () => {
  test('같은 문장을 여러 번 실행해도 결과가 맞고, 앞 실행이 뒤 실행에 영향을 주지 않는다', () => {
    const db = new Database(new MemoryStorage(SCHEMA));
    const ins = "INSERT INTO items (name, qty, price, tag) VALUES ('a', 1, 1.5, 't')";
    for (let k = 1; k <= 5; k++) assert.deepEqual(db.execute(ins)[0].ids, [k]);
    const sel = 'SELECT id, name FROM items WHERE id >= 2 LIMIT 2';
    const first = db.execute(sel)[0];
    first.rows.push(['변조']); // 받은 결과를 고쳐도
    first.plan.type = 'x';
    const second = db.execute(sel)[0];
    assert.deepEqual(second.rows, [[2, 'a'], [3, 'a']]); // 다음 실행은 그대로
    assert.equal(second.plan.type, 'index-range');
    // ? 가 있는 문장은 값이 달라질 수 있다
    assert.deepEqual(db.execute('SELECT id FROM items WHERE id = ?', [3])[0].rows, [[3]]);
    assert.deepEqual(db.execute('SELECT id FROM items WHERE id = ?', [4])[0].rows, [[4]]);
    // 오류가 나는 문장은 매번 오류
    for (let k = 0; k < 2; k++) assert.throws(() => db.execute('SELECT nope FROM items'), SqlError);
    for (let k = 0; k < 2; k++) assert.throws(() => db.execute('SELEC'), SqlError);
    assert.deepEqual(Database.analyze(ins).writes, ['items']);
    assert.deepEqual(Database.analyze(sel).reads, ['items']);
  });
});

describe('토크나이저', () => {
  test('토큰과 위치(줄 · 칸)가 정확하다 — 여러 줄 문자열 · 주석 · 탭 · 한글 포함', () => {
    const src = "SELECT  name,\n\tage FROM users -- 주석\nWHERE name = '여러\n줄 ''값''' AND age>=-3.5e2 /* 블록\n주석 */ LIMIT 10;";
    const t = tokenize(src);
    assert.deepEqual(t.map((x) => x.value), ['SELECT', 'name', ',', 'age', 'FROM', 'users', 'WHERE', 'name', '=', "여러\n줄 '값'", 'AND', 'age', '>=', '-', '3.5e2', 'LIMIT', '10', ';', '']);
    const at = (value) => { const x = t.find((y) => y.value === value); return [x.pos.line, x.pos.col, src.slice(x.pos.offset, x.pos.offset + 2)]; };
    assert.deepEqual(at('SELECT'), [1, 1, 'SE']);
    assert.deepEqual(at('age'), [2, 2, 'ag']);
    assert.deepEqual(at('WHERE'), [3, 1, 'WH']);
    assert.deepEqual(at("여러\n줄 '값'"), [3, 14, "'여"]);
    assert.deepEqual(at('AND'), [4, 10, 'AN']);
    assert.deepEqual(at('LIMIT'), [5, 7, 'LI']);
    // 모든 토큰의 offset 은 실제 그 자리를 가리킨다
    for (const x of t) if (x.type === 'keyword' || x.type === 'ident') assert.equal(src.slice(x.pos.offset, x.pos.offset + x.value.length).toUpperCase(), x.value.toUpperCase());
  });

  test('오류 위치와 메시지가 그대로다', () => {
    const fails = (sql, re) => assert.throws(() => parse(sql), (e) => e instanceof SqlError && re.test(e.message), sql);
    fails("SELECT * FROM t WHERE a = 'open", /따옴표가 닫히지 않았습니다. \(1행 27열\)/);
    fails('SELECT * FROM t\nWHERE a = 12abc', /잘못된 숫자 '12abc' \(2행 11열\)/);
    fails('SELECT * FROM t WHERE a @ 1', /알 수 없는 문자 '@' \(1행 25열\)/);
    fails('SELECT *\n\n  FROM', /\(3행 7열\)/);
    fails('/* 열린 주석', /주석\(\/\* \*\/\)이 닫히지 않았습니다/);
    assert.equal(parse("INSERT INTO t (a) VALUES ('')")[0].rows[0][0].value, '');
    assert.equal(parse("INSERT INTO t (a) VALUES ('''')")[0].rows[0][0].value, "'");
    assert.equal(parse('SELECT a FROM t WHERE b = .5')[0].where[0].value.value, 0.5);
  });
});

describe('다른 워커의 보조 인덱스 갱신', () => {
  test('한 번에 많이 넣어도 다른 워커의 해시 인덱스가 버려지지 않고 새 행을 찾는다', async () => {
    const dir = tmp('minidb-bulk-idx');
    const svc = createDbService({ dir, workers: 3 });
    try {
      await svc.ready();
      const rows = (from, n) => Array.from({ length: n }, (_, k) => `('n${(from + k) % 9}', ${(from + k) % 30}, 'e${from + k}@x')`).join(',');
      await svc.query(`INSERT INTO users (name, age, email) VALUES ${rows(1, 50)}`);
      const find = async (email) => (await svc.query(`SELECT id FROM users WHERE email = '${email}'`)).results[0];
      let built = 0;
      for (let k = 0; k < 6; k++) if ((await find('e10@x')).plan.built) built++;
      assert.equal(built, 3, '워커마다 한 번씩 만든다');
      // 600행을 한 번에 (예전에는 256개를 넘으면 다른 워커의 인덱스를 버렸다)
      await svc.query(`INSERT INTO users (name, age, email) VALUES ${rows(1000, 600)}`);
      for (let k = 0; k < 6; k++) {
        const r = await find(`e${1000 + k * 100}@x`);
        assert.deepEqual(r.rows, [[51 + k * 100]]);
        assert.equal(r.plan.built, undefined, '인덱스를 다시 만들지 않았다');
        assert.equal(r.plan.scanned, 1);
      }
      for (let k = 0; k < 3; k++) assert.deepEqual((await find('e1599@x')).rows, [[650]]);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('레디스: 태그 없는 키', () => {
  test('빈 태그 배열을 함께 써도 키끼리 태그가 섞이지 않는다', () => {
    const r = new MiniRedis();
    r.command(['MSET', 'a', '1', 'b', '2', 'c', '3']);
    assert.equal(r.command(['TAG', 'a', 'x', 'y']), 2);
    assert.equal(r.command(['TAG', 'b', 'y']), 1);
    const tags = Object.fromEntries(r.dump().map((e) => [e.key, e.tags]));
    assert.deepEqual(tags, { a: ['x', 'y'], b: ['y'], c: [] });
    assert.equal(r.command(['INVALIDATE', 'x']), 1);
    r.command(['SET', 'b', 'new']); // 덮어쓰면 태그가 지워진다
    assert.equal(r.command(['INVALIDATE', 'y']), 0);
    assert.equal(r.command(['TAG', 'b', 'z']), 1);
    assert.deepEqual(r.dump().map((e) => [e.key, e.tags]), [['b', ['z']], ['c', []]]);
    assert.equal(r.command(['TAG', 'c', 'z']), 1);
    assert.equal(r.command(['INVALIDATE', 'z']), 2);
    assert.equal(r.command(['DBSIZE']), 0);
  });
});
