/**
 * 2주차 미니 DBMS — Phase 1 (SQL 처리기), Phase 2 (B+ 트리)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, parse, SqlError } from '../week2/dbms/sql.js';
import { BPlusTree } from '../week2/dbms/bptree.js';
import { encodeRow, decodeRow, MemoryStorage } from '../week2/dbms/storage.js';
import { FileStorage, DEFAULT_SCHEMA } from '../week2/dbms/storage-file.js';
import { Database, formatResult } from '../week2/dbms/engine.js';
import { runCli } from '../week2/dbms/cli.js';
import { seedRows, rng } from '../week2/dbms/seed.js';
import { runBench } from '../week2/dbms/bench.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'minidb-'));
const memDb = (order = 4) => new Database(new MemoryStorage(structuredClone(DEFAULT_SCHEMA)), { order });

// ================================================================ 토크나이저 / 파서
describe('SQL 파싱', () => {
  test('토큰: 키워드(대소문자 무관), 식별자, 숫자, 문자열, 기호', () => {
    const t = tokenize("select Name from users where age >= -3.5 and x <> 'it''s'");
    assert.deepEqual(t.map((x) => x.type), ['keyword', 'ident', 'keyword', 'ident', 'keyword', 'ident', 'symbol', 'symbol', 'number', 'keyword', 'ident', 'symbol', 'string', 'eof']);
    assert.equal(t[0].value, 'SELECT');
    assert.equal(t[12].value, "it's");
  });

  test('주석과 여러 문장, 빈 문장', () => {
    const st = parse(`-- 사용자 추가
      INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x'), ('b', 2, NULL);;
      /* 여러 줄
         주석 */
      SELECT * FROM users`);
    assert.equal(st.length, 2);
    assert.equal(st[0].type, 'insert');
    assert.equal(st[0].rows.length, 2);
    assert.deepEqual(st[0].rows[1][2], { kind: 'null', value: null });
    assert.equal(st[1].columns, '*');
  });

  test('SELECT: 열 목록, WHERE 여러 조건, BETWEEN, LIMIT', () => {
    const [s] = parse('SELECT id, name FROM users WHERE age > 20 AND id BETWEEN 1 AND 9 LIMIT 3;');
    assert.deepEqual(s.columns, ['id', 'name']);
    assert.deepEqual(s.where.map((w) => [w.column, w.op, w.value.value]), [['age', '>', 20], ['id', '>=', 1], ['id', '<=', 9]]);
    assert.equal(s.limit, 3);
  });

  test('에러에는 행·열 위치가 붙는다', () => {
    const cases = [
      ["SELECT * FROM users WHERE name = 'abc", /따옴표가 닫히지/],
      ['SELECT * users', /'FROM'/],
      ['SELECT * FROM users WHERE', /열 이름/],
      ['SELECT * FROM users WHERE age ~ 1', /알 수 없는 문자/],
      ['SELECT * FROM users WHERE age 1', /비교 연산자/],
      ["INSERT INTO users (name, age) VALUES ('a')", /열은 2개인데 값은 1개/],
      ['INSERT INTO users (name, name) VALUES (1, 2)', /두 번/],
      ['DELETE FROM users', /지원하지 않는 문장/],
      ['SELECT * FROM users LIMIT 1.5', /0 이상의 정수/],
      ['SELECT * FROM select', /예약어/],
      ['SELECT * FROM users SELECT', /';'/],
      ['/* 닫히지 않음', /주석/],
      ['SELECT * FROM t WHERE a = 12abc', /잘못된 숫자/],
    ];
    for (const [sql, re] of cases) {
      assert.throws(() => parse(sql), (e) => e instanceof SqlError && re.test(e.message) && /\d+행 \d+열/.test(e.message), sql);
    }
    try {
      parse('SELECT *\nFROM users\nWHERE ? = 1');
    } catch (e) {
      assert.deepEqual([e.pos.line, e.pos.col], [3, 7]);
    }
  });
});

// ================================================================ 저장 형식
describe('저장 형식 (한 줄 = 한 레코드)', () => {
  test('쉼표·따옴표·줄바꿈·역슬래시·NULL·빈 문자열이 왕복해도 그대로', () => {
    const tricky = [[1, 'a,b', 'say "hi"', null], [2, '줄\n바꿈\r', '\\N', ''], [3, '  공백  ', 'a\\nb', '"']];
    for (const row of tricky) {
      const line = encodeRow(row);
      assert.ok(!line.includes('\n'), '한 줄');
      assert.deepEqual(decodeRow(line), row.map((v) => (v === null ? null : String(v))));
    }
  });

  test('무작위 문자열 2,000개 왕복', () => {
    const rand = rng(3);
    const chars = 'ab,"\\\n\r N한 ';
    for (let i = 0; i < 2000; i++) {
      const row = Array.from({ length: 4 }, () => (rand() < 0.1 ? null : Array.from({ length: Math.floor(rand() * 8) }, () => chars[Math.floor(rand() * chars.length)]).join('')));
      assert.deepEqual(decodeRow(encodeRow(row)), row);
    }
  });

  test('깨진 레코드는 에러', () => {
    assert.throws(() => decodeRow('"abc'), /닫히지/);
    assert.throws(() => decodeRow('"abc"x,1'), /쉼표/);
  });
});

// ================================================================ B+ 트리
describe('B+ 트리', () => {
  test('차수 3~8, 무작위 2,000개 삽입 후 구조 검사 + 전부 찾기', () => {
    for (let order = 3; order <= 8; order++) {
      const t = new BPlusTree(order);
      const rand = rng(order);
      const keys = [...Array(2000).keys()].map((k) => k + 1);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      for (const k of keys) t.insert(k, `v${k}`);
      assert.equal(t.check(), true);
      assert.equal(t.size, 2000);
      for (const k of keys) assert.equal(t.get(k), `v${k}`);
      assert.equal(t.get(0), undefined);
      assert.equal(t.get(2001), undefined);
      assert.equal(t.min(), 1);
      assert.equal(t.max(), 2000);
    }
  });

  test('순서대로 넣어도(자동 증가 id) 균형 유지, 높이는 log 수준', () => {
    const t = new BPlusTree(64);
    for (let i = 1; i <= 100_000; i++) t.insert(i, i);
    t.check();
    assert.ok(t.height <= 4, `높이 ${t.height}`);
  });

  test('범위 검색은 리프 연결을 따라 정렬된 순서로', () => {
    const t = new BPlusTree(4);
    for (const k of [50, 10, 30, 20, 40, 60, 70, 5]) t.insert(k, k * 10);
    assert.deepEqual([...t.range(15, 55)].map(([k]) => k), [20, 30, 40, 50]);
    assert.deepEqual([...t.range(71, 100)], []);
    assert.deepEqual([...t.range()].map(([k]) => k), [5, 10, 20, 30, 40, 50, 60, 70]);
  });

  test('분할: 넘치면 쪼개고 높이가 1 늘어난다', () => {
    const t = new BPlusTree(3); // 노드당 키 최대 2개
    t.insert(1, 'a');
    t.insert(2, 'b');
    assert.equal(t.height, 1);
    t.insert(3, 'c');
    assert.equal(t.height, 2);
    // 넘친 리프 [1,2,3] → [1,2] | [3], 오른쪽 첫 키 3 이 부모로 '복사' 되어 올라감
    assert.deepEqual(t.levels(), [[{ keys: [3], leaf: false }], [{ keys: [1, 2], leaf: true }, { keys: [3], leaf: true }]]);
    assert.equal(t.stats.splits, 1);
  });

  test('trace: 루트에서 리프까지 지나간 노드', () => {
    const t = new BPlusTree(3);
    for (let i = 1; i <= 20; i++) t.insert(i, i);
    const tr = t.trace(13);
    assert.equal(tr.found, true);
    assert.equal(tr.path.length, t.height);
    assert.equal(t.trace(99).found, false);
  });

  test('중복 키, 숫자가 아닌 키, 잘못된 차수는 에러', () => {
    const t = new BPlusTree(4);
    t.insert(1, 'a');
    assert.throws(() => t.insert(1, 'b'), /이미 있는 키/);
    assert.throws(() => t.insert('1', 'b'), TypeError);
    assert.throws(() => new BPlusTree(2), RangeError);
  });
});

// ================================================================ 실행기
describe('실행기 (메모리 저장소)', () => {
  test('INSERT 는 id 를 1부터 자동 부여, SELECT * 로 확인', () => {
    const db = memDb();
    const [ins] = db.execute("INSERT INTO users (name, age, email) VALUES ('a', 20, 'a@x'), ('b', 30, NULL)");
    assert.deepEqual(ins.ids, [1, 2]);
    const [sel] = db.execute('SELECT * FROM users');
    assert.deepEqual(sel.columns, ['id', 'name', 'age', 'email']);
    assert.deepEqual(sel.rows, [[1, 'a', 20, 'a@x'], [2, 'b', 30, null]]);
  });

  test('열 이름 없이 INSERT 하면 id 를 뺀 순서대로, 열 순서를 바꿔 써도 OK', () => {
    const db = memDb();
    db.execute("INSERT INTO users VALUES ('a', 1, 'a@x'); INSERT INTO users (email, name) VALUES ('b@x', 'b')");
    assert.deepEqual(db.execute('SELECT * FROM users')[0].rows, [[1, 'a', 1, 'a@x'], [2, 'b', null, 'b@x']]);
  });

  test('실행 계획: id = ? 는 인덱스, id 범위는 인덱스 범위, 다른 열은 선형 탐색', () => {
    const db = memDb();
    seedRows(db, 'users', 500);
    const by = (sql) => db.execute(sql)[0];
    const a = by('SELECT * FROM users WHERE id = 250');
    assert.equal(a.plan.type, 'index-lookup');
    assert.equal(a.plan.scanned, 1, '레코드 하나만 읽음');
    assert.equal(a.rows[0][0], 250);
    const b = by('SELECT id FROM users WHERE id BETWEEN 100 AND 109');
    assert.equal(b.plan.type, 'index-range');
    assert.equal(b.plan.scanned, 10);
    assert.deepEqual(b.rows.map((r) => r[0]), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    const c = by("SELECT * FROM users WHERE email = 'user250@jungle.test'");
    assert.equal(c.plan.type, 'full-scan');
    assert.equal(c.plan.scanned, 500, '전부 읽음');
    assert.deepEqual(c.rows, a.rows, '같은 레코드');
  });

  test('id 범위 경계: >, <, 실수 값, 모순 조건', () => {
    const db = memDb();
    seedRows(db, 'users', 20);
    const ids = (sql) => db.execute(sql)[0].rows.map((r) => r[0]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id > 17'), [18, 19, 20]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id < 3'), [1, 2]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id > 2.5 AND id < 4.2'), [3, 4]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id > 10 AND id < 5'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 3 AND id = 4'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 999'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id != 1 LIMIT 2'), [2, 3]);
  });

  test('비교 연산, NULL 비교, LIMIT 0', () => {
    const db = memDb();
    db.execute("INSERT INTO users (name, age, email) VALUES ('a', 10, NULL), ('b', 20, 'b@x'), ('c', 30, 'c@x')");
    const names = (sql) => db.execute(sql)[0].rows.map((r) => r[0]);
    assert.deepEqual(names('SELECT name FROM users WHERE age >= 20'), ['b', 'c']);
    assert.deepEqual(names('SELECT name FROM users WHERE age < 20'), ['a']);
    assert.deepEqual(names("SELECT name FROM users WHERE name != 'b'"), ['a', 'c']);
    assert.deepEqual(names('SELECT name FROM users WHERE email = NULL'), ['a']);
    assert.deepEqual(names('SELECT name FROM users WHERE email != NULL'), ['b', 'c']);
    assert.deepEqual(names('SELECT name FROM users LIMIT 0'), []);
  });

  test('없는 테이블·열, 형이 안 맞는 값, id 직접 넣기는 에러', () => {
    const db = memDb();
    assert.throws(() => db.execute('SELECT * FROM nope'), /테이블 'nope'/);
    assert.throws(() => db.execute('SELECT nope FROM users'), /열 'nope'/);
    assert.throws(() => db.execute("INSERT INTO users (name, age) VALUES ('a', 'x')"), /정수\(INT\)/);
    assert.throws(() => db.execute('INSERT INTO users (name, age) VALUES (1, 1.5)'), /정수/);
    assert.throws(() => db.execute("INSERT INTO users (id, name) VALUES (5, 'a')"), /자동으로 부여/);
    assert.throws(() => db.execute("SELECT * FROM users WHERE age = 'x'"), /정수/);
  });

  test('여러 행 INSERT 중 하나라도 틀리면 아무것도 저장하지 않는다', () => {
    const db = memDb();
    assert.throws(() => db.execute("INSERT INTO users (name, age) VALUES ('ok', 1), ('bad', 'x')"));
    assert.equal(db.execute('SELECT * FROM users')[0].rows.length, 0);
    assert.equal(db.tables.users.nextId, 1, 'id 도 소비하지 않음');
  });

  test('테이블 이름은 대소문자 무관, 숫자를 TEXT 열에 넣으면 문자열로', () => {
    const db = memDb();
    db.execute('INSERT INTO USERS (name, age) VALUES (123, 1)');
    assert.deepEqual(db.execute('SELECT name FROM Users')[0].rows, [['123']]);
  });

  test('formatResult: 표 + 실행 계획 요약', () => {
    const db = memDb();
    db.execute("INSERT INTO users (name, age, email) VALUES ('김정글', 1, NULL)");
    const out = formatResult(db.execute('SELECT * FROM users WHERE id = 1')[0]);
    assert.match(out, /김정글/);
    assert.match(out, /NULL/);
    assert.match(out, /B\+ 트리 인덱스 조회/);
  });
});

// ================================================================ 파일 저장소
describe('파일 저장소', () => {
  test('다시 열면 파일을 읽어 인덱스를 재구성하고 id 가 이어진다', () => {
    const dir = tmp();
    try {
      let s = new FileStorage(dir);
      let db = new Database(s);
      db.execute("INSERT INTO users (name, age, email) VALUES ('한글이름', 1, 'a@x'), ('b', 2, 'b,c@x')");
      s.close();
      s = new FileStorage(dir);
      db = new Database(s);
      assert.equal(db.tables.users.index.size, 2);
      const [ins] = db.execute("INSERT INTO users (name) VALUES ('c')");
      assert.deepEqual(ins.ids, [3]);
      assert.deepEqual(db.execute('SELECT name, email FROM users WHERE id = 2')[0].rows, [['b', 'b,c@x']]);
      assert.deepEqual(db.execute('SELECT name FROM users WHERE id = 1')[0].rows, [['한글이름']]);
      s.close();
      assert.equal(readFileSync(join(dir, 'users.tbl'), 'utf8').split('\n').filter(Boolean).length, 3);
      assert.ok(JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')).users);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('64KB 보다 긴 레코드도 읽기·훑기가 정확하다 (덩어리 경계)', () => {
    const dir = tmp();
    try {
      const s = new FileStorage(dir);
      const db = new Database(s);
      const long = '가나다'.repeat(40_000); // 약 360KB
      db.execute(`INSERT INTO users (name, email) VALUES ('${long}', 'x'), ('short', 'y')`);
      assert.equal(db.execute('SELECT name FROM users WHERE id = 1')[0].rows[0][0], long);
      assert.deepEqual(db.execute("SELECT id FROM users WHERE email = 'y'")[0].rows, [[2]]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ================================================================ CLI
describe('CLI', () => {
  const cli = (args) => {
    const out = [], err = [];
    const code = runCli(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  test('SQL 파일 실행 → 표 출력, exec, info, --json', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'q.sql');
      writeFileSync(file, "INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x');\nSELECT * FROM users WHERE id = 1;\n");
      const r = cli(['run', file, '--data', join(dir, 'db')]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /INSERT 1건/);
      assert.match(r.out, /\| 1  \| a/);
      const j = cli(['exec', 'SELECT name FROM users', '--data', join(dir, 'db'), '--json']);
      assert.deepEqual(JSON.parse(j.out)[0].rows, [['a']]);
      assert.match(cli(['info', '--data', join(dir, 'db')]).out, /users: 1행/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('seed 로 대용량 생성, 에러는 종료 코드 1', () => {
    const dir = tmp();
    try {
      const r = cli(['seed', 'users', '5000', '--data', dir]);
      assert.equal(r.code, 0, r.err);
      assert.match(cli(['info', '--data', dir]).out, /5,000행/);
      assert.equal(cli(['exec', 'SELEC 1', '--data', dir]).code, 1);
      assert.equal(cli(['run', join(dir, 'none.sql'), '--data', dir]).code, 1);
      assert.equal(cli(['seed', 'users', 'abc', '--data', dir]).code, 1);
      assert.equal(cli(['what', '--data', dir]).code, 1);
      assert.equal(cli(['info', '--data']).code, 1);
      assert.equal(cli(['info', '--data', '--json']).code, 1);
      assert.equal(cli([]).code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ================================================================ 성능
describe('성능 비교 (작은 규모)', () => {
  test('3만 건: id 로 찾기(B+ 트리)가 선형 탐색보다 훨씬 빠르다', () => {
    const dir = tmp();
    try {
      const r = runBench({ rows: 30_000, queries: 100, scans: 3, dir, log: () => {} });
      assert.equal(r.found, true);
      assert.ok(r.speedup > 20, `${r.speedup.toFixed(1)}배`);
      assert.equal(r.rangeRows, 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
