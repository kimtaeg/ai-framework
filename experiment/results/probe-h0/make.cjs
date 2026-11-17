// 사용: node make.cjs <프로젝트 루트>  — experiment/app.js 사본에 계측을 넣어 이 폴더의 app.js 로 쓴다 (원본은 안 건드림)
const fs = require('fs');
const path = require('path');
let s = fs.readFileSync(path.join(process.argv[2], 'experiment', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const rep = (from, to) => { if (!s.includes(from)) throw new Error('못 찾음: ' + from); s = s.replace(from, to); };

// 묶음 처리 끄기 (11월 10일 측정 당시 풀과 같게): MAX_BATCH=1
rep("const DB_OPTS = { dir: DATA_DIR, workers: DB_WORKERS, autoIndex: false, snapshotReads: false };",
  "const DB_OPTS = { dir: DATA_DIR, workers: DB_WORKERS, autoIndex: false, snapshotReads: false, ...(process.env.MAX_BATCH ? { maxBatch: Number(process.env.MAX_BATCH) } : {}) };");

// 계측: /admin/cpu 를 부를 때마다 "직전 호출 이후" 의 값을 저장하고 0 으로 → 마지막 저장분이 k6 측정 구간과 정확히 같다
rep("async function load(origin, id, wait = 0) {",
  `const P0 = () => ({ n: 0, waited: 0, lock: 0, exec: 0, db: 0, qAtArrive: 0, cacheGet: 0, cacheSet: 0, reqs: 0, inflightAtArrive: 0, total: 0, posts: 0 });
let probe = P0(), inflight = 0, lastProbe = null, elu0 = null;
const eluNow = () => ({ main: performance.eventLoopUtilization(), workers: db.pool.workers.map((w) => w.worker.performance.eventLoopUtilization()), ids: db.pool.workers.map((w) => w.worker.threadId) });
function probeMark() {
  const now = eluNow();
  if (elu0) {
    const same = elu0.ids.join() === now.ids.join();
    lastProbe = { ...probe, mainElu: performance.eventLoopUtilization(now.main, elu0.main).utilization,
      workerElu: same ? now.workers.map((w, i) => db.pool.workers[i].worker.performance.eventLoopUtilization(w, elu0.workers[i]).utilization) : null,
      maxQueue: db.pool.stats.maxQueue, maxBatch: db.pool.maxBatch ?? null };
  }
  elu0 = now; probe = P0();
}
async function load(origin, id, wait = 0) {
  const t = performance.now();
  probe.qAtArrive += db.pool.queue.length - (db.pool.queueHead ?? 0);
  try { return await load0(origin, id, wait); } finally { probe.db += performance.now() - t; }
}
async function load0(origin, id, wait = 0) {`);
rep("const r = await db.query(sqlFor(origin, id));",
  "const r = await db.query(sqlFor(origin, id));\n  probe.n++; probe.waited += r.waitedMs ?? 0; probe.lock += r.lockMs ?? 0; probe.exec += r.execMs ?? 0;");
rep("const server = createServer(async (req, res) => {\n  const t0 = performance.now();",
  "const server = createServer(async (req, res) => {\n  const t0 = performance.now();\n  probe.reqs++; probe.inflightAtArrive += inflight; inflight++;\n  res.once('close', () => { inflight--; probe.total += performance.now() - t0; });");
rep("const cached = await cache.get(ckey);",
  "const tg = performance.now();\n      const cached = await cache.get(ckey);\n      probe.cacheGet += performance.now() - tg;");
rep("await cache.set(ckey, JSON.stringify(row), { ttl: TTL });",
  "const ts = performance.now();\n      await cache.set(ckey, JSON.stringify(row), { ttl: TTL });\n      probe.cacheSet += performance.now() - ts;");
// 워커로 보낸 메시지 수 (묶음이면 요청 수보다 적다)
rep("async function resetDb() {\n  await db.close();",
  "function hook() { for (const w of db.pool.workers) { const o = w.worker.postMessage.bind(w.worker); w.worker.postMessage = (m) => { probe.posts++; return o(m); }; } }\nhook();\nasync function resetDb() {\n  await db.close();");
rep("  db = createDbService(DB_OPTS);\n  const t = await db.tables();", "  db = createDbService(DB_OPTS);\n  hook(); elu0 = null;\n  const t = await db.tables();");
rep("if (url.pathname === '/admin/reset' && req.method === 'POST') {",
  "if (url.pathname === '/admin/probe') return send(res, 200, lastProbe ?? {});\n    if (url.pathname === '/admin/cpu') probeMark();\n    if (url.pathname === '/admin/reset' && req.method === 'POST') {");
// SPIN=1: 메인 스레드가 잠들지 않게 한다 (이벤트가 없어도 계속 돈다)
s += "\nif (process.env.SPIN === '1') { const spin = () => setImmediate(spin); spin(); console.log('SPIN on'); }\n";
fs.writeFileSync(path.join(__dirname, 'app.js'), s);
console.log('ok', s.length);
