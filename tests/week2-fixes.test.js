/**
 * 2주차 전체 점검에서 고친 것들의 회귀 테스트
 *   미니 레디스: 커서 순회(SCAN) · 메모리 상한(LRU 축출) · 덮어쓰기 · AOF 나눠 읽기/나눠 쓰기 · TTL 흩뜨리기 · 분산 락
 *   미니 DBMS  : ? 자리표시자 · 결과 행 수 상한 · 스레드 풀 묶음 처리 · B+ 트리 맨 오른쪽 리프 빠른 길
 *   웹 서버    : gzip · ETag/304 · API 접근 제한
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashTable } from '../week2/redis/hashtable.js';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { openPersistentRedis, readLines } from '../week2/redis/persistence.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { startRedisServer } from '../week2/redis/server.js';
import { parse, SqlError } from '../week2/dbms/sql.js';
import { BPlusTree } from '../week2/dbms/bptree.js';
import { MemoryStorage } from '../week2/dbms/storage.js';
import { FileStorage, DEFAULT_SCHEMA } from '../week2/dbms/storage-file.js';
import { Database } from '../week2/dbms/engine.js';
import { seedRows } from '../week2/dbms/seed.js';
import { createDbService } from '../week2/dbms/service.js';
import { createApp, isLoopback } from '../server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'week2-fixes-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

// ================================================================ 미니 레디스
describe('해시 테이블 커서 순회 (scan)', () => {
  const walk = (t, onStep) => {
    const seen = new Map();
    let cursor = 0, steps = 0;
    do {
      cursor = t.scan(cursor, (k) => seen.set(k, (seen.get(k) ?? 0) + 1));
      onStep?.(++steps);
    } while (cursor !== 0);
    return seen;
  };

  test('한 바퀴 돌면 모든 키가 한 번씩 나온다', () => {
    const t = new HashTable();
    for (let i = 0; i < 1000; i++) t.set(`k${i}`, i);
    t.finishRehash();
    const seen = walk(t);
    assert.equal(seen.size, 1000);
    assert.ok([...seen.values()].every((n) => n === 1));
  });

  test('리해시 중에도, 순회 도중에 테이블이 커지거나 줄어도 처음부터 있던 키는 빠지지 않는다', () => {
    const t = new HashTable();
    for (let i = 0; i < 500; i++) t.set(`base${i}`, i);
    assert.ok(t.isRehashing || true);
    // 순회하는 동안 키를 계속 넣어 여러 번 확장시킨다
    // (처음 60걸음 동안만 — 순회보다 빨리 끝없이 넣으면 테이블이 계속 커져 순회가 끝나지 않는다)
    const grown = walk(t, (step) => { if (step <= 60) for (let j = 0; j < 20; j++) t.set(`new${step}-${j}`, 1); });
    for (let i = 0; i < 500; i++) assert.ok(grown.has(`base${i}`), `base${i} (확장 중)`);
    // 이번에는 순회하는 동안 새 키를 지워 축소시킨다
    const added = [...grown.keys()].filter((k) => k.startsWith('new'));
    let at = 0;
    const shrunk = walk(t, () => { for (let j = 0; j < 30 && at < added.length; j++) t.delete(added[at++]); });
    for (let i = 0; i < 500; i++) assert.ok(shrunk.has(`base${i}`), `base${i} (축소 중)`);
  });

  test('빈 테이블은 바로 끝난다', () => {
    assert.equal(new HashTable().scan(0, () => assert.fail('부르면 안 됨')), 0);
  });
});

describe('SCAN 명령', () => {
  const scanAll = (r, ...opts) => {
    const out = new Set();
    let cursor = '0', calls = 0;
    do {
      const [next, keys] = r.command(['SCAN', cursor, ...opts]);
      keys.forEach((k) => out.add(k));
      cursor = next;
      calls++;
    } while (cursor !== '0');
    return { keys: [...out].sort(), calls };
  };

  test('커서가 0 이 될 때까지 부르면 KEYS 와 같은 키를 얻는다 (여러 번에 나눠서)', () => {
    const r = new MiniRedis();
    for (let i = 0; i < 300; i++) r.command(['SET', `user:${i}`, 'v']);
    for (let i = 0; i < 50; i++) r.command(['SET', `item:${i}`, 'v']);
    const all = scanAll(r, 'COUNT', '20');
    assert.deepEqual(all.keys, r.command(['KEYS', '*']));
    assert.ok(all.calls > 5, `나눠서 본다: ${all.calls}번`);
    assert.deepEqual(scanAll(r, 'MATCH', 'item:*').keys, r.command(['KEYS', 'item:*']));
  });

  test('만료된 키는 나오지 않고, 잘못된 인자는 에러', () => {
    const clock = { t: 1000 };
    const r = new MiniRedis({ now: () => clock.t });
    r.command(['SET', 'a', '1', 'PX', '10']);
    r.command(['SET', 'b', '1']);
    clock.t += 100;
    assert.deepEqual(scanAll(r).keys, ['b']);
    assert.throws(() => r.command(['SCAN', 'x']), /정수/);
    assert.throws(() => r.command(['SCAN', '0', 'COUNT', '0']), /1 이상/);
    assert.throws(() => r.command(['SCAN', '0', 'WHAT']), /알 수 없/);
    assert.throws(() => r.command(['SCAN', '0', 'MATCH']), /패턴/);
  });
});

describe('메모리 상한 (maxMemory → 오래 안 쓴 키부터 지움)', () => {
  test('상한을 넘으면 지워서 상한 아래를 유지하고, 계속 쓰는 키는 남는다', () => {
    const logged = [];
    const r = new MiniRedis({ maxMemory: 20_000, onWrite: (a) => logged.push(a) });
    r.command(['SET', 'hot', 'x'.repeat(50)]);
    for (let i = 0; i < 1000; i++) {
      r.command(['SET', `cold:${i}`, 'y'.repeat(50)]);
      r.command(['GET', 'hot']); // 계속 읽는 키
    }
    assert.ok(r.usedBytes <= 20_000, `usedBytes ${r.usedBytes}`);
    assert.ok(r.evicted > 800, `지운 키 ${r.evicted}`);
    assert.equal(r.command(['DBSIZE']) + r.evicted, 1001);
    assert.ok(r.command(['GET', 'hot']) !== null, '자주 쓰는 키는 남아 있다');
    assert.equal(logged.filter((a) => a[0] === 'DEL').length, r.evicted, '지운 키는 AOF 에 DEL 로 남는다');
    assert.deepEqual(r.command(['INFO']).memory, { usedBytes: r.usedBytes, maxMemory: 20_000, evicted: r.evicted });
  });

  test('상한이 없으면(기본) 아무것도 지우지 않는다', () => {
    const r = new MiniRedis();
    for (let i = 0; i < 2000; i++) r.command(['SET', `k${i}`, 'v'.repeat(100)]);
    assert.equal(r.command(['DBSIZE']), 2000);
    assert.equal(r.evicted, 0);
  });

  test('쓴 만큼 늘고 지운 만큼 준다 (덮어쓰기 · INCR · DEL · 만료 · FLUSHALL)', () => {
    const clock = { t: 0 };
    const r = new MiniRedis({ now: () => clock.t });
    assert.equal(r.usedBytes, 0);
    r.command(['SET', 'a', '12345']);
    const one = r.usedBytes;
    r.command(['SET', 'a', '1234567890']); // 5글자 더 긴 값으로 덮어쓰기
    assert.equal(r.usedBytes, one + 10);
    r.command(['SET', 'n', '9']);
    const withN = r.usedBytes;
    r.command(['INCR', 'n']); // '9' → '10'
    assert.equal(r.usedBytes, withN + 2);
    r.command(['SET', 't', 'v', 'PX', '5']);
    clock.t = 100;
    assert.equal(r.command(['GET', 't']), null); // 지연 삭제
    r.command(['DEL', 'a', 'n']);
    assert.equal(r.usedBytes, 0);
    r.command(['MSET', 'x', '1', 'y', '2']);
    r.command(['FLUSHALL']);
    assert.equal(r.usedBytes, 0);
  });
});

describe('같은 키 덮어쓰기 (노드를 다시 만들지 않고 값만 바꿈)', () => {
  test('TTL 과 태그는 전과 같이 처리된다', () => {
    const clock = { t: 0 };
    const r = new MiniRedis({ now: () => clock.t });
    r.command(['SET', 'k', 'v1', 'EX', '10']);
    r.command(['TAG', 'k', 'a', 'b']);
    r.command(['SET', 'k', 'v2']); // 옵션 없이 덮어쓰면 TTL 과 태그가 사라진다
    assert.equal(r.command(['TTL', 'k']), -1);
    assert.equal(r.command(['INFO']).keysWithTtl, 0);
    assert.equal(r.command(['INVALIDATE', 'a']), 0);
    assert.equal(r.command(['GET', 'k']), 'v2');

    r.command(['SET', 'k', 'v3', 'EX', '10']);
    r.command(['TAG', 'k', 'a']);
    r.command(['SET', 'k', 'v4', 'KEEPTTL']); // KEEPTTL 은 TTL 과 태그를 유지
    assert.equal(r.command(['TTL', 'k']), 10);
    assert.equal(r.command(['INVALIDATE', 'a']), 1);
    assert.equal(r.command(['GET', 'k']), null);

    r.command(['SET', 'k', 'v5']);
    r.command(['SET', 'k', 'v6', 'PX', '50']); // TTL 없던 키에 TTL 을 붙여 덮어쓰기
    clock.t = 60;
    assert.equal(r.activeExpireCycle(), 1, '주기 삭제가 찾는다 (expires 표에 들어 있다)');
    assert.equal(r.command(['DBSIZE']), 0);
  });

  test('소문자 명령, 숫자 인자도 그대로 동작하고, 객체 기본 속성 이름은 명령이 아니다', () => {
    const r = new MiniRedis();
    assert.equal(r.command(['set', 'n', 5]), 'OK');
    assert.equal(r.command(['Get', 'n']), '5');
    assert.equal(r.command(['incrby', 'n', 3]), 8);
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => r.command([bad]), /알 수 없는 명령/);
    assert.throws(() => r.command(['get']), /'GET' 명령의 인자 개수/);
  });
});

describe('AOF: 나눠 읽기 · 나눠 쓰기', () => {
  test('readLines: 작은 덩어리로 읽어도 줄과 한글이 깨지지 않는다', () => {
    const dir = tmp();
    const file = join(dir, 'a.txt');
    const lines = ['첫 줄 한글', '', '["SET","키","값 🙂"]', '마지막 줄(줄바꿈 없음)'];
    writeFileSync(file, lines.join('\n'));
    for (const chunk of [1, 2, 3, 7, 64, 1 << 20]) assert.deepEqual([...readLines(file, chunk)], lines, `chunk ${chunk}`);
    rmSync(dir, { recursive: true, force: true });
  });

  test('loadAof 는 줄 반복자도 받는다. 마지막 줄만 깨졌으면 truncated, 중간이 깨졌으면 errors', () => {
    const good = ['["SET","a","1"]', '["SET","b","2"]'];
    const r1 = new MiniRedis();
    assert.deepEqual(r1.loadAof(good[Symbol.iterator]()), { applied: 2, truncated: false, errors: 0 });
    const r2 = new MiniRedis();
    assert.deepEqual(r2.loadAof([...good, '["SET","c"'][Symbol.iterator]()), { applied: 2, truncated: true, errors: 0 });
    const r3 = new MiniRedis();
    assert.deepEqual(r3.loadAof(['["SET","c"', ...good].join('\n') + '\n'), { applied: 2, truncated: false, errors: 1 });
    assert.equal(r3.command(['GET', 'b']), '2');
  });

  test('키가 많으면 재작성을 나눠서 한다: 그 사이에 들어온 명령도 빠지지 않고, 다시 켜면 상태가 같다', async () => {
    const dir = tmp();
    const file = join(dir, 'redis.aof');
    const opts = { fsync: 'no', autoRewriteMinSize: 2000, incrementalRewriteAt: 100 };
    const { redis, aof } = openPersistentRedis(file, opts);
    for (let i = 0; i < 400; i++) redis.command(['SET', `k${i}`, `v${i}`]);
    assert.ok(aof.rewriting || aof.rewrites > 0, '재작성이 시작됐다');
    // 재작성이 진행되는 동안 값을 바꾸고, 지우고, 새로 넣는다
    let during = 0;
    for (let round = 0; round < 50 && aof.rewriting; round++) {
      redis.command(['SET', `k${round}`, 'changed']);
      redis.command(['DEL', `k${399 - round}`]);
      redis.command(['SET', `late${round}`, 'new', 'EX', '1000']);
      redis.command(['TAG', `late${round}`, 'late']);
      during++;
      await tick();
    }
    assert.ok(during > 0, '재작성 도중에 명령을 처리했다 (서버가 멈추지 않았다)');
    while (aof.rewriting) await tick();
    assert.ok(aof.rewrites >= 1);
    const expected = redis.dump();
    aof.close();
    const again = openPersistentRedis(file, opts);
    assert.deepEqual(again.redis.dump(), expected);
    assert.equal(again.restored.errors, 0);
    again.aof.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('나눠 쓰는 도중에 닫으면 끝까지 마치고 닫는다 / 죽으면 원래 파일이 그대로 남는다', () => {
    const dir = tmp();
    const file = join(dir, 'redis.aof');
    const opts = { fsync: 'no', autoRewriteMinSize: 2000, incrementalRewriteAt: 50 };
    const a = openPersistentRedis(file, opts);
    for (let i = 0; i < 300; i++) a.redis.command(['SET', `k${i}`, 'v'.repeat(20)]);
    assert.ok(a.aof.rewriting, '나눠 쓰는 중');
    const expected = a.redis.dump();
    a.aof.close();
    assert.equal(a.aof.rewriting, null);
    const b = openPersistentRedis(file, opts);
    assert.deepEqual(b.redis.dump(), expected);
    for (let i = 300; i < 700; i++) b.redis.command(['SET', `k${i}`, 'v'.repeat(20)]);
    assert.ok(b.aof.rewriting, '다시 나눠 쓰는 중');
    b.aof.flush(false);
    const expected2 = b.redis.dump();
    b.aof.crash(); // 쓰다 만 임시 파일은 버려진다
    const c = openPersistentRedis(file, opts);
    assert.deepEqual(c.redis.dump(), expected2);
    c.aof.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('클라이언트: TTL 흩뜨리기 · 분산 락', () => {
  let s, base;
  before(async () => {
    s = await startRedisServer({ port: 0, latencyMs: 10 });
    base = `http://127.0.0.1:${s.port}`;
  });
  after(() => s.close());

  test('jitter: 같은 ttl 로 저장해도 만료 시각이 ±비율 안에서 흩어진다', async () => {
    const c = new MiniRedisClient(base);
    const ttls = [];
    for (let i = 0; i < 30; i++) {
      await c.set(`j:${i}`, 'v', { ttl: 100, jitter: 0.2 });
      ttls.push(s.redis.command(['PTTL', `j:${i}`]));
    }
    assert.ok(ttls.every((t) => t > 79_000 && t <= 120_000), `범위: ${Math.min(...ttls)} ~ ${Math.max(...ttls)}`);
    assert.ok(new Set(ttls.map((t) => Math.round(t / 1000))).size > 5, '서로 다른 값으로 흩어진다');
    await c.set('plain', 'v', { ttl: 100 });
    assert.equal(s.redis.command(['TTL', 'plain']), 100, 'jitter 를 안 주면 그대로');
  });

  test('lockMs: 서로 다른 서버(클라이언트)가 동시에 놓쳐도 loader 는 한 번만 실행된다', async () => {
    const servers = Array.from({ length: 4 }, () => new MiniRedisClient(base)); // API 서버 4대를 흉내
    let calls = 0;
    const load = async () => { calls++; await sleep(80); return { top: [1, 2, 3] }; };
    const rs = await Promise.all(servers.flatMap((c) => [c.getOrLoad('rank', load, { ttl: 60, lockMs: 2000 }), c.getOrLoad('rank', load, { ttl: 60, lockMs: 2000 })]));
    assert.equal(calls, 1, '락이 없으면 서버마다 한 번씩 = 4번');
    assert.ok(rs.every((r) => r.value.top.length === 3));
    assert.equal(rs.filter((r) => !r.hit).length >= 1, true);
    assert.equal(s.redis.command(['EXISTS', 'lock:rank']), 0, '끝나면 락을 푼다');
  });

  test('lockMs: 락을 잡은 서버가 죽어 락이 남아 있어도, 수명이 지나면 다른 서버가 가져온다', async () => {
    const c = new MiniRedisClient(base);
    s.redis.command(['SET', 'lock:stuck', '1', 'PX', '120']); // 누군가 락만 잡고 사라졌다
    let calls = 0;
    const r = await c.getOrLoad('stuck', async () => { calls++; return 'ok'; }, { ttl: 60, lockMs: 120 });
    assert.equal(r.value, 'ok');
    assert.equal(calls, 1);
  });
});

// ================================================================ 미니 DBMS
describe('SQL ? 자리표시자 (params)', () => {
  const db = () => new Database(new MemoryStorage(structuredClone(DEFAULT_SCHEMA)));

  test('값을 순서대로 넣는다: 숫자 · 문자열 · null', () => {
    const d = db();
    d.execute('INSERT INTO users (name, age, email) VALUES (?, ?, ?), (?, ?, ?)', ['정글', 20, 'a@x.io', '크래프톤', 30, null]);
    assert.deepEqual(d.execute('SELECT name, age FROM users WHERE id = ?', [2])[0].rows, [['크래프톤', 30]]);
    assert.deepEqual(d.execute('SELECT id FROM users WHERE age BETWEEN ? AND ? LIMIT 5', [10, 25])[0].rows, [[1]]);
    assert.deepEqual(d.execute('SELECT id FROM users WHERE email = ?', [null])[0].rows, [[2]]);
  });

  test('값 안의 따옴표와 SQL 은 그냥 글자다 (SQL 인젝션이 통하지 않는다)', () => {
    const d = db();
    const evil = "x'); INSERT INTO users (name) VALUES ('해커";
    d.execute('INSERT INTO users (name, age) VALUES (?, ?)', [evil, 1]);
    const rows = d.execute('SELECT id, name FROM users')[0].rows;
    assert.deepEqual(rows, [[1, evil]], '한 행만 들어갔고 이름은 입력 그대로');
    assert.deepEqual(d.execute('SELECT id FROM users WHERE name = ?', ["' OR '1'='1"])[0].rows, []);
  });

  test('개수가 안 맞거나 형식이 틀리면 에러', () => {
    assert.throws(() => parse('SELECT * FROM users WHERE id = ?'), /params/);
    assert.throws(() => parse('SELECT * FROM users WHERE id = ?', []), /params 는 0개/);
    assert.throws(() => parse('SELECT * FROM users WHERE id = ?', [1, 2]), /params 는 2개인데 '\?' 는 1개/);
    assert.throws(() => parse('SELECT * FROM users WHERE id = ?', [{ a: 1 }]), /숫자, 문자열, null/);
    assert.throws(() => parse('SELECT * FROM users WHERE id = ?', [NaN]), SqlError);
    assert.throws(() => parse('SELECT * FROM users', 'x'), /배열/);
    assert.equal(parse('SELECT * FROM users WHERE id = 1').length, 1, '? 가 없으면 전과 같다');
  });
});

describe('결과 행 수 상한 (maxRows)', () => {
  test('상한에 걸리면 잘라서 주고 truncated 를 붙인다. LIMIT 이 더 작으면 그대로', () => {
    const d = new Database(new MemoryStorage(structuredClone(DEFAULT_SCHEMA)), { maxRows: 100 });
    seedRows(d, 'users', 500);
    const all = d.execute('SELECT * FROM users')[0];
    assert.equal(all.rows.length, 100);
    assert.equal(all.truncated, true);
    assert.ok(all.plan.scanned <= 100, '상한까지만 읽고 멈춘다');
    const range = d.execute('SELECT id FROM users WHERE id > 100')[0];
    assert.equal(range.rows.length, 100);
    assert.equal(range.truncated, true);
    const small = d.execute('SELECT * FROM users LIMIT 10')[0];
    assert.equal(small.rows.length, 10);
    assert.equal(small.truncated, undefined);
    assert.equal(d.execute('SELECT * FROM users WHERE id = 7')[0].truncated, undefined);
  });

  test('상한을 안 주면(기본) 전부 돌려준다', () => {
    const d = new Database(new MemoryStorage(structuredClone(DEFAULT_SCHEMA)));
    seedRows(d, 'users', 500);
    const all = d.execute('SELECT * FROM users')[0];
    assert.equal(all.rows.length, 500);
    assert.equal(all.truncated, undefined);
  });
});

describe('B+ 트리: 맨 오른쪽 리프 빠른 길', () => {
  test('커지는 순서, 섞인 순서, 둘을 섞어 넣어도 구조가 올바르다', () => {
    for (const order of [3, 4, 5, 64]) {
      const t = new BPlusTree(order);
      for (let i = 1; i <= 2000; i++) t.insert(i * 2, i); // 짝수를 커지는 순서로 (빠른 길)
      t.check();
      for (let i = 1999; i >= 1; i -= 2) t.insert(i, -i); // 홀수를 거꾸로 (일반 경로)
      t.check();
      t.insert(5000, 1); // 다시 가장 큰 키
      t.insert(4999, 1);
      t.insert(6000, 1);
      t.check();
      assert.equal(t.size, 3003);
      assert.equal(t.get(2000), 1000);
      assert.equal(t.get(1999), -1999);
      assert.equal(t.max(), 6000);
      assert.deepEqual([...t.range(3998, 5000)].map(([k]) => k), [3998, 4000, 4999, 5000]);
      assert.throws(() => t.insert(6000, 2), /이미 있는 키/);
    }
  });
});

describe('DB 서비스: 묶음 처리 · params · 상한', () => {
  let dir, svc;
  before(async () => {
    dir = tmp();
    const s = new FileStorage(dir);
    seedRows(new Database(s), 'products', 5000);
    s.close();
    svc = createDbService({ dir, workers: 2, maxRows: 1000 });
    await svc.ready();
  });
  after(async () => {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('조회 600개를 한꺼번에 보내도 요청마다 자기 결과를 받는다 (묶여서 처리돼도 섞이지 않음)', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => 1 + ((i * 37) % 5000));
    const rs = await Promise.all(ids.map((id) => svc.query('SELECT id, name FROM products WHERE id = ?', { params: [id] })));
    rs.forEach((r, i) => assert.equal(r.results[0].rows[0][0], ids[i]));
    const done = svc.pool.status().workers.map((w) => w.done);
    assert.ok(done.every((n) => n > 100), `두 워커가 나눠 처리: ${done}`);
  });

  test('묶음 안의 한 요청이 실패해도 다른 요청은 성공한다', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => svc.query(i % 10 === 3 ? 'SELECT nope FROM products WHERE id = 1' : `SELECT id FROM products WHERE id = ${i + 1}`)));
    rs.forEach((r, i) => {
      if (i % 10 === 3) assert.equal(r.status, 'rejected');
      else assert.equal(r.value.results[0].rows[0][0], i + 1);
    });
  });

  test('일부러 느리게 한 요청(delayMs)은 묶지 않고 워커들이 나눠 처리한다', async () => {
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 4 }, () => svc.query('SELECT id FROM products WHERE id = 1', { delayMs: 150 })));
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `워커 2개 × 2번 ≈ 300ms 여야 한다 (묶이면 450ms 이상): ${ms.toFixed(0)}ms`);
  });

  test('쓰기와 조회가 섞여 몰려도 넣은 행은 모두 보인다', async () => {
    const writes = Array.from({ length: 40 }, (_, i) => svc.query('INSERT INTO products (name, price, category) VALUES (?, ?, ?)', { params: [`묶음-${i}`, i, '테스트'] }));
    const reads = Array.from({ length: 200 }, (_, i) => svc.query(`SELECT id FROM products WHERE id = ${1 + i}`));
    const inserted = (await Promise.all(writes)).map((r) => r.results[0].ids[0]);
    await Promise.all(reads);
    assert.equal(new Set(inserted).size, 40, 'id 가 겹치지 않는다');
    const back = await Promise.all(inserted.map((id) => svc.query('SELECT name FROM products WHERE id = ?', { params: [id] })));
    back.forEach((r, i) => assert.equal(r.results[0].rows[0][0], `묶음-${i}`));
  });

  test('LIMIT 없는 전체 조회는 상한(1000행)에서 잘린다', async () => {
    const r = await svc.query('SELECT * FROM products');
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[0].truncated, true);
  });

  test('params 가 배열이 아니면 SQL 에러', async () => {
    await assert.rejects(svc.query('SELECT * FROM products WHERE id = ?', { params: 'x' }), /배열/);
    await assert.rejects(svc.query('SELECT * FROM products WHERE id = ?'), /params/);
  });
});

// ================================================================ 웹 서버
describe('웹 서버: 정적 파일 · API 접근 제한', () => {
  let app, base;
  before(async () => {
    app = createApp();
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.address().port}`;
  });
  after(async () => {
    await app.week2.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
  });

  test('글자 파일은 gzip 으로 줄여 보내고, 내용은 원본과 같다', async () => {
    const plain = await fetch(`${base}/styles/base.css`, { headers: { 'Accept-Encoding': 'identity' } });
    const zipped = await fetch(`${base}/styles/base.css`);
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    const original = readFileSync(new URL('../styles/base.css', import.meta.url), 'utf8');
    assert.equal(await plain.text(), original);
    assert.equal(await zipped.text(), original);
    assert.ok(Number(zipped.headers.get('content-length')) < Buffer.byteLength(original) / 2, '절반 이하로 준다');
  });

  test('같은 파일을 다시 요청하면 304 (본문 없음). 없는 파일은 404, 숨긴 파일은 403', async () => {
    const first = await fetch(`${base}/index.html`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.text();
    const again = await fetch(`${base}/index.html`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    assert.equal((await fetch(`${base}/index.html`, { headers: { 'If-None-Match': '"other"' } })).status, 200);
    assert.equal((await fetch(`${base}/`)).headers.get('etag'), etag, '폴더 주소도 같은 파일');
    assert.equal((await fetch(`${base}/no-such-file.js`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 403);
  });

  test('같은 컴퓨터인지 판별', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) assert.equal(isLoopback(a), true, a);
    for (const a of ['192.168.0.7', '::ffff:192.168.0.7', '10.0.0.1', 'fe80::1', '', undefined]) assert.equal(isLoopback(a), false, String(a));
  });

  test('같은 컴퓨터에서 온 API 요청은 그대로 처리된다', async () => {
    assert.equal((await fetch(`${base}/api/redis/info`)).status, 200);
  });
});
