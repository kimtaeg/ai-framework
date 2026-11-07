/**
 * 대안 기술 비교: 서버 안 메모리 캐시, 그리고 load/alt-bench.js 의 세 비교가 "맞는 결과" 를 내는지 (작은 크기로)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCache } from '../week2/redis/demo-api.js';
import { createApp, createWeek2 } from '../server.js';
import { createTestLab } from '../server/testlab.js';
import { benchIndex, benchPool, benchPersist } from '../load/alt-bench.js';

const quiet = () => {};

describe('서버 안 메모리 캐시 (LocalCache)', () => {
  test('미니 레디스 클라이언트와 같은 모양: get / set(ttl) / del / getOrLoad', async () => {
    const clock = { t: 1000 };
    const c = new LocalCache({ now: () => clock.t });
    assert.equal(await c.get('a'), null);
    await c.set('a', 'x', { ttl: 2 });
    assert.equal(await c.get('a'), 'x');
    clock.t += 2500;
    assert.equal(await c.get('a'), null, '만료');
    let loads = 0;
    const load = async () => { loads++; return { v: 1 }; };
    assert.deepEqual(await c.getOrLoad('b', load), { value: { v: 1 }, hit: false });
    assert.deepEqual(await c.getOrLoad('b', load), { value: { v: 1 }, hit: true });
    assert.equal(loads, 1);
    assert.equal(await c.del('b'), 1);
    assert.equal(await c.del('b'), 0);
  });

  describe('상품 API 의 ?cache=local', () => {
    let app, base, dir;
    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'alt-cache-'));
      app = createApp({ week2: createWeek2(dir), testlab: createTestLab({ passwordHash: '', resultsFile: join(dir, 'r.json') }) });
      await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
      base = `http://127.0.0.1:${app.address().port}`;
    });
    after(async () => {
      app.closeAllConnections?.();
      await new Promise((ok) => app.close(ok));
      await app.week2.close();
      rmSync(dir, { recursive: true, force: true });
    });
    test('처음은 MISS, 다음은 HIT, 가격을 바꾸면 메모리 캐시도 지워진다', async () => {
      const get = () => fetch(`${base}/api/demo/products/2?cache=local`);
      assert.equal((await get()).headers.get('x-cache'), 'MISS');
      assert.equal((await get()).headers.get('x-cache'), 'HIT');
      const put = await fetch(`${base}/api/demo/products/2`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: 1234 }) });
      assert.equal(put.status, 200);
      const after = await get();
      assert.equal(after.headers.get('x-cache'), 'MISS', '무효화됨');
      assert.equal((await after.json()).price, 1234);
    });
  });
});

describe('대안 비교 벤치마크 (작은 크기)', () => {
  test('인덱스: 세 자료구조 모두 같은 범위 결과, 정렬 배열은 넣기가 가장 느리고 해시는 범위가 가장 느리다', () => {
    const r = benchIndex({ n: 20_000, lookups: 20_000, ranges: 20, span: 500, log: quiet });
    assert.equal(r.variants.length, 3);
    assert.match(r.variants[0].label, /B\+ 트리/);
    const [bt, hash, arr] = r.variants.map((v) => v.metrics);
    assert.ok(arr.buildMs > bt.buildMs, `정렬 배열 넣기 ${arr.buildMs} > B+ 트리 ${bt.buildMs}`);
    assert.ok(hash.rangeMs > bt.rangeMs, `해시 범위 ${hash.rangeMs} > B+ 트리 ${bt.rangeMs}`);
    assert.equal(r.main, 'rangeMs');
  });

  test('영속성: 세 방식 모두 다시 읽을 수 있는 파일을 남기고, always 가 가장 느리다', async () => {
    const r = await benchPersist({ keys: 2000, maxOps: 20_000, seconds: 1, snapshotEveryWrites: 5000, log: quiet });
    assert.equal(r.variants.length, 3);
    for (const v of r.variants) {
      assert.ok(v.metrics.writesPerSec > 0 && v.metrics.fileKB > 0 && v.metrics.recoverMs >= 0, v.label);
    }
    const [every, always] = r.variants.map((v) => v.metrics);
    assert.ok(always.writesPerSec < every.writesPerSec, 'always 가 느림');
  });

  test('스레드 풀: 세 방식이 모두 끝까지 돌고, 메인 스레드에서 바로 하면 메인 스레드가 가장 바쁘다', async () => {
    const r = await benchPool({ rows: 2000, queries: 8, concurrency: 2, log: quiet });
    assert.equal(r.variants.length, 3);
    const [pool, perReq, main] = r.variants.map((v) => v.metrics);
    for (const m of [pool, perReq, main]) assert.ok(m.msPerQuery > 0);
    assert.ok(main.mainBusy > pool.mainBusy, `메인 ${main.mainBusy}% > 풀 ${pool.mainBusy}%`);
  });
});
