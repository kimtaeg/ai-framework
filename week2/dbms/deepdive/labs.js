/**
 * 미니 DBMS 개념 더 파고들기 — 실험 계산 (DOM 없음 → 테스트에서 그대로 검증)
 *  모두 이 프로젝트의 실제 SQL 처리기 · BPlusTree · RWLock 으로 잰다.
 */
import { BPlusTree } from '../bptree.js';
import { RWLock, LockManager } from '../lock.js';
import { Database } from '../engine.js';
import { MemoryStorage, encodeRow } from '../storage.js';
// 같은 씨앗이면 같은 결과 (mulberry32)
import { rng } from '../seed.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => performance.now();

// ================================================================ 8. 차수와 높이
export function heightFor(order, n) {
  const t = new BPlusTree(order);
  for (let i = 1; i <= n; i++) t.insert(i, i);
  const visits = t.trace(Math.ceil(n / 2)).path.length;
  return { order, n, height: t.height, visits, theory: Math.ceil(Math.log(n) / Math.log(Math.ceil(order / 2))), binary: Math.ceil(Math.log2(n + 1)) };
}

// ================================================================ 9. 노드 채움률
export function fillFactor(order, n, mode = 'sequential') {
  const t = new BPlusTree(order);
  const keys = Array.from({ length: n }, (_, i) => i + 1);
  if (mode === 'random') {
    const rand = rng(11);
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
  }
  for (const k of keys) t.insert(k, k);
  const leaves = t.levels().at(-1);
  const fill = leaves.reduce((sum, l) => sum + l.keys.length, 0) / (leaves.length * t.maxKeys);
  return { order, n, mode, leaves: leaves.length, fill, splits: t.stats.splits, height: t.height };
}

// ================================================================ 10. 교착 상태
/**
 * 두 트랜잭션이 테이블 두 개를 반대 순서로 잠그려 함
 * sorted=false: 원하는 순서대로 하나씩 (RWLock 직접) → 교착 / true: LockManager(이름 순서) → 정상
 */
export async function deadlockDemo({ sorted = false, holdMs = 60, timeoutMs = 400 } = {}) {
  const log = [];
  const t0 = nowMs();
  const note = (who, what) => log.push({ t: Math.round(nowMs() - t0), who, what });
  const finished = [];
  if (sorted) {
    const m = new LockManager();
    await Promise.all([
      ['T1', ['users', 'products']],
      ['T2', ['products', 'users']],
    ].map(async ([who, tables]) => {
      note(who, `${tables.join(', ')} 쓰기 락 요청 (이름 순서로 잡음)`);
      const release = await m.acquire({ write: tables });
      note(who, '두 락 모두 잡음 → 작업');
      await sleep(holdMs);
      release();
      note(who, '완료, 해제');
      finished.push(who);
    }));
    return { sorted, deadlocked: false, finished, log };
  }
  const locks = { users: new RWLock('users'), products: new RWLock('products') };
  const run = async (who, first, second) => {
    const r1 = await locks[first].acquire('write');
    note(who, `${first} 잡음`);
    await sleep(holdMs); // 작업 중간에 두 번째 테이블이 필요해짐
    note(who, `${second} 기다리는 중…`);
    const r2 = await Promise.race([locks[second].acquire('write'), sleep(timeoutMs).then(() => null)]);
    if (!r2) {
      note(who, `${timeoutMs}ms 기다려도 못 잡음 → 교착 (상대가 ${second} 를 쥐고 ${first} 를 기다림)`);
      r1();
      return;
    }
    note(who, '두 락 모두 잡음 → 작업');
    r2();
    r1();
    finished.push(who);
  };
  await Promise.all([run('T1', 'users', 'products'), run('T2', 'products', 'users')]);
  return { sorted, deadlocked: finished.length < 2, finished, log };
}

// ================================================================ 11. 스레드 수와 처리량 (시뮬레이션)
/**
 * 작업 하나 = CPU 계산 cpuMs + 디스크/네트워크 대기 ioMs.  CPU 코어는 cores 개.
 * 워커가 workers 개일 때 jobs 개를 끝내는 시간을 이산 시뮬레이션으로 계산 (1ms 단위)
 */
export function poolThroughput({ workers = 4, cores = 4, cpuMs = 10, ioMs = 0, jobs = 200 } = {}) {
  let waiting = jobs;
  const ws = Array.from({ length: workers }, () => ({ phase: 'idle', left: 0 }));
  let t = 0, done = 0;
  while (done < jobs && t < 1e6) {
    for (const w of ws) if (w.phase === 'idle' && waiting > 0) { waiting--; w.phase = 'cpu'; w.left = cpuMs; }
    // CPU 를 원하는 워커 중 cores 개만 이번 1ms 에 진행 (나머지는 순서를 기다림 = 문맥 전환 대기)
    let free = cores;
    for (const w of ws) {
      if (w.phase === 'cpu' && free > 0) { free--; w.left--; if (w.left <= 0) { w.phase = ioMs ? 'io' : 'idle'; w.left = ioMs; if (!ioMs) done++; } }
      else if (w.phase === 'io') { w.left--; if (w.left <= 0) { w.phase = 'idle'; done++; } }
    }
    t++;
  }
  return { workers, cores, cpuMs, ioMs, jobs, ms: t, perSec: Math.round((jobs / t) * 1000) };
}

