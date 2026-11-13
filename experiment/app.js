/**
 * 캐시 실험용 API 서버 — 원본은 "진짜" 미니 DBMS (가짜 sleep 아님), 캐시는 요청마다 바꿔 끼운다.
 *
 *   GET  /item/:id?backend=none|mini|redis&origin=index|scan[&v=유일값]
 *        backend  none  캐시 없이 매번 DB
 *                 mini  미니 레디스 (별도 컨테이너, HTTP + JSON)
 *                 miniresp 같은 미니 레디스 · 같은 저장소를 RESP over TCP 로 (통신 방식만 Redis 와 같게)
 *                 redis 실제 Redis 7 (별도 컨테이너, RESP over TCP)
 *        origin   index  SELECT * FROM products WHERE id = ?      (B+ 트리, 가벼운 쿼리)
 *                 scan   SELECT * FROM products WHERE name = ?    (전체 읽기, 무거운 쿼리)
 *        v        캐시 키에 붙는 꼬리표. 매번 다른 값을 주면 반드시 MISS → 히트율을 정확히 조절할 수 있다
 *   POST /item/:id?backend=..   쓰기: DB INSERT(쓰기 락) + 그 상품 캐시 무효화(DEL)
 *                               (미니 DBMS 에 UPDATE 가 없어서 INSERT 로 쓰기 비용을 대신한다)
 *   POST /admin/reset           두 캐시 모두 비우기 + products 를 정확히 ROWS 건으로 되돌리기 (측정마다)
 *   GET  /admin/info            환경 정보 (행 수, 워커 수, 버전)
 *   GET  /admin/cpu             지금까지 쓴 CPU 시간(µs): 앱 서버 · 미니 레디스 · Redis (k6 가 측정 시작 · 끝에 불러 차이를 낸다)
 *   GET  /admin/rtt?backend=..&n=  캐시까지 PING 왕복 시간 (네트워크 지연을 넣었는지 확인용)
 *
 *  응답 헤더: X-Cache HIT|MISS|BYPASS, X-Server-Ms (서버 안에서 걸린 시간)
 */
import { createServer } from 'node:http';
import { mkdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { seedRows } from '../week2/dbms/seed.js';
import { createDbService } from '../week2/dbms/service.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { nodeFetch } from '../week2/redis/node-fetch.js';
import { RespClient } from './resp.js';

const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env('PORT', 8080));
const DATA_DIR = env('DATA_DIR', './experiment/.data');
const ROWS = Number(env('ROWS', 100000));
const DB_WORKERS = Number(env('DB_WORKERS', 2));
const TTL = Number(env('TTL', 300));
const CATS = ['키보드', '마우스', '모니터', '케이블', '스탠드'];

// 1) 데이터 준비: products 를 정확히 ROWS 건으로 (씨앗 42 → 누가 돌려도 같은 데이터)
//    쓰기 실험(YCSB A·B)이 INSERT 로 행을 늘리면 전체 읽기가 점점 느려져 다음 측정을 오염시킨다.
//    → 시작할 때 정확히 ROWS 건이 아니면 새로 만들고, 그때의 파일 크기를 기억해 두었다가
//      /admin/reset 때마다 파일을 그 크기로 잘라서(INSERT 는 파일 끝에만 붙으므로) ROWS 건으로 되돌린다.
mkdirSync(DATA_DIR, { recursive: true });
const TBL = join(DATA_DIR, 'products.tbl');
{
  let storage = new FileStorage(DATA_DIR);
  let seeded = new Database(storage);
  const have = seeded.tables.products.index.size;
  if (have !== ROWS) {
    storage.close();
    if (have) truncateSync(TBL, 0);
    storage = new FileStorage(DATA_DIR);
    seeded = new Database(storage);
    const t0 = performance.now();
    seedRows(seeded, 'products', ROWS);
    console.log(`products ${ROWS}건 새로 준비 (${((performance.now() - t0) / 1000).toFixed(1)}초, 이전 ${have}건)`);
  } else console.log(`products ${have}건 이미 있음`);
  storage.close();
}
const BASE_BYTES = statSync(TBL).size;

// 발표한 측정 결과와 같은 조건으로 고정한다: id 가 아닌 열은 선형 탐색, 쓰는 동안 조회는 기다림
const DB_OPTS = { dir: DATA_DIR, workers: DB_WORKERS, autoIndex: false, snapshotReads: false };
let db = createDbService(DB_OPTS);
async function resetDb() {
  await db.close(); // 이전 측정에서 밀려 있던 쿼리도 함께 끊긴다
  truncateSync(TBL, BASE_BYTES);
  db = createDbService(DB_OPTS);
  const t = await db.tables();
  const rows = t.find((x) => x.table === 'products').rows;
  if (rows !== ROWS) throw new Error(`products 가 ${rows}건입니다 (기대 ${ROWS}건)`);
  return rows;
}
// 내장 fetch 대신 연결을 재사용하는 가벼운 node:http 요청 (같은 HTTP + JSON, 요청당 CPU 만 줄임)
const mini = new MiniRedisClient(env('MINI_URL', 'http://127.0.0.1:6380'), { fetch: nodeFetch });
const redis = new RespClient({ host: env('REDIS_HOST', '127.0.0.1'), port: Number(env('REDIS_PORT', 6379)) });
// miniresp 는 처음 쓸 때 연결한다 (미니 레디스에 RESP 포트가 없는 환경에서도 나머지는 그대로 동작)
let miniResp = null;
const caches = {
  none: null, mini, redis,
  get miniresp() { return (miniResp ??= new RespClient({ host: env('MINI_HOST', '127.0.0.1'), port: Number(env('MINI_RESP_PORT', 6381)) })); },
};

