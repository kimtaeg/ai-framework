/**
 * 대안 기술 비교 (Node 로 직접): 우리가 쓴 기술 vs 비슷한 다른 기술
 *   node load/alt-bench.js index     B+ 트리 vs 해시(Map) vs 정렬 배열 + 이진 탐색
 *   node load/alt-bench.js pool      스레드 풀 재사용 vs 요청마다 새 워커 vs 메인 스레드에서 바로
 *   node load/alt-bench.js persist   AOF everysec vs AOF always vs 스냅샷(전체 저장, RDB 방식)
 * 마지막 줄에 RESULT {json} 을 찍는다 (테스트 실험실이 읽어 감). 첫 번째 variant 가 우리 기술.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BPlusTree } from '../week2/dbms/bptree.js';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { seedRows } from '../week2/dbms/seed.js';
import { ThreadPool } from '../week2/dbms/pool.js';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { AofFile } from '../week2/redis/persistence.js';

const now = () => performance.now();
const r2 = (x) => (Math.abs(x) < 1 ? Math.round(x * 1000) / 1000 : Math.round(x * 100) / 100);
/** 이벤트 루프가 가장 오래 멈춘 시간(ms) — 그동안 서버는 다른 요청에 답을 못 함 */
const stallMeter = () => { const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); return () => { h.disable(); return Math.max(0, h.max / 1e6 - 1); }; };
const yieldNow = () => new Promise((r) => setImmediate(r));
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffled = (n, seed) => { const a = Array.from({ length: n }, (_, i) => i); const R = rng(seed); for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const best = (fn, times = 3) => { let m = Infinity; for (let i = 0; i < times; i++) m = Math.min(m, fn()); return m; };

// ---------------------------------------------------------------- 인덱스
/** 정렬 배열 + 이진 탐색 (넣을 때마다 자리를 찾아 끼워 넣음) */
class SortedArrayIndex {
  constructor() { this.keys = []; this.values = []; }
  #lb(k) { let lo = 0, hi = this.keys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.keys[m] < k) lo = m + 1; else hi = m; } return lo; }
  insert(k, v) { const i = this.#lb(k); this.keys.splice(i, 0, k); this.values.splice(i, 0, v); }
  get(k) { const i = this.#lb(k); return this.keys[i] === k ? this.values[i] : undefined; }
  *range(lo, hi) { for (let i = this.#lb(lo); i < this.keys.length && this.keys[i] <= hi; i++) yield [this.keys[i], this.values[i]]; }
}
/** 해시 (Map): 같은지 찾기는 빠르지만 순서가 없어서 범위는 전부 훑어야 함 */
class HashIndex {
  constructor() { this.map = new Map(); }
  insert(k, v) { this.map.set(k, v); }
  get(k) { return this.map.get(k); }
  *range(lo, hi) { const out = []; for (const [k, v] of this.map) if (k >= lo && k <= hi) out.push([k, v]); out.sort((a, b) => a[0] - b[0]); yield* out; }
}

export function benchIndex({ n = 100_000, lookups = 100_000, ranges = 200, span = 1000, log = console.log } = {}) {
  const order = shuffled(n, 7);
  const probes = shuffled(n, 11).slice(0, lookups);
  const variants = [
    ['B+ 트리 (우리 DBMS)', () => new BPlusTree(64)],
    ['해시 인덱스 (Map)', () => new HashIndex()],
    ['정렬 배열 + 이진 탐색', () => new SortedArrayIndex()],
  ];
  const out = [];
  for (const [label, make] of variants) {
    let idx;
    const buildMs = best(() => { const t0 = now(); idx = make(); for (const k of order) idx.insert(k, k); return now() - t0; }, 2);
    const lookupMs = best(() => { const t0 = now(); let s = 0; for (const k of probes) s += idx.get(k); if (s < 0) throw 0; return now() - t0; });
    const R = rng(3);
    const rangeMs = best(() => { const t0 = now(); let c = 0; for (let i = 0; i < ranges; i++) { const lo = Math.floor(R() * (n - span)); for (const _ of idx.range(lo, lo + span - 1)) c++; } if (c !== ranges * span) throw new Error(`범위 결과 ${c}`); return now() - t0; });
    const m = { buildMs: r2(buildMs), lookupUs: r2((lookupMs * 1000) / lookups), rangeMs: r2(rangeMs / ranges) };
    log(`${label}: 10만 개 넣기 ${m.buildMs}ms · 점 조회 ${m.lookupUs}μs · 1,000개 범위 ${m.rangeMs}ms`);
    out.push({ label, metrics: m });
  }
  return { main: 'rangeMs', variants: out, note: `키 ${n.toLocaleString()}개 (무작위 순서로 넣음) · 점 조회 ${lookups.toLocaleString()}번 · 1,000개 범위 ${ranges}번` };
}

// ---------------------------------------------------------------- 스레드 풀
export async function benchPool({ rows = 20_000, queries = 120, concurrency = 4, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alt-pool-'));
  try {
    const fsx = new FileStorage(dir);
    const db = new Database(fsx, { order: 64 });
    seedRows(db, 'users', rows);
    fsx.close?.();
    const worker = new URL('../week2/dbms/worker.js', import.meta.url);
    const sqls = Array.from({ length: queries }, (_, i) => `SELECT * FROM users WHERE email = 'user${(i * 7919) % rows}@jungle.test'`);

    /** 그동안 메인 스레드(이벤트 루프)가 일하느라 바빴던 비율 — 높을수록 다른 요청에 답할 틈이 없음 */
    const lagMeter = () => { const e0 = performance.eventLoopUtilization(); return () => performance.eventLoopUtilization(e0).utilization * 100; };
    const runAll = async (fn) => { let i = 0; const one = async () => { while (i < sqls.length) { const s = sqls[i++]; await fn(s); } }; await Promise.all(Array.from({ length: concurrency }, one)); };
    const out = [];

    // 1) 스레드 풀 재사용
    const pool = new ThreadPool(worker, { size: concurrency, workerData: { dir } });
    await pool.ready();
    let stop = lagMeter(), t0 = now();
    await runAll((sql) => pool.run({ sql }));
    let ms = now() - t0, lag = stop();
    await pool.close();
    out.push({ label: `스레드 풀 재사용 (워커 ${concurrency}개)`, metrics: { msPerQuery: r2(ms / queries), mainBusy: Math.round(lag) } });

    // 2) 요청마다 새 워커 (만들고 → 인덱스 읽고 → 한 번 쓰고 → 버림)
    const few = sqls.slice(0, Math.min(24, queries));
    stop = lagMeter(); t0 = now();
    { let i = 0; const one = async () => { while (i < few.length) { const sql = few[i++]; const p = new ThreadPool(worker, { size: 1, workerData: { dir } }); await p.ready(); await p.run({ sql }); await p.close(); } }; await Promise.all(Array.from({ length: concurrency }, one)); }
    ms = now() - t0; lag = stop();
    out.push({ label: '요청마다 새 워커', metrics: { msPerQuery: r2(ms / few.length), mainBusy: Math.round(lag) } });

    // 3) 메인 스레드에서 바로 (워커 없음)
    const mainDb = new Database(new FileStorage(dir), { order: 64 });
    stop = lagMeter(); t0 = now();
    for (const sql of sqls) { mainDb.execute(sql); await yieldNow(); }
    ms = now() - t0; lag = stop();
    out.push({ label: '메인 스레드에서 바로', metrics: { msPerQuery: r2(ms / queries), mainBusy: Math.round(lag) } });

    for (const v of out) log(`${v.label}: 쿼리 1개당 ${v.metrics.msPerQuery}ms · 메인 스레드 사용 ${v.metrics.mainBusy}%`);
    return { main: 'msPerQuery', variants: out, note: `users ${rows.toLocaleString()}행에서 email 로 찾기(전체 읽기) · 동시에 ${concurrency}개씩` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 영속성
export async function benchPersist({ maxOps = 300_000, seconds = 4, keys = 100_000, snapshotEveryWrites = 50_000, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alt-persist-'));
  try {
    const run = async (label, setup) => {
      const R = rng(5); // 세 방식 모두 같은 쓰기 순서
      const file = join(dir, `${Math.random().toString(36).slice(2)}.dat`);
      const { redis, afterWrite, finish } = setup(file);
      // 미리 키를 채워 둔다 (스냅샷은 "데이터 전체" 를 저장하므로 데이터 크기가 비용을 정함)
      for (let i = 0; i < keys; i++) redis.command(['SET', `k${i}`, 'v0']);
      redis.onWriteReady?.();
      let ops = 0;
      const stop = stallMeter();
      const t0 = now(), end = t0 + seconds * 1000;
      while (now() < end && ops < maxOps) {
        for (let i = 0; i < 200; i++) { redis.command(['SET', `k${Math.floor(R() * keys)}`, `v${ops}`]); ops++; afterWrite?.(ops); }
        await yieldNow(); // 타이머(1초마다 묶어 쓰기) 가 돌 틈
      }
      const elapsed = now() - t0;
      finish();
      const stall = stop();
      const r0 = now();
      new MiniRedis().loadAof(readFileSync(file, 'utf8'));
      return { label, metrics: { writesPerSec: Math.round(ops / (elapsed / 1000)), blockMs: r2(stall), fileKB: Math.round(statSync(file).size / 1024), recoverMs: r2(now() - r0) } };
    };
    const aof = (policy) => (file) => {
      const redis = new MiniRedis();
      let f = null;
      // 미리 채우는 쓰기는 기록하지 않고 첫 파일로 한 번에 (모든 방식이 같은 출발점)
      redis.onWriteReady = () => { writeFileSync(file, redis.rewriteAof()); f = new AofFile(file, { fsync: policy }); redis.onWrite = (args) => f.append(args); };
      return { redis, finish: () => f.close() };
    };
    const snapshot = (file) => {
      const redis = new MiniRedis();
      const save = () => { const tmp = `${file}.tmp`; writeFileSync(tmp, redis.rewriteAof()); renameSync(tmp, file); };
      redis.onWriteReady = save;
      return { redis, afterWrite: (ops) => { if (ops % snapshotEveryWrites === 0) save(); }, finish: save };
    };
    const out = [
      await run('AOF everysec — 우리 기본 (꺼지면 최대 1초치 손실)', aof('everysec')),
      await run('AOF always (손실 없음)', aof('always')),
      await run(`스냅샷, 쓰기 ${snapshotEveryWrites.toLocaleString()}번마다 전체 저장 — RDB 방식 (꺼지면 최대 ${snapshotEveryWrites.toLocaleString()}개 손실)`, snapshot),
    ];
    for (const v of out) log(`${v.label}: 초당 쓰기 ${v.metrics.writesPerSec.toLocaleString()} · 멈춤 최대 ${v.metrics.blockMs}ms · 파일 ${v.metrics.fileKB.toLocaleString()}KB · 복구 ${v.metrics.recoverMs}ms`);
    return { main: 'writesPerSec', variants: out, note: `키 ${keys.toLocaleString()}개를 채운 뒤 최대 ${maxOps.toLocaleString()}번(또는 ${seconds}초) SET 으로 덮어씀 · AOF 는 재작성(rewrite) 없이 쌓인 크기` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const what = process.argv[2];
  const fn = { index: benchIndex, pool: benchPool, persist: benchPersist }[what];
  if (!fn) { console.error('사용법: node load/alt-bench.js index|pool|persist'); process.exit(2); }
  const result = await fn();
  console.log(`RESULT ${JSON.stringify(result)}`);
}
