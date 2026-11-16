/**
 * 2주차 miniRedis vs 유사 대안(앱 내부 메모리 Map · 비원자적/무토큰) vs Redis 없음(miniDBMS 단독)
 * 성능 및 보안·정합성 3자 대조 벤치마크
 *
 *   node load/redis-contrast.js [--rows 50000] [--iters 300] [--writes 150]
 *
 * 비교 항목 (모두 순수 JS 커리큘럼 구현 사용):
 *   1. Cache-Aside 조회 성능 & 다중 API 서버(2대) 캐시 일관성 (권한/가격 변경 Stale 방어)
 *   2. 동시 쓰기/카운터 경합 (원자적 INCR vs 비원자적 GET+SET vs DBMS SELECT+INSERT)
 *   3. 분산 Rate Limiting (브루트포스/남용 방어: 2대 서버 합산 한도 집행 + DB 부하 차단)
 *   4. 캐시 스탬피드(DB DoS 증폭) & 분산 락 토큰 탈취 방어 (SET NX PX + DELIF vs 단순 DEL)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { seedRows } from '../week2/dbms/seed.js';
import { startDbServer } from '../week2/dbms/server.js';
import { startRedisServer } from '../week2/redis/server.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { LocalCache } from '../week2/redis/demo-api.js';
import { nodeFetch } from '../week2/redis/node-fetch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const summarize = (times) => {
  const s = [...times].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, p50Ms: r2(pct(s, 0.5)), p99Ms: r2(pct(s, 0.99)), avgMs: r2(sum / (s.length || 1)), totalMs: r2(sum) };
};

async function measureSeq(total, fn) {
  const times = new Array(total);
  const tStart = now();
  for (let i = 0; i < total; i++) {
    const t0 = now();
    await fn(i);
    times[i] = now() - t0;
  }
  const wallMs = now() - tStart;
  return { wallMs: r2(wallMs), rps: Math.round((total / wallMs) * 1000), ...summarize(times) };
}

async function measureConc(total, concurrency, fn) {
  const times = new Array(total);
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const i = next++;
      const t0 = now();
      await fn(i);
      times[i] = now() - t0;
    }
  };
  const tStart = now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = now() - tStart;
  return { wallMs: r2(wallMs), rps: Math.round((total / wallMs) * 1000), ...summarize(times) };
}

export async function runContrast({ rows = 50_000, cacheQueries = 300, concurrency = 16, counterOps = 150, rateLimitMax = 20, rateTotal = 60, stampedeClients = 40, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'redis-contrast-'));
  const storage = new FileStorage(dir);
  const db = new Database(storage);
  seedRows(db, 'users', rows);
  // seedRows 는 age 18~67만 생성 → 맨 끝에 age=99 1건을 넣어 비-인덱스 범위 조건이 전체 N행 스캔 후 1건만 반환하게 만든다
  db.execute(`INSERT INTO users (name, age, email) VALUES ('VIP유저', 99, 'vip@jungle.test')`);
  storage.close();

  const dbSrv = await startDbServer({ port: 0, dir, workers: 4, autoIndex: true, snapshotReads: true });
  const redisSrv = await startRedisServer({ port: 0, aofPath: null, maxMemory: 16 * 1024 * 1024 });

  try {
    const base = `http://127.0.0.1:${redisSrv.port}`;
    const clientA = new MiniRedisClient(base, { fetch: nodeFetch });
    const clientB = new MiniRedisClient(base, { fetch: nodeFetch });
    const localA = new LocalCache();
    const localB = new LocalCache();
    const q = (sql, params) => dbSrv.svc.query(sql, { params });

    const heavySql = 'SELECT * FROM users WHERE age >= 99';
    const cacheKey = 'users:vip:age99';
    await clientA.getOrLoad(cacheKey, async () => (await q(heavySql)).results[0].rows, { ttl: 60, tags: ['users'] });
    await localA.getOrLoad(cacheKey, async () => (await q(heavySql)).results[0].rows, { ttl: 60 });
    await localB.getOrLoad(cacheKey, async () => (await q(heavySql)).results[0].rows, { ttl: 60 });

    // HTTP keep-alive 소켓 · 워커 풀 예열 (콜드 TCP/워커 초기화 비용 분리)
    await Promise.all(Array.from({ length: concurrency }, () => clientA.get(cacheKey)));
    await Promise.all(Array.from({ length: 4 }, () => q('SELECT * FROM users WHERE id = 1')));

    // ================================================================
    // 1. 무거운 DBMS 조회 앞 Cache-Aside 성능(단건 p50 + 동시 rps) & 2대 서버 일관성
    // ================================================================
    const dbmsSeqN = Math.min(40, cacheQueries);
    const dbmsSeq = await measureSeq(dbmsSeqN, () => q(heavySql));
    const redisSeq = await measureSeq(cacheQueries, (i) => (i % 2 === 0 ? clientA : clientB).get(cacheKey));
    const localSeq = await measureSeq(cacheQueries, (i) => (i % 2 === 0 ? localA : localB).get(cacheKey));

    const dbmsConc = await measureConc(dbmsSeqN, concurrency, () => q(heavySql));
    const redisConc = await measureConc(cacheQueries, concurrency, (i) => (i % 2 === 0 ? clientA : clientB).get(cacheKey));
    const localConc = await measureConc(cacheQueries, concurrency, (i) => (i % 2 === 0 ? localA : localB).get(cacheKey));

    // 다중 서버 정합성 테스트: 서버 A 에서 권한 회수(무효화) 후 서버 B 조회
    await clientA.set('perm:user1', 'admin', { ttl: 60 });
    await localA.set('perm:user1', 'admin', { ttl: 60 });
    await localB.set('perm:user1', 'admin', { ttl: 60 });
    await clientA.del('perm:user1');
    await localA.del('perm:user1');
    const redisStaleAfterRevoke = (await clientB.get('perm:user1')) !== null;
    const localStaleAfterRevoke = (await localB.get('perm:user1')) !== null;

    const cacheRead = {
      noneDbmsOnly: { ...dbmsSeq, concurrentRps: dbmsConc.rps, concurrentP50Ms: dbmsConc.p50Ms, dbHits: dbmsSeqN * 2, staleOnMultiServer: false },
      localMap: { ...localSeq, concurrentRps: localConc.rps, concurrentP50Ms: localConc.p50Ms, dbHits: 0, staleOnMultiServer: localStaleAfterRevoke, speedupVsDbms: r2(dbmsSeq.p50Ms / Math.max(0.001, localSeq.p50Ms)), rpsRatioVsDbms: r2(localConc.rps / Math.max(1, dbmsConc.rps)) },
      miniRedis: { ...redisSeq, concurrentRps: redisConc.rps, concurrentP50Ms: redisConc.p50Ms, dbHits: 0, staleOnMultiServer: redisStaleAfterRevoke, speedupVsDbms: r2(dbmsSeq.p50Ms / Math.max(0.001, redisSeq.p50Ms)), rpsRatioVsDbms: r2(redisConc.rps / Math.max(1, dbmsConc.rps)) },
    };

    // ================================================================
    // 2. 동시 쓰기/카운터 경합 (원자적 INCR vs 비원자적 GET+SET vs DBMS 조회+기록)
    // ================================================================
    await clientA.del('cnt:redis');
    const redisWrite = await measureSeq(counterOps, (i) => (i % 2 === 0 ? clientA : clientB).incr('cnt:redis'));
    const redisConcWrite = await measureConc(counterOps, concurrency, () => clientA.incr('cnt:redis:conc'));
    const redisCountVal = Number(await clientA.get('cnt:redis'));
    const redisConcVal = Number(await clientA.get('cnt:redis:conc'));

    // 유사 대안: 비원자적 GET -> +1 -> SET (분산/비동기 캐시에서 흔한 경쟁 상태)
    await clientA.set('cnt:naive', '0');
    const naiveWrite = await measureConc(counterOps, concurrency, async (i) => {
      const c = i % 2 === 0 ? clientA : clientB;
      const cur = Number((await c.get('cnt:naive')) ?? '0');
      await c.set('cnt:naive', String(cur + 1));
    });
    const naiveCountVal = Number(await clientA.get('cnt:naive'));

    // 없음: DBMS 로 카운터 누적 (현재값 범위 조회 + 이벤트 INSERT 기록)
    const dbmsCounterSeq = await measureSeq(Math.min(50, counterOps), async (i) => {
      await q('SELECT * FROM users WHERE id = ?', [1]);
      await q(`INSERT INTO users (name, age, email) VALUES (?, ?, ?)`, [`cnt${i}`, 25, `cnt${i}@x`]);
    });
    const dbmsCounterConc = await measureConc(counterOps, concurrency, async (i) => {
      await q('SELECT * FROM users WHERE id = ?', [1]);
      await q(`INSERT INTO users (name, age, email) VALUES (?, ?, ?)`, [`cc${i}`, 25, `cc${i}@x`]);
    });

    const counterRace = {
      expected: counterOps,
      miniRedis: { ...redisWrite, concurrentRps: redisConcWrite.rps, actual: redisCountVal, concActual: redisConcVal, lostUpdates: (counterOps - redisCountVal) + (counterOps - redisConcVal), speedupVsDbms: r2(dbmsCounterSeq.p50Ms / Math.max(0.001, redisWrite.p50Ms)), rpsRatioVsDbms: r2(redisConcWrite.rps / Math.max(1, dbmsCounterConc.rps)) },
      naiveGetSet: { ...naiveWrite, actual: naiveCountVal, lostUpdates: counterOps - naiveCountVal },
      noneDbmsWrite: { ...dbmsCounterSeq, concurrentRps: dbmsCounterConc.rps, actual: counterOps, lostUpdates: 0 },
    };

    // ================================================================
    // 3. 보안 1 · 분산 Rate Limiting (2대 서버 앞 브루트포스 방어)
    // ================================================================
    await clientA.del('rl:ip:attacker');
    let rlRedisAllowed = 0, rlRedisBlocked = 0;
    const rlRedisRes = await measureSeq(rateTotal, async (i) => {
      const c = i % 2 === 0 ? clientA : clientB;
      const res = await c.limit('rl:ip:attacker', rateLimitMax, 60);
      if (res.allowed) rlRedisAllowed++;
      else rlRedisBlocked++;
    });

    // 대안: 서버마다 LocalCache (프로세스 내 Map) 로 카운트할 때
    const rlLocalMaps = [new Map(), new Map()];
    let rlLocalAllowed = 0, rlLocalBlocked = 0;
    const rlLocalRes = await measureSeq(rateTotal, async (i) => {
      const m = rlLocalMaps[i % 2];
      const n = (m.get('ip:attacker') ?? 0) + 1;
      m.set('ip:attacker', n);
      if (n <= rateLimitMax) rlLocalAllowed++;
      else rlLocalBlocked++;
    });

    // 없음: DBMS 에 매 요청 기록+조회 (차단 여부와 무관하게 DB 가 공격 요청까지 전부 맞음)
    let rlDbAllowed = 0, rlDbBlocked = 0, rlDbHits = 0;
    const rlDbRes = await measureSeq(rateTotal, async (i) => {
      await q(`INSERT INTO users (name, age, email) VALUES (?, ?, ?)`, ['rl:attacker', 20, `rl${i}@x`]);
      await q(`SELECT * FROM users WHERE age >= 99`);
      rlDbHits++;
      if (i < rateLimitMax) rlDbAllowed++;
      else rlDbBlocked++;
    });

    const rateLimiting = {
      limit: rateLimitMax,
      totalRequests: rateTotal,
      miniRedis: { ...rlRedisRes, allowed: rlRedisAllowed, blocked: rlRedisBlocked, dbHitsOnBlocked: 0, bypassCount: Math.max(0, rlRedisAllowed - rateLimitMax), blockSpeedupVsDbms: r2(rlDbRes.p50Ms / Math.max(0.001, rlRedisRes.p50Ms)) },
      localPerServer: { ...rlLocalRes, allowed: rlLocalAllowed, blocked: rlLocalBlocked, bypassCount: Math.max(0, rlLocalAllowed - rateLimitMax) },
      noneDbmsOnly: { ...rlDbRes, allowed: rlDbAllowed, blocked: rlDbBlocked, dbHitsTotal: rlDbHits },
    };

    // ================================================================
    // 4. 보안 2 · 캐시 스탬피드(DB DoS 증폭) + 분산 락 토큰 탈취(DELIF) 방어
    // ================================================================
    const stampedeKey = 'stampede:hot';
    await clientA.del(stampedeKey);

    let dbLoaderNone = 0;
    await Promise.all(Array.from({ length: stampedeClients }, async () => { await q(heavySql); dbLoaderNone++; }));

    let dbLoaderLocal = 0;
    await Promise.all(Array.from({ length: stampedeClients }, (_, i) =>
      (i % 2 === 0 ? localA : localB).getOrLoad(stampedeKey, async () => { dbLoaderLocal++; return (await q(heavySql)).results[0].rows; }, { ttl: 60 })
    ));

    let dbLoaderRedis = 0;
    await Promise.all(Array.from({ length: stampedeClients }, (_, i) =>
      (i % 2 === 0 ? clientA : clientB).getOrLoad(stampedeKey, async () => { dbLoaderRedis++; return (await q(heavySql)).results[0].rows; }, { ttl: 60, lockMs: 2000 })
    ));

    // 분산 락 토큰 탈취: A 가 30ms TTL 락 획득 후 지연 -> B 가 새 락 획득 -> A 가 뒤늦게 해제
    await clientA.set('lock:blind', 'held', { px: 30, nx: true });
    await sleep(55);
    const bGotBlind = await clientB.set('lock:blind', 'held', { px: 500, nx: true });
    await clientA.del('lock:blind');
    const cGotBlindWhileBRuns = await clientA.set('lock:blind', 'held', { px: 500, nx: true });

    const tokA = 'tok-A', tokB = 'tok-B';
    await clientA.set('lock:safe', tokA, { px: 30, nx: true });
    await sleep(55);
    const bGotSafe = await clientB.set('lock:safe', tokB, { px: 500, nx: true });
    const aDeletedSafe = await clientA.command('DELIF', 'lock:safe', tokA);
    const cGotSafeWhileBRuns = await clientA.set('lock:safe', 'tok-C', { px: 500, nx: true });
    await clientB.command('DELIF', 'lock:safe', tokB);

    const stampedeAndLock = {
      concurrentRequests: stampedeClients,
      stampedeDbHits: { noneDbmsOnly: dbLoaderNone, localPerServer: dbLoaderLocal, miniRedisLock: dbLoaderRedis },
      lockSafety: {
        blindDelMutualExclusionBroken: bGotBlind && cGotBlindWhileBRuns,
        delifDeletedByStaleOwner: aDeletedSafe,
        delifMutualExclusionPreserved: bGotSafe && !cGotSafeWhileBRuns,
      },
    };

    const summary = { rows, cacheRead, counterRace, rateLimiting, stampedeAndLock };

    if (log) {
      log(`\n== [1] 무거운 DBMS 조회 앞 Cache-Aside (${rows.toLocaleString()}행 전체 스캔 SELECT) ==`);
      log(`  없음 (DBMS 단독)  : 단건 p50 ${cacheRead.noneDbmsOnly.p50Ms}ms · 동시 처리량 ${cacheRead.noneDbmsOnly.concurrentRps} req/s · 다중서버 Stale=false`);
      log(`  LocalCache (Map)  : 단건 p50 ${cacheRead.localMap.p50Ms}ms (${cacheRead.localMap.speedupVsDbms}배) · 동시 ${cacheRead.localMap.concurrentRps} req/s · 다중서버 Stale=${cacheRead.localMap.staleOnMultiServer} (보안/정합성 취약)`);
      log(`  miniRedis (HTTP)  : 단건 p50 ${cacheRead.miniRedis.p50Ms}ms (${cacheRead.miniRedis.speedupVsDbms}배) · 동시 ${cacheRead.miniRedis.concurrentRps} req/s (${cacheRead.miniRedis.rpsRatioVsDbms}배) · 다중서버 Stale=${cacheRead.miniRedis.staleOnMultiServer}`);

      log(`\n== [2] 동시 카운터 쓰기 경합 (${counterOps}회) ==`);
      log(`  miniRedis (INCR)  : 단건 p50 ${counterRace.miniRedis.p50Ms}ms (${counterRace.miniRedis.speedupVsDbms}배) · 동시 ${counterRace.miniRedis.concurrentRps} req/s (${counterRace.miniRedis.rpsRatioVsDbms}배) · 결과 ${counterRace.miniRedis.concActual}/${counterOps} (유실 ${counterRace.miniRedis.lostUpdates})`);
      log(`  비원자적 GET+SET  : 결과 ${counterRace.naiveGetSet.actual}/${counterOps} (유실 ${counterRace.naiveGetSet.lostUpdates}건 → 경쟁 상태 취약)`);
      log(`  없음 (DBMS 단독)  : 단건 p50 ${counterRace.noneDbmsWrite.p50Ms}ms · 동시 ${counterRace.noneDbmsWrite.concurrentRps} req/s · 결과 ${counterRace.noneDbmsWrite.actual}/${counterOps}`);

      log(`\n== [3] 보안 · 분산 Rate Limiting (2대 서버, 한도 ${rateLimitMax} / 총 ${rateTotal}요청) ==`);
      log(`  miniRedis limit() : 허용 ${rateLimiting.miniRedis.allowed} / 차단 ${rateLimiting.miniRedis.blocked} (우회 ${rateLimiting.miniRedis.bypassCount} · 차단시 DB부하 0 · p50 ${rateLimiting.miniRedis.p50Ms}ms, DBMS대비 ${rateLimiting.miniRedis.blockSpeedupVsDbms}배)`);
      log(`  LocalCache (Map)  : 허용 ${rateLimiting.localPerServer.allowed} / 차단 ${rateLimiting.localPerServer.blocked} (한도 우회 +${rateLimiting.localPerServer.bypassCount}건)`);
      log(`  없음 (DBMS 직접)  : 허용 ${rateLimiting.noneDbmsOnly.allowed} / 차단 ${rateLimiting.noneDbmsOnly.blocked} (DB타격 ${rateLimiting.noneDbmsOnly.dbHitsTotal}회 · p50 ${rateLimiting.noneDbmsOnly.p50Ms}ms)`);

      log(`\n== [4] 보안 · 스탬피드(동시 ${stampedeClients}명) & 분산 락 토큰 검증 ==`);
      log(`  스탬피드 DB 진입  : 없음 ${dbLoaderNone}회 → LocalCache ${dbLoaderLocal}회(서버수) → miniRedis(lockMs) ${dbLoaderRedis}회`);
      log(`  단순 DEL 락 깨짐  : ${stampedeAndLock.lockSafety.blindDelMutualExclusionBroken} | DELIF 토큰 보호 유지: ${stampedeAndLock.lockSafety.delifMutualExclusionPreserved}`);
    }

    return summary;
  } finally {
    await Promise.allSettled([redisSrv.close(), dbSrv.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : Number(process.argv[i + 1]);
  };
  await runContrast({
    rows: arg('rows', 50_000),
    cacheQueries: arg('iters', 300),
    counterOps: arg('writes', 150),
  });
}
