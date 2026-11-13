/**
 * 구간별 지연 측정 — miniDBMS · miniRedis 의 요청 하나가 어디서 시간을 쓰는지 본다
 *   node load/latency.js [--rows 200000] [--out 결과.json] [--lock-reads] [--no-auto-index]
 *
 *  DBMS  : 서비스(svc.query)를 직접 불러 총 지연과 그 안의 락 대기(lockMs) · 워커 대기(waitedMs) · 실행(execMs)을 나눠 본다.
 *          남는 시간(= 총 - 세 구간)은 파싱 · 스레드 사이 메시지 복사 비용이다.
 *  Redis : 저장소를 직접 부를 때(명령 자체)와 HTTP 를 거칠 때를 따로 잰다.
 *  측정마다 워밍업을 먼저 돌리고, 중앙값(p50)과 느린 쪽(p99)을 함께 낸다.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { seedRows } from '../week2/dbms/seed.js';
import { startDbServer } from '../week2/dbms/server.js';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { startRedisServer } from '../week2/redis/server.js';
import { MiniRedisClient } from '../week2/redis/client.js';
import { nodeFetch } from '../week2/redis/node-fetch.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const ROWS = Number(arg('rows', 200000));
const OUT = arg('out', null);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const r3 = (x) => Math.round(x * 1000) / 1000;

function summarize(times, parts = null) {
  const s = [...times].sort((a, b) => a - b);
  const out = { n: s.length, p50: r3(pct(s, 0.5)), p99: r3(pct(s, 0.99)), avg: r3(avg(s)) };
  if (parts) for (const [k, v] of Object.entries(parts)) out[k] = r3(avg(v));
  return out;
}

/** fn 을 warm 번 버리고 n 번 재서 요약 */
async function measure(n, warm, fn) {
  for (let i = 0; i < warm; i++) await fn(i);
  const times = [];
  const parts = { lockMs: [], waitedMs: [], execMs: [] };
  let hasParts = false;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fn(i);
    times.push(performance.now() - t0);
    if (r && typeof r.execMs === 'number') {
      hasParts = true;
      parts.lockMs.push(r.lockMs);
      parts.waitedMs.push(r.waitedMs);
      parts.execMs.push(r.execMs);
    }
  }
  return summarize(times, hasParts ? parts : null);
}

const agent = new http.Agent({ keepAlive: true });
function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const results = { rows: ROWS, dbms: {}, redis: {} };