// 프로세스별 누적 CPU 시간(µs). 못 읽은 쪽은 null
async function cpuSnapshot() {
  const u = process.cpuUsage(); // 메인 스레드 + DB 워커 스레드 모두 (프로세스 전체)
  const safe = (p) => p.then((v) => v, () => null);
  const [miniUs, redisUs] = await Promise.all([
    safe(caches.miniresp.command('XCPU').then(Number)),
    safe(redis.command('INFO', 'cpu').then((s) => {
      const g = (k) => Number(s.match(new RegExp(`${k}:([\\d.]+)`))?.[1]);
      return Math.round((g('used_cpu_user') + g('used_cpu_sys')) * 1e6);
    })),
  ]);
  return { appUs: u.user + u.system, miniUs, redisUs, at: performance.now() };
}

const sqlFor = (origin, id) =>
  origin === 'scan' ? `SELECT * FROM products WHERE name = '${CATS[id % 5]} ${id}'` : `SELECT * FROM products WHERE id = ${id}`;

async function load(origin, id) {
  const r = await db.query(sqlFor(origin, id));
  return r.results[0].rows[0] ?? null;
}

function send(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

let writes = 0;
const server = createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url, 'http://x');
  const ms = () => (performance.now() - t0).toFixed(3);
  try {
    const m = url.pathname.match(/^\/item\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const backend = url.searchParams.get('backend') ?? 'none';
      const origin = url.searchParams.get('origin') === 'scan' ? 'scan' : 'index';
      if (!(backend in caches)) return send(res, 400, { error: 'BAD_BACKEND' });
      const cache = caches[backend];
      const key = `item:${origin}:${id}`;

      if (req.method === 'POST') {
        writes++;
        await db.query(`INSERT INTO products (name, price, category) VALUES ('write ${writes}', ${1000 + (writes % 300) * 1000}, '${CATS[id % 5]}')`);
        if (cache) await cache.del(key);
        return send(res, 200, { ok: true }, { 'X-Cache': 'WRITE', 'X-Server-Ms': ms() });
      }

      if (!cache) {
        const row = await load(origin, id);
        return send(res, row ? 200 : 404, row ?? { error: 'NOT_FOUND' }, { 'X-Cache': 'BYPASS', 'X-Server-Ms': ms() });
      }
      const ckey = url.searchParams.has('v') ? `${key}:${url.searchParams.get('v')}` : key;
      const cached = await cache.get(ckey);
      if (cached !== null) {
        const row = JSON.parse(cached);
        return send(res, row ? 200 : 404, row ?? { error: 'NOT_FOUND' }, { 'X-Cache': 'HIT', 'X-Server-Ms': ms() });
      }
      const row = await load(origin, id);
      await cache.set(ckey, JSON.stringify(row), { ttl: TTL });
      return send(res, row ? 200 : 404, row ?? { error: 'NOT_FOUND' }, { 'X-Cache': 'MISS', 'X-Server-Ms': ms() });
    }

    if (url.pathname === '/admin/reset' && req.method === 'POST') {
      await Promise.all([mini.command('FLUSHALL'), redis.flushall()]);
      const rows = await resetDb();
      writes = 0;
      return send(res, 200, { ok: true, rows });
    }
    // 미리 데우기: 키 1..n 을 캐시에 넣는다. 값(상품 한 행)은 origin 과 상관없이 같으므로
    // 무거운 전체 읽기 대신 B+ 트리 조회로 읽어서 origin 의 캐시 키에 넣는다 (준비 시간 단축)
    if (url.pathname === '/admin/warm' && req.method === 'POST') {
      const cache = caches[url.searchParams.get('backend')];
      const origin = url.searchParams.get('origin') === 'scan' ? 'scan' : 'index';
      const n = Math.min(100000, Number(url.searchParams.get('n')) || 1000);
      if (!cache) return send(res, 400, { error: 'BAD_BACKEND' });
      for (let s = 1; s <= n; s += 100) {
        const ids = Array.from({ length: Math.min(100, n - s + 1) }, (_, k) => s + k);
        const r = await db.query(ids.map((i) => `SELECT * FROM products WHERE id = ${i}`).join(';'));
        await Promise.all(r.results.map((x, k) => cache.set(`item:${origin}:${ids[k]}`, JSON.stringify(x.rows[0] ?? null), { ttl: TTL })));
      }
      return send(res, 200, { ok: true, warmed: n });
    }
    if (url.pathname === '/admin/info') {
      const tables = await db.tables();
      const redisVer = (await redis.command('INFO', 'server')).match(/redis_version:(\S+)/)?.[1];
      return send(res, 200, { node: process.version, rows: tables, dbWorkers: DB_WORKERS, ttl: TTL, redisVersion: redisVer });
    }
    if (url.pathname === '/admin/cpu') return send(res, 200, await cpuSnapshot());
    if (url.pathname === '/admin/rtt') {
      const cache = caches[url.searchParams.get('backend')];
      if (!cache) return send(res, 400, { error: 'BAD_BACKEND' });
      const n = Math.min(5000, Number(url.searchParams.get('n')) || 200);
      const ts = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); await cache.command('PING'); ts.push(performance.now() - t); }
      ts.sort((a, b) => a - b);
      return send(res, 200, { n, medianMs: ts[n >> 1], p95Ms: ts[Math.floor(n * 0.95)], meanMs: ts.reduce((a, b) => a + b, 0) / n });
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    send(res, 404, { error: 'NO_ROUTE' });
  } catch (e) {
    send(res, 500, { error: 'INTERNAL', message: e.message });
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => console.log(`experiment app → :${PORT} (rows=${ROWS}, dbWorkers=${DB_WORKERS})`));

const stop = async () => { await db.close(); redis.close(); miniResp?.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
