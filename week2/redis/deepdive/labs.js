/**
 * 미니 레디스 개념 더 파고들기 — 실험 계산 (DOM 없음 → 테스트에서 그대로 검증)
 *  모두 이 프로젝트의 실제 HashTable · MiniRedis 로 잰다.
 */
import { HashTable, fnv1a } from '../hashtable.js';
import { MiniRedis } from '../miniredis.js';
// 같은 씨앗이면 같은 결과 (mulberry32)
import { rng } from '../../dbms/seed.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ================================================================ 1. 좋은 해시 함수
export const HASHES = {
  fnv1a: { label: 'FNV-1a (사용 중)', fn: fnv1a },
  sum: { label: '글자 코드 합', fn: (s) => { let h = 0; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i); return h; } },
  length: { label: '문자열 길이', fn: (s) => s.length },
  first: { label: '첫 글자', fn: (s) => s.charCodeAt(0) || 0 },
};

export function makeKeys(pattern, n) {
  if (pattern === 'user') return Array.from({ length: n }, (_, i) => `user:${i}`);
  if (pattern === 'anagram') {
    // 같은 글자를 순서만 바꾼 키 — 글자 합이 전부 같다
    const base = 'abcdefgh'.split('');
    const out = new Set();
    const rand = rng(7);
    const want = Math.min(n, 40320); // 8! 가지가 최대
    for (let tries = 0; out.size < want && tries < want * 50; tries++) {
      const a = [...base];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      out.add(a.join(''));
    }
    return [...out];
  }
  return Array.from({ length: n }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${i}@mail.com`);
}

/** 버킷마다 몇 개가 들어가나 */
export function distribution(hashFn, keys, buckets = 64) {
  const counts = new Array(buckets).fill(0);
  for (const k of keys) counts[(hashFn(k) >>> 0) % buckets]++;
  const max = Math.max(...counts);
  const empty = counts.filter((c) => c === 0).length;
  // 성공한 조회의 평균 비교 횟수 = Σ c(c+1)/2 / n
  const probes = counts.reduce((s, c) => s + (c * (c + 1)) / 2, 0) / keys.length;
  return { counts, max, empty, probes };
}

// ================================================================ 2. 부하율
/** 부하율 alpha 로 고정한 테이블에서 조회 한 번에 비교를 몇 번 하는지 (확장 끔) */
export function measureLoad(alpha, n = 4096) {
  const t = new HashTable({ initialSize: Math.max(4, Math.round(n / alpha)) });
  t.resizable = false;
  const keys = Array.from({ length: n }, (_, i) => `k:${i}`);
  for (const k of keys) t.set(k, 1);
  const snap = t.snapshot();
  const lens = snap.tables[0].buckets.map((b) => b.length);
  const probes = lens.reduce((s, c) => s + (c * (c + 1)) / 2, 0) / n;
  return { alpha: n / snap.tables[0].size, buckets: snap.tables[0].size, probes, theory: 1 + (n / snap.tables[0].size) / 2, maxChain: Math.max(...lens) };
}

// ================================================================ 3. 한 번에 리해시 vs 점진적
/** n 개를 넣는 동안 "가장 오래 걸린 SET 한 번" 을 잰다 */
export function rehashLatency(n, mode = 'incremental') {
  let queueFinish = false;
  const t = new HashTable({
    onEvent: mode === 'stop-the-world' ? (e) => { if (e.type === 'resize-start') queueFinish = true; } : null,
  });
  const times = [];
  let maxMoved = 0; // 연산 한 번에 옮긴 원소 수의 최댓값 (시간과 달리 GC 등 잡음이 없다)
  const t0 = now();
  for (let i = 0; i < n; i++) {
    const moved0 = t.stats.moved;
    const a = now();
    t.set(`key:${i}`, i);
    if (queueFinish) { queueFinish = false; t.finishRehash(); } // 확장을 시작하자마자 전부 옮김 (한 번에)
    times.push(now() - a);
    maxMoved = Math.max(maxMoved, t.stats.moved - moved0);
  }
  const total = now() - t0;
  times.sort((x, y) => x - y);
  return { n, mode, totalMs: total, maxMs: times.at(-1), p99Ms: times[Math.floor(times.length * 0.99)], resizes: t.stats.resizes, maxMoved };
}

// ================================================================ 4. 긴 명령 하나가 모두를 막는다
export function blockingCost(n = 100_000) {
  const r = new MiniRedis();
  for (let i = 0; i < n; i++) r.command(['SET', `k:${i}`, 'v']);
  let t = now();
  const keys = r.command(['KEYS', '*']).length;
  const keysMs = now() - t;
  t = now();
  const G = 20000;
  for (let i = 0; i < G; i++) r.command(['GET', `k:${i % n}`]);
  const getUs = ((now() - t) / G) * 1000;
  return { n, keys, keysMs, getUs, couldServe: Math.floor((keysMs * 1000) / getUs) };
}

// ================================================================ 5. 주기 삭제 표본 크기
/** 가짜 시계로 주기 삭제를 cycles 번 돌리며 남은 만료 키 수를 기록 */
export function simulateActiveExpire({ n = 2000, expiredRatio = 0.5, sample = 20, cycles = 30, seed = 1 } = {}) {
  const rand = rng(seed);
  const clock = { t: 1000 };
  const r = new MiniRedis({ now: () => clock.t, random: rand, sample });
  const expiredN = Math.round(n * expiredRatio);
  for (let i = 0; i < n; i++) r.command(['SET', `k:${i}`, 'v', 'PX', String(i < expiredN ? 10 : 1_000_000)]);
  clock.t += 100;
  const left = [expiredN];
  const work = [];
  for (let c = 0; c < cycles; c++) {
    const before = r.stats.expiredActive;
    r.activeExpireCycle();
    left.push(expiredN - r.stats.expiredActive);
    work.push(r.stats.expiredActive - before);
  }
  return { left, work, expiredN };
}

// ================================================================ 6. 캐시 스탬피드
/**
 * 캐시가 비어 있는 순간 clients 명이 동시에 요청
 * protect: 한 명만 DB 에 가고(SET NX 락) 나머지는 잠깐 기다렸다 캐시를 다시 봄
 */
export async function stampede({ clients = 100, protect = false, dbMs = 80 } = {}) {
  const r = new MiniRedis();
  let dbQueries = 0;
  const db = async () => { dbQueries++; await sleep(dbMs); return '{"price":1000}'; };
  const t0 = now();
  await Promise.all(Array.from({ length: clients }, async (_, i) => {
    await sleep(Math.random() * 5);
    for (let attempt = 0; attempt < 100; attempt++) {
      const hit = r.command(['GET', 'hot']);
      if (hit !== null) return hit;
      if (!protect) {
        const v = await db();
        r.command(['SET', 'hot', v, 'EX', '60']);
        return v;
      }
      if (r.command(['SET', 'lock:hot', `c${i}`, 'NX', 'PX', '2000']) === 'OK') {
        const v = await db();
        r.command(['SET', 'hot', v, 'EX', '60']);
        r.command(['DEL', 'lock:hot']);
        return v;
      }
      await sleep(10); // 누가 채우는 중 → 잠깐 뒤 다시
    }
    return null;
  }));
  return { clients, protect, dbQueries, ms: now() - t0 };
}

// ================================================================ 7. AOF 크기
export function aofGrowth(ops = 5000, keys = 50) {
  const lines = [];
  const r = new MiniRedis({ onWrite: (a) => lines.push(JSON.stringify(a)) });
  const r01 = rng(3);
  const rand = (m) => Math.floor(r01() * m);
  for (let i = 0; i < ops; i++) {
    const k = `k:${rand(keys)}`;
    const op = rand(10);
    if (op < 6) r.command(['INCR', k]);
    else if (op < 9) r.command(['SET', k, String(i)]);
    else r.command(['DEL', k]);
  }
  const full = lines.join('\n');
  const compact = r.rewriteAof();
  let t = now();
  new MiniRedis().loadAof(full);
  const replayFull = now() - t;
  t = now();
  new MiniRedis().loadAof(compact);
  const replayCompact = now() - t;
  return { ops, keys, lines: lines.length, bytes: full.length, compactLines: compact.trim() ? compact.trim().split('\n').length : 0, compactBytes: compact.length, replayFull, replayCompact };
}
