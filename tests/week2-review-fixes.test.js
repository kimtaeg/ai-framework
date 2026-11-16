/**
 * 2주차 — 코드 리뷰에서 나온 문제 6가지의 회귀 테스트
 *   Redis : glob 매처(예외 · ReDoS) · SET 의 지난 만료 시각 · INCR 정밀도 · 분산 락 토큰(DELIF)
 *   DBMS  : 실패 시 다시 읽는 범위 · 대기열 상한(503) · delayMs 옵션
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MiniRedis, globMatcher, globToRegExp } from '../week2/redis/miniredis.js';
import { startRedisServer } from '../week2/redis/server.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { createDbService } from '../week2/dbms/service.js';
import { startDbServer } from '../week2/dbms/server.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('glob 매처', () => {
  test('*, ?, [abc], [a-z], [!abc], \\x 가 Redis 와 같은 뜻으로 맞는다', () => {
    const cases = [
      ['*', ['', 'a', 'abc'], []],
      ['', [''], ['a']],
      ['h?llo', ['hello', 'hallo'], ['hllo', 'heello']],
      ['h*llo', ['hllo', 'heeeello'], ['hell', 'ello']],
      ['h[ae]llo', ['hello', 'hallo'], ['hillo']],
      ['h[!e]llo', ['hallo', 'hbllo'], ['hello']],
      ['h[a-c]llo', ['hallo', 'hbllo', 'hcllo'], ['hdllo']],
      ['user:*:name', ['user:1:name', 'user::name', 'user:a:b:name'], ['user:1:nam', 'xuser:1:name']],
      ['a**b', ['ab', 'axxb'], ['a']],
      ['*.js', ['a.js', '.js'], ['ajs', 'a.jsx']],
      ['a.b', ['a.b'], ['axb']],
      ['\\*', ['*'], ['a', '']],
      ['a\\?', ['a?'], ['ab']],
      ['[abc', ['[abc'], ['a']],
      ['[a-]', ['a', '-'], ['b']],
      ['한*', ['한글', '한'], ['글한']],
      ['*a*b*c', ['abc', 'xaxbxc', 'aabbcc'], ['acb', 'ab']],
      ['k?y\n*', ['key\nx'], ['key']],
    ];
    for (const [pattern, yes, no] of cases) {
      const m = globMatcher(pattern);
      for (const s of yes) assert.equal(m.test(s), true, `'${pattern}' 는 '${s}' 와 맞아야 한다`);
      for (const s of no) assert.equal(m.test(s), false, `'${pattern}' 는 '${s}' 와 맞지 않아야 한다`);
    }
    assert.equal(globToRegExp, globMatcher, '예전 이름도 그대로 쓸 수 있다');
  });

  test('순서가 뒤집힌 범위 [z-a] 는 예외 없이 [a-z] 로 본다 (예전에는 SyntaxError → HTTP 500)', () => {
    const r = new MiniRedis();
    r.command(['MSET', 'a', '1', 'm', '1', 'Z', '1']);
    assert.deepEqual(r.command(['KEYS', '[z-a]']), ['a', 'm']);
    assert.equal(r.command(['DELPATTERN', '[z-a]']), 2);
    assert.deepEqual(r.command(['SCAN', '0', 'MATCH', '[z-a]'])[1], []);
  });

  test('a*a*a*…b 같은 패턴도 금방 끝난다 (예전에는 시도 횟수가 폭발해 서버가 멈췄다)', () => {
    const r = new MiniRedis();
    for (let i = 0; i < 200; i++) r.command(['SET', 'a'.repeat(200) + i, '1']);
    const t0 = performance.now();
    assert.deepEqual(r.command(['KEYS', 'a*'.repeat(30) + 'b']), []);
    assert.equal(r.command(['KEYS', 'a*'.repeat(30) + '7']).length, 20);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${ms.toFixed(0)}ms`);
  });
});

describe('SET 의 이미 지난 만료 시각', () => {
  test('저장하지 않고, 있던 값은 지운다', () => {
    let now = 1_000_000;
    const log = [];
    const r = new MiniRedis({ now: () => now, onWrite: (a) => log.push(a) });
    assert.equal(r.command(['SET', 'dead', 'v', 'PXAT', '5']), 'OK');
    assert.equal(r.data.size, 0);
    assert.equal(r.usedBytes, 0);
    assert.deepEqual(log, []);

    r.command(['SET', 'k', 'old']);
    r.command(['TAG', 'k', 't']);
    log.length = 0;
    assert.equal(r.command(['SET', 'k', 'new', 'EXAT', '1']), 'OK');
    assert.equal(r.command(['GET', 'k']), null);
    assert.deepEqual(log, [['DEL', 'k']]);
    assert.equal(r.command(['INVALIDATE', 't']), 0, '태그 색인에도 남지 않는다');
    assert.equal(r.usedBytes, 0);

    // NX / XX 조건이 먼저
    r.command(['SET', 'k', 'v']);
    assert.equal(r.command(['SET', 'k', 'x', 'PXAT', '5', 'NX']), null);
    assert.equal(r.command(['GET', 'k']), 'v');
    assert.equal(r.command(['SET', 'none', 'x', 'PXAT', '5', 'XX']), null);
    // 미래 시각은 그대로 저장
    assert.equal(r.command(['SET', 'f', 'v', 'PXAT', String(now + 500)]), 'OK');
    assert.equal(r.command(['PTTL', 'f']), 500);
  });

  test('AOF 재생: 꺼져 있는 동안 만료된 키는 올라오지 않아서, 메모리 상한이 살아 있는 키를 밀어내지 않는다', () => {
    const now = 1_000_000;
    // 살아 있는 키가 먼저(= 더 오래 안 쓴 것으로 보임), 죽은 키가 나중에 기록된 AOF
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(JSON.stringify(['SET', `live${i}`, 'x'.repeat(20)]));
    for (let i = 0; i < 30; i++) lines.push(JSON.stringify(['SET', `dead${i}`, 'x'.repeat(20), 'PXAT', '5']));
    const r = new MiniRedis({ now: () => now, maxMemory: 2000 });
    const restored = r.loadAof(lines.join('\n'));
    assert.equal(restored.applied, 40);
    assert.equal(r.data.size, 10);
    assert.equal(r.evicted, 0);
    for (let i = 0; i < 10; i++) assert.equal(r.command(['EXISTS', `live${i}`]), 1);
  });
});

describe('INCR 정밀도', () => {
  test('2^53 을 넘는 값에는 더하지 않는다 (이미 반올림된 값으로 계산하지 않게)', () => {
    const r = new MiniRedis();
    r.command(['SET', 'n', '9007199254740993']);
    assert.throws(() => r.command(['DECRBY', 'n', '2']), /정수 범위/);
    assert.throws(() => r.command(['INCR', 'n']), /정수 범위/);
    assert.equal(r.command(['GET', 'n']), '9007199254740993', '값은 그대로');
    r.command(['SET', 'm', '-9007199254740993']);
    assert.throws(() => r.command(['INCRBY', 'm', '5']), /정수 범위/);
    // 경계 안쪽은 정확하게
    r.command(['SET', 'ok', '9007199254740990']);
    assert.equal(r.command(['INCR', 'ok']), 9007199254740991);
    assert.throws(() => r.command(['INCR', 'ok']), /정수 범위/);
    assert.equal(r.command(['DECRBY', 'ok', '9007199254740991']), 0);
  });
});

describe('DELIF 와 분산 락 토큰', () => {
  test('DELIF: 값이 같을 때만 지운다', () => {
    let now = 0;
    const log = [];
    const r = new MiniRedis({ now: () => now, onWrite: (a) => log.push(a) });
    r.command(['SET', 'lock', 'mine', 'PX', '100']);
    log.length = 0;
    assert.equal(r.command(['DELIF', 'lock', 'other']), 0);
    assert.equal(r.command(['GET', 'lock']), 'mine');
    assert.deepEqual(log, []);
    assert.equal(r.command(['DELIF', 'lock', 'mine']), 1);
    assert.equal(r.command(['EXISTS', 'lock']), 0);
    assert.deepEqual(log, [['DEL', 'lock']]);
    assert.equal(r.command(['DELIF', 'lock', 'mine']), 0, '없는 키');
    r.command(['SET', 'lock', 'mine', 'PX', '100']);
    now = 500;
    assert.equal(r.command(['DELIF', 'lock', 'mine']), 0, '만료된 키');
    assert.throws(() => r.command(['DELIF', 'lock']), /인자 개수/);
  });

  test('getOrLoad(lockMs): 락 값은 요청마다 다르고, 자기 락만 푼다', async () => {
    const s = await startRedisServer({ port: 0, aofPath: null });
    const c = new MiniRedisClient(`http://127.0.0.1:${s.port}`);
    try {
      // 1) 평소: loader 가 도는 동안 락이 걸려 있고, 끝나면 풀린다
      const seen = [];
      for (const key of ['a', 'b']) {
        const r = await c.getOrLoad(key, async () => {
          seen.push(await c.get(`lock:${key}`));
          return { key };
        }, { lockMs: 2000 });
        assert.deepEqual(r, { value: { key }, hit: false });
        assert.equal(await c.get(`lock:${key}`), null, '끝나면 락이 풀린다');
      }
      assert.ok(seen[0] && seen[1] && seen[0] !== seen[1], `락 값이 요청마다 달라야 한다: ${seen}`);
      assert.notEqual(seen[0], '1');

      // 2) 내 락이 만료돼 다른 서버가 새로 잡은 상황: 늦게 끝난 내가 그 락을 지우면 안 된다
      await c.getOrLoad('c', async () => {
        await c.command('SET', 'lock:c', 'other-server', 'PX', '5000'); // 다른 서버가 잡은 락
        return 1;
      }, { lockMs: 2000 });
      assert.equal(await c.get('lock:c'), 'other-server', '남의 락은 그대로');
      assert.equal(await c.get('c'), '1');
    } finally {
      await s.close();
    }
  });
});

describe('DBMS: 실패했을 때 다시 읽는 범위', () => {
  const builtCount = async (svc, sql, times) => {
    let built = 0;
    for (let k = 0; k < times; k++) if ((await svc.query(sql)).results[0].plan.built) built++;
    return built;
  };

  test('SQL 오류로 실패한 쓰기는 아무 워커도 파일을 다시 읽게 하지 않는다', async () => {
    const dir = tmp('minidb-noreload');
    const svc = createDbService({ dir, workers: 3 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x'), ('b', 2, 'b@x')");
      const find = "SELECT id FROM users WHERE email = 'b@x'";
      assert.equal(await builtCount(svc, find, 6), 3, '워커 3개가 각자 해시 인덱스를 한 번씩 만든다');
      // 값이 틀린 INSERT: 아무것도 쓰기 전에 실패한다 → 어느 워커도 다시 읽지 않는다
      // (다시 읽었다면 보조 인덱스가 지워져서 또 만들어야 한다. 예전에는 셋 다 다시 만들었다)
      for (let k = 0; k < 3; k++) await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('c', 'x', 'c@x')"));
      assert.equal(await builtCount(svc, find, 6), 0, '인덱스가 그대로 남아 있다');
      // 앞 문장을 쓴 뒤에 실패한 요청: 그 요청을 실행한 워커 하나만 자기가 쓴 것을 되돌리며 다시 읽는다
      await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('c', 3, 'c@x'); SELECT nope FROM users"));
      assert.ok((await builtCount(svc, find, 6)) <= 1, '다른 워커는 다시 읽지 않는다');
      // 그래도 데이터는 정확하다
      const r = await svc.query("INSERT INTO users (name, age, email) VALUES ('d', 4, 'd@x')");
      assert.deepEqual(r.results[0].ids, [3]);
      for (let k = 0; k < 3; k++) assert.deepEqual((await svc.query("SELECT id FROM users WHERE email = 'c@x'")).results[0].rows, []);
      for (let k = 0; k < 3; k++) assert.deepEqual((await svc.query("SELECT id FROM users WHERE email = 'd@x'")).results[0].rows, [[3]]);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('시간 초과로 실패한 쓰기는 그 테이블만 다시 읽게 한다 (다른 테이블은 건드리지 않음)', async () => {
    const dir = tmp('minidb-reload-one');
    const svc = createDbService({ dir, workers: 3, timeoutMs: 250 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x')");
      await svc.query("INSERT INTO products (name, price, category) VALUES ('p', 10, 'c')");
      const findProduct = "SELECT id FROM products WHERE category = 'c'";
      const findUser = "SELECT id FROM users WHERE email = 'a@x'";
      assert.equal(await builtCount(svc, findProduct, 6), 3);
      assert.equal(await builtCount(svc, findUser, 6), 3);
      // users 쓰기가 제한 시간을 넘긴다 → 그 워커는 끝나고 새로 뜬다
      await assert.rejects(svc.query("INSERT INTO users (name, age, email) VALUES ('slow', 1, 's@x')", { delayMs: 1500 }), /끝나지 않았습니다/);
      await svc.ready();
      // products: 새로 뜬 워커 하나만 인덱스를 다시 만든다. 나머지 둘은 그대로 (예전에는 셋 다 다시 만들었다)
      assert.ok((await builtCount(svc, findProduct, 6)) <= 1);
      // users: 모든 워커가 다시 읽었다
      assert.equal(await builtCount(svc, findUser, 6), 3);
      const r = await svc.query("INSERT INTO users (name, age, email) VALUES ('b', 2, 'b@x')");
      assert.deepEqual(r.results[0].ids, [2]);
      for (let k = 0; k < 3; k++) assert.deepEqual((await svc.query('SELECT id FROM users')).results[0].rows, [[1], [2]]);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DBMS: 대기열 상한과 delayMs 옵션', () => {
  test('maxPending 을 넘는 요청은 기다리게 하지 않고 바로 503 (BUSY)', async () => {
    const dir = tmp('minidb-busy');
    const s = await startDbServer({ port: 0, dir, workers: 2, maxPending: 3 });
    const post = async (sql, delayMs) => {
      const r = await fetch(`http://127.0.0.1:${s.port}/sql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, delayMs }) });
      return { status: r.status, body: await r.json() };
    };
    try {
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 6 }, () => post('SELECT id FROM users WHERE id = 1', 300)));
      const ok = rs.filter((r) => r.status === 200), busy = rs.filter((r) => r.status === 503);
      assert.equal(ok.length, 3);
      assert.equal(busy.length, 3);
      assert.equal(busy[0].body.error, 'BUSY');
      assert.ok(performance.now() - t0 < 1500);
      assert.equal(s.svc.status().rejected, 3);
      // 밀린 것이 빠지면 다시 받는다
      assert.equal((await post('SELECT id FROM users WHERE id = 1')).status, 200);
      // SQL 문법 오류는 자리를 차지하지 않는다
      for (let k = 0; k < 5; k++) assert.equal((await post('SELEC')).status, 400);
      assert.equal((await post('SELECT id FROM users WHERE id = 1')).status, 200);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allowDelay: false 면 요청의 delayMs 를 무시한다 (요청 몇 개로 워커를 잠재울 수 없게)', async () => {
    const dir = tmp('minidb-nodelay');
    const svc = createDbService({ dir, workers: 2, allowDelay: false });
    try {
      await svc.ready();
      const t0 = performance.now();
      await Promise.all(Array.from({ length: 4 }, () => svc.query('SELECT id FROM users WHERE id = 1', { delayMs: 2000 })));
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${ms.toFixed(0)}ms`);
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