// ================================================================ 12. 인덱스의 비용
const USERS = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
const usersDb = (order = 64) => new Database(new MemoryStorage(JSON.parse(JSON.stringify(USERS))), { order });

/** 같은 n 건을 "파일에만 쓰기" vs "파일 + B+ 트리 등록" 으로 넣는 시간 */
export function indexCost(n = 50_000) {
  const rand = rng(5);
  const rows = Array.from({ length: n }, (_, i) => [i + 1, `user${i}`, 20 + Math.floor(rand() * 40), `user${i}@x.com`]);
  // 처음 도는 쪽이 JIT 준비 때문에 느려지므로, 번갈아 3번씩 재서 가장 빠른 값을 쓴다
  let withoutMs = Infinity, withMs = Infinity, tree = null;
  for (let rep = 0; rep < 3; rep++) {
    // ① 인덱스 없이: 한 줄로 인코딩해서 저장소 끝에 붙이기만
    const plain = new MemoryStorage(JSON.parse(JSON.stringify(USERS)));
    let t0 = nowMs();
    for (const r of rows) plain.append('users', encodeRow(r));
    withoutMs = Math.min(withoutMs, nowMs() - t0);
    // ② 인덱스 있게: 같은 저장 + B+ 트리 등록
    tree = new BPlusTree(64);
    const indexed = new MemoryStorage(JSON.parse(JSON.stringify(USERS)));
    t0 = nowMs();
    for (const r of rows) tree.insert(r[0], indexed.append('users', encodeRow(r)));
    withMs = Math.min(withMs, nowMs() - t0);
  }
  const nodes = tree.levels().reduce((s, l) => s + l.length, 0);
  return { n, withoutMs, withMs, extraMs: withMs - withoutMs, nodes, splits: tree.stats.splits, height: tree.height };
}

// ================================================================ 13. 범위가 넓으면 인덱스가 손해?
/**
 * id 범위로 전체의 pct% 를 읽을 때, 인덱스 범위 조회 vs 전체 읽기
 * 디스크라면: 인덱스는 레코드마다 따로 찾아가서 읽기(임의 접근), 전체 읽기는 처음부터 쭉(순차 접근)
 *   비용 모델 — 임의 읽기 1건 0.1ms, 순차 읽기 1건 0.002ms (HDD/SSD 의 대략적인 비율을 단순화)
 */
export function selectivity(n = 20_000, pcts = [0.1, 1, 5, 10, 25, 50, 100]) {
  const db = usersDb();
  const rand = rng(9);
  db.insert({ type: 'insert', table: 'users', columns: null, rows: Array.from({ length: n }, (_, i) => [{ kind: 'string', value: `u${i}` }, { kind: 'number', value: 20 + Math.floor(rand() * 40) }, { kind: 'string', value: `u${i}@x` }]), pos: null });
  const RANDOM = 0.1, SEQ = 0.002;
  return pcts.map((pct) => {
    const hi = Math.max(1, Math.round((n * pct) / 100));
    const [idx] = db.execute(`SELECT id FROM users WHERE id <= ${hi}`);
    const [scan] = db.execute(`SELECT id FROM users WHERE age >= 0 AND id != 0 AND name != '' LIMIT ${n}`);
    return { pct, rows: idx.rows.length, indexReads: idx.plan.scanned, scanReads: scan.plan.scanned, indexMs: idx.plan.scanned * RANDOM, scanMs: scan.plan.scanned * SEQ };
  });
}

// ================================================================ 14. 작은 실행 계획기가 하는 일
export const PLAN_QUERIES = [
  'SELECT * FROM users WHERE id = 500',
  "SELECT * FROM users WHERE name = 'u499' AND id = 500",
  'SELECT * FROM users WHERE id BETWEEN 100 AND 109',
  'SELECT * FROM users WHERE id > 995',
  'SELECT * FROM users WHERE id != 500 LIMIT 3',
  'SELECT * FROM users WHERE age = 30',
  'SELECT * FROM users WHERE id = 3 AND id = 4',
];

export function plans(queries = PLAN_QUERIES, n = 1000) {
  const db = usersDb();
  db.insert({ type: 'insert', table: 'users', columns: null, rows: Array.from({ length: n }, (_, i) => [{ kind: 'string', value: `u${i}` }, { kind: 'number', value: 20 + (i % 40) }, { kind: 'string', value: `u${i}@x` }]), pos: null });
  return queries.map((sql) => {
    const [r] = db.execute(sql);
    return { sql, plan: r.plan.type, reason: r.plan.reason, scanned: r.plan.scanned, rows: r.rows.length };
  });
}