// ================================================================ DBMS
{
  const dir = mkdtempSync(join(tmpdir(), 'latency-db-'));
  const storage = new FileStorage(dir);
  seedRows(new Database(storage), 'users', ROWS);
  storage.close();
  const s = await startDbServer({ port: 0, dir, workers: 4, snapshotReads: !process.argv.includes('--lock-reads'), autoIndex: !process.argv.includes('--no-auto-index') });
  const q = (sql) => s.svc.query(sql);
  const rid = (i) => 1 + ((i * 7919) % ROWS);
  try {
    const d = results.dbms;
    d['점 조회 (id = ?)'] = await measure(3000, 500, (i) => q(`SELECT * FROM users WHERE id = ${rid(i)}`));
    d['범위 100행'] = await measure(500, 50, (i) => q(`SELECT * FROM users WHERE id BETWEEN ${rid(i)} AND ${rid(i) + 99}`));
    d['범위 5000행'] = await measure(60, 5, (i) => q(`SELECT * FROM users WHERE id BETWEEN ${rid(i)} AND ${rid(i) + 4999}`));
    d['전체 읽기 (email = ?)'] = await measure(15, 2, (i) => q(`SELECT * FROM users WHERE email = 'user${rid(i)}@jungle.test'`));
    d['같은 email 반복 조회'] = await measure(15, 2, () => q(`SELECT * FROM users WHERE email = 'user777@jungle.test'`));
    d['INSERT 1행'] = await measure(500, 50, (i) => q(`INSERT INTO users (name, age, email) VALUES ('n${i}', 30, 'n${i}@x')`));
    d['HTTP 점 조회'] = await measure(2000, 300, (i) => post(s.port, '/sql', { sql: `SELECT * FROM users WHERE id = ${rid(i)}` }));

    // 읽기 90% + 쓰기 10% 를 32개가 동시에: 락 대기가 얼마나 끼는지
    // 읽기와 쓰기를 따로 요약한다 (쓰기는 한 번에 하나라서 줄을 서고, 읽기가 그 줄에 같이 서는지가 관건)
    const mk = () => ({ times: [], lockMs: [], waitedMs: [], execMs: [] });
    const reads = mk(), writes = mk();
    let k = 0;
    const client = async () => {
      for (let j = 0; j < 150; j++) {
        const i = k++;
        const isWrite = i % 10 === 0;
        const sql = isWrite ? `INSERT INTO users (name, age, email) VALUES ('m${i}', 20, 'm${i}@x')` : `SELECT * FROM users WHERE id = ${rid(i)}`;
        const t0 = performance.now();
        const r = await q(sql);
        const b = isWrite ? writes : reads;
        b.times.push(performance.now() - t0);
        b.lockMs.push(r.lockMs); b.waitedMs.push(r.waitedMs); b.execMs.push(r.execMs);
      }
    };
    await Promise.all(Array.from({ length: 32 }, client));
    const sum = ({ times, ...parts }) => summarize(times, parts);
    d['동시 32 중 읽기 (90%)'] = sum(reads);
    d['동시 32 중 쓰기 (10%)'] = sum(writes);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ Redis
{
  const d = results.redis;
  const N = 200000;
  const perOp = (label, fn) => {
    fn(20000); // 워밍업
    const t0 = performance.now();
    fn(N);
    d[label] = { n: N, usPerOp: r3(((performance.now() - t0) * 1000) / N) };
  };
  let r = new MiniRedis();
  perOp('명령: SET 새 키', (n) => { for (let i = 0; i < n; i++) r.command(['SET', `key:${i}`, 'value']); });
  perOp('명령: SET 덮어쓰기', (n) => { for (let i = 0; i < n; i++) r.command(['SET', `key:${i % 1000}`, 'value2']); });
  perOp('명령: GET', (n) => { for (let i = 0; i < n; i++) r.command(['GET', `key:${i}`]); });
  perOp('명령: SET + TTL 덮어쓰기', (n) => { for (let i = 0; i < n; i++) r.command(['SET', `key:${i % 1000}`, 'v', 'EX', '60']); });
  perOp('명령: INCR', (n) => { for (let i = 0; i < n; i++) r.command(['INCR', `cnt:${i % 100}`]); });
  r = null;

  const s = await startRedisServer({ port: 0, aofPath: null });
  const c = new MiniRedisClient(`http://127.0.0.1:${s.port}`, { fetch: nodeFetch });
  try {
    for (let i = 0; i < 2000; i++) await c.set(`k${i}`, `v${i}`);
    d['HTTP: GET'] = await measure(3000, 500, (i) => c.get(`k${i % 2000}`));
    d['HTTP: PUT'] = await measure(3000, 500, (i) => c.set(`k${i % 2000}`, 'x'));
    d['HTTP: PUT + ttl + tags'] = await measure(3000, 500, (i) => c.set(`k${i % 2000}`, 'x', { ttl: 60, tags: ['a', 'b'] }));
    const batch = Array.from({ length: 100 }, (_, i) => ['GET', `k${i}`]);
    d['HTTP: pipeline GET 100개'] = await measure(500, 50, () => c.pipeline(batch));
  } finally {
    await s.close();
  }
}

const show = (title, obj) => {
  console.log(`\n== ${title}`);
  console.table(obj);
};
show(`miniDBMS (users ${ROWS}행, ms)`, results.dbms);
show('miniRedis (명령 = 마이크로초/개, HTTP = ms)', results.redis);
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
agent.destroy();
process.exit(0);
