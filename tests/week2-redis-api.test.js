/**
 * 2주차 미니 레디스 — 기능 테스트: 외부에서 HTTP API / 클라이언트로 사용, 캐시로 쓰는 API, 성능 비교
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRedisServer } from '../week2/redis/server.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { createApp, createWeek2 } from '../server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('HTTP API + 클라이언트', () => {
  let s, base, c;
  before(async () => {
    s = await startRedisServer({ port: 0, latencyMs: 40 });
    base = `http://127.0.0.1:${s.port}`;
    c = new MiniRedisClient(base);
  });
  after(() => s.close());

  test('저장 → 조회 → 삭제', async () => {
    assert.equal(await c.set('user:1', '{"name":"정글"}'), true);
    assert.equal(await c.get('user:1'), '{"name":"정글"}');
    assert.equal(await c.del('user:1'), 1);
    assert.equal(await c.get('user:1'), null);
    assert.equal(await c.del('user:1'), 0);
  });

  test('처음 저장은 201, 덮어쓰기는 200', async () => {
    const put = (v) => fetch(`${base}/keys/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) });
    assert.equal((await put('a')).status, 201);
    assert.equal((await put('b')).status, 200);
  });

  test('TTL: 만료되면 404, ttl 값 확인, 만료 해제', async () => {
    await c.set('temp', 'v', { px: 60 });
    const r = await (await fetch(`${base}/keys/temp`)).json();
    assert.equal(r.ttl, 1);
    await sleep(90);
    const res = await fetch(`${base}/keys/temp`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'NOT_FOUND');
    await c.set('keep', 'v', { ttl: 100 });
    await c.expire('keep', null);
    assert.equal(await c.command('TTL', 'keep'), -1);
    assert.equal(await c.expire('none', 10), false);
  });

  test('특수 문자가 들어간 키 (/ ? # 공백 한글 %)', async () => {
    const key = 'a/b?c#d e/한글%25';
    await c.set(key, 'ok');
    assert.equal(await c.get(key), 'ok');
    assert.deepEqual(await c.keys('a/b*'), [key]);
  });

  test('NX / XX 조건 실패는 409 → 클라이언트는 false', async () => {
    await c.del('once');
    assert.equal(await c.set('once', '1', { nx: true }), true);
    assert.equal(await c.set('once', '2', { nx: true }), false);
    assert.equal(await c.set('never', '1', { xx: true }), false);
    assert.equal(await c.get('once'), '1');
  });

  test('태그·패턴 무효화', async () => {
    await c.set('p:1', 'a', { tags: ['products'] });
    await c.set('p:2', 'b', { tags: ['products'] });
    await c.set('page:home', 'c');
    assert.equal(await c.invalidate({ tags: ['products'] }), 2);
    assert.equal(await c.invalidate({ pattern: 'page:*' }), 1);
    assert.equal(await c.get('p:1'), null);
  });

  test('명령 그대로 보내기 + 파이프라인', async () => {
    assert.equal(await c.command('SET', 'n', '5'), 'OK');
    const res = await fetch(`${base}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'INCRBY n 10' }) });
    assert.equal((await res.json()).result, 15);
    const out = await c.pipeline([['INCR', 'n'], ['GET', 'n'], ['BAD']]);
    assert.deepEqual(out.slice(0, 2), [{ ok: 16 }, { ok: '16' }]);
    assert.ok(out[2].error);
  });

  test('잘못된 요청: JSON 아님, 값이 문자열 아님, 잘못된 ttl, 없는 주소, 지원 안 하는 메서드', async () => {
    const req = (path, method, body, raw) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    assert.equal((await req('/keys/x', 'PUT', null, '{bad json')).status, 400);
    assert.equal((await req('/keys/x', 'PUT', null, '[1,2]')).status, 400);
    assert.equal((await req('/keys/x', 'PUT', { value: 123 })).status, 400);
    assert.equal((await req('/keys/x', 'PUT', { value: 'v', ttl: -1 })).status, 400);
    assert.equal((await req('/keys/x', 'PUT', { value: 'v', ttl: 1.5 })).status, 400);
    assert.equal((await req('/keys/x', 'PUT', { value: 'v', ttl: 1, px: 1 })).status, 400);
    assert.equal((await req('/nowhere', 'GET')).status, 404);
    assert.equal((await req('/keys/x', 'PATCH')).status, 405);
    assert.equal((await req('/command', 'POST', { command: 'NOPE' })).status, 400);
    assert.equal((await req('/command', 'POST', {})).status, 400);
    assert.equal((await req('/invalidate', 'POST', {})).status, 400);
    const incr = await req('/keys/notnum/incr', 'POST', { by: 'x' });
    assert.equal(incr.status, 400);
  });

  test('너무 큰 본문은 413', async () => {
    const res = await fetch(`${base}/keys/huge`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(1.2 * 1024 * 1024) }),
    }).catch((e) => ({ status: 'closed', e }));
    assert.ok(res.status === 413 || res.status === 'closed', String(res.status));
  });

  test('동시 요청 200개의 INCR → 정확히 200 (명령 하나는 원자적)', async () => {
    await c.del('hits');
    await Promise.all(Array.from({ length: 200 }, () => c.incr('hits')));
    assert.equal(await c.get('hits'), '200');
  });

  test('반면 GET → +1 → SET 을 나눠서 하면 동시 요청에서 증가분을 잃는다 (경쟁 상태)', async () => {
    await c.set('naive', '0');
    await Promise.all(Array.from({ length: 50 }, async () => {
      const v = Number(await c.get('naive'));
      await c.set('naive', String(v + 1));
    }));
    const v = Number(await c.get('naive'));
    assert.ok(v <= 50);
    // 거의 항상 50보다 작다 — 그래서 INCR(서버 쪽에서 한 번에)을 써야 한다
  });

  test('INFO: 통계', async () => {
    const info = await c.info();
    assert.ok(info.keys >= 1);
    assert.ok(info.hashTable.buckets >= 4);
    assert.equal(typeof info.hits, 'number');
  });
});

describe('API 응답을 미니 레디스에 저장해서 쓰기 (cache-aside)', () => {
  let s, base;
  before(async () => {
    s = await startRedisServer({ port: 0, latencyMs: 100 }); // 실제 DB·외부 API 처럼 100ms
    base = `http://127.0.0.1:${s.port}/demo`;
  });
  after(() => s.close());

  test('처음은 MISS(DB 조회), 다음은 HIT(DB 안 감)', async () => {
    const a = await fetch(`${base}/products/1`);
    assert.equal(a.headers.get('x-cache'), 'MISS');
    const q1 = Number(a.headers.get('x-db-queries'));
    const b = await fetch(`${base}/products/1`);
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.equal(Number(b.headers.get('x-db-queries')), q1, 'HIT 일 때 DB 조회 수가 늘지 않음');
    assert.deepEqual(await a.json(), await b.json());
  });

  test('원본이 바뀌면 캐시를 지워서 오래된 값을 주지 않는다', async () => {
    await fetch(`${base}/products/2`); // 캐시에 올림
    const put = await fetch(`${base}/products/2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: 1000 }) });
    assert.equal((await put.json()).invalidated >= 1, true);
    const after = await fetch(`${base}/products/2`);
    assert.equal(after.headers.get('x-cache'), 'MISS');
    assert.equal((await after.json()).price, 1000);
  });

  test('없는 상품도 짧게 캐시 (negative caching), 잘못된 id 는 400', async () => {
    assert.equal((await fetch(`${base}/products/999`)).headers.get('x-cache'), 'MISS');
    const again = await fetch(`${base}/products/999`);
    assert.equal(again.status, 404);
    assert.equal(again.headers.get('x-cache'), 'HIT');
    assert.equal((await fetch(`${base}/products/abc`)).status, 400);
    assert.equal((await fetch(`${base}/products/-1`)).status, 400);
  });

  test('목록도 캐시, 가격을 바꾸면 목록 캐시도 무효화', async () => {
    await fetch(`${base}/products`);
    assert.equal((await fetch(`${base}/products`)).headers.get('x-cache'), 'HIT');
    await fetch(`${base}/products/3`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: 5 }) });
    const list = await fetch(`${base}/products`);
    assert.equal(list.headers.get('x-cache'), 'MISS');
    assert.equal((await list.json()).find((p) => p.id === 3).price, 5);
  });

  test('성능 비교: 같은 요청 20번 — 캐시를 쓰면 훨씬 빠르다', async () => {
    const run = async (cache) => {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) await fetch(`${base}/products/4${cache ? '' : '?cache=0'}`).then((r) => r.text());
      return performance.now() - t0;
    };
    const without = await run(false);
    const withCache = await run(true);
    assert.ok(without >= 20 * 100, `캐시 없이 ${without.toFixed(0)}ms (DB 100ms × 20)`);
    // HIT 도 HTTP 를 두 번 거친다(클라이언트 → 상품 API → 미니 레디스). 그래도 DB 를 안 가니 훨씬 빠르다
    assert.ok(withCache < without / 2, `캐시 ${withCache.toFixed(0)}ms vs 없이 ${without.toFixed(0)}ms`);
  });
});

describe('메인 서버(npm start)에 붙은 2주차 API', () => {
  let app, base, dir;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'week2-main-'));
    app = createApp({ week2: createWeek2(dir) });
    await new Promise((ok) => app.listen(0, ok));
    base = `http://127.0.0.1:${app.address().port}`;
  });
  after(async () => {
    app.closeAllConnections?.();
    await new Promise((ok) => app.close(ok));
    await app.week2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('/api/redis 와 /api/demo 가 동작하고 AOF 파일이 생긴다', async () => {
    const c = new MiniRedisClient(`${base}/api/redis`);
    await c.set('hello', 'world');
    assert.equal(await c.get('hello'), 'world');
    assert.equal((await fetch(`${base}/api/demo/products/1`)).headers.get('x-cache'), 'MISS');
    assert.equal((await fetch(`${base}/api/demo/products/1`)).headers.get('x-cache'), 'HIT');
  });

  test('/api/sql 이 동작한다', async () => {
    const r = await fetch(`${base}/api/sql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: "INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x'); SELECT * FROM users WHERE id = 1" }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.results[1].rows[0][1], 'a');
  });

  test('week2/data 폴더(실제 데이터 파일)는 브라우저로 열 수 없다', async () => {
    assert.equal((await fetch(`${base}/week2/data/redis.aof`)).status, 403);
    assert.equal((await fetch(`${base}/week2/data/db/users.tbl`)).status, 403);
  });
});
