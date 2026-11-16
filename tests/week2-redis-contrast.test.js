import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startRedisServer } from '../week2/redis/server.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { nodeFetch } from '../week2/redis/node-fetch.js';
import { runContrast } from '../load/redis-contrast.js';

describe('miniRedis 분산 Rate Limiter & 3자 대조 검증', () => {
  it('client.limit(): max 까지 허용 후 차단하고, TTL 이 빠진 키(-1)도 자동 복구한다', async () => {
    const srv = await startRedisServer({ port: 0, aofPath: null });
    try {
      const c = new MiniRedisClient(`http://127.0.0.1:${srv.port}`, { fetch: nodeFetch });
      const r1 = await c.limit('rl:u1', 2, 30);
      assert.equal(r1.allowed, true);
      assert.equal(r1.count, 1);
      assert.equal(r1.remaining, 1);
      assert.ok(r1.ttl > 0 && r1.ttl <= 30);

      const r2 = await c.limit('rl:u1', 2, 30);
      assert.equal(r2.allowed, true);
      assert.equal(r2.remaining, 0);

      const r3 = await c.limit('rl:u1', 2, 30);
      assert.equal(r3.allowed, false);
      assert.equal(r3.count, 3);

      // 장애로 INCR 만 되고 EXPIRE 가 빠진 상태(TTL = -1) 재현 -> limit() 이 TTL 복구
      await c.command('INCR', 'rl:orphan');
      assert.equal(await c.command('TTL', 'rl:orphan'), -1);
      const rOrphan = await c.limit('rl:orphan', 5, 45);
      assert.equal(rOrphan.allowed, true);
      assert.equal(rOrphan.count, 2);
      const fixedTtl = await c.command('TTL', 'rl:orphan');
      assert.ok(fixedTtl > 0 && fixedTtl <= 45);
    } finally {
      await srv.close();
    }
  });

  it('runContrast(): miniRedis vs LocalCache vs 없음(DBMS 단독) — 일관성 · 원자성 · Rate Limit · 스탬피드/락 안전성', async () => {
    const res = await runContrast({
      rows: 5000,
      cacheQueries: 40,
      concurrency: 10,
      counterOps: 60,
      rateLimitMax: 10,
      rateTotal: 30,
      stampedeClients: 20,
      log: null,
    });

    // 1. 다중 서버 캐시 일관성 (권한 회수/가격 변경 반영)
    assert.equal(res.cacheRead.miniRedis.staleOnMultiServer, false);
    assert.equal(res.cacheRead.localMap.staleOnMultiServer, true);

    // 2. 동시 카운터 원자성: miniRedis INCR 무손실 vs 비원자적 GET+SET 유실
    assert.equal(res.counterRace.miniRedis.lostUpdates, 0);
    assert.equal(res.counterRace.miniRedis.actual, 60);
    assert.ok(res.counterRace.naiveGetSet.lostUpdates > 0, '동시 GET+SET 은 lost update 가 발생해야 함');

    // 3. 분산 Rate Limit: 2대 서버 합산 정확히 10건만 허용, LocalCache 는 서버당 10건씩 총 20건 통과
    assert.equal(res.rateLimiting.miniRedis.allowed, 10);
    assert.equal(res.rateLimiting.miniRedis.blocked, 20);
    assert.equal(res.rateLimiting.miniRedis.bypassCount, 0);
    assert.equal(res.rateLimiting.miniRedis.dbHitsOnBlocked, 0);
    assert.equal(res.rateLimiting.localPerServer.allowed, 20);
    assert.equal(res.rateLimiting.localPerServer.bypassCount, 10);

    // 4. 스탬피드(DB 진입 횟수: 없음 20회 vs LocalCache 2회 vs miniRedis 1회) & DELIF 토큰 락 보호
    assert.equal(res.stampedeAndLock.stampedeDbHits.noneDbmsOnly, 20);
    assert.equal(res.stampedeAndLock.stampedeDbHits.localPerServer, 2);
    assert.equal(res.stampedeAndLock.stampedeDbHits.miniRedisLock, 1);
    assert.equal(res.stampedeAndLock.lockSafety.blindDelMutualExclusionBroken, true);
    assert.equal(res.stampedeAndLock.lockSafety.delifDeletedByStaleOwner, 0);
    assert.equal(res.stampedeAndLock.lockSafety.delifMutualExclusionPreserved, true);
  });
});
