// k6 부하 테스트: 정적 페이지 · 미니 레디스 · 캐시 API · 미니 DBMS 를 섞어서 담근다.
//   k6 run load/k6-mixed.js                       (기본: http://localhost:5201)
//   k6 run -e BASE=http://localhost:5200 load/k6-mixed.js
// /api/chat 은 넣지 않는다 (Gemini 키 한도만 날아간다).
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:5201';
const SEED = Number(__ENV.SEED || 10000);
const JSON_H = { headers: { 'Content-Type': 'application/json' } };

const t = {
  page: new Trend('t_page', true),
  redis: new Trend('t_redis', true),
  cache: new Trend('t_cache', true),
  sqlIndex: new Trend('t_sql_index', true),
  sqlScan: new Trend('t_sql_scan', true),
};
const cacheHit = new Rate('cache_hit');

export const options = {
  stages: [
    { duration: '20s', target: 50 },   // 서서히 50명까지
    { duration: '30s', target: 50 },   // 50명 유지
    { duration: '10s', target: 200 },  // 갑자기 200명 (스파이크)
    { duration: '20s', target: 200 },  // 200명 유지
    { duration: '10s', target: 0 },    // 정리
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],     // 에러 1% 미만
    t_page: ['p(95)<300'],
    t_redis: ['p(95)<300'],
    t_sql_index: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

// 시작 전에 users 테이블에 SEED 명 넣기 (1000명씩 INSERT 한 번)
export function setup() {
  const before = http.post(`${BASE}/api/sql`, JSON.stringify({ sql: 'SELECT id FROM users WHERE id = 1' }), JSON_H);
  if (before.status !== 200) throw new Error(`서버에 연결할 수 없습니다: ${BASE} (${before.status})`);
  if (__ENV.NO_SEED) return { users: SEED }; // 이미 넣어 둔 경우 (계단별로 여러 번 돌릴 때)
  for (let start = 0; start < SEED; start += 1000) {
    const rows = [];
    for (let i = start; i < Math.min(SEED, start + 1000); i++) rows.push(`('user${i}', ${20 + (i % 40)}, 'user${i}@load.test')`);
    const r = http.post(`${BASE}/api/sql`, JSON.stringify({ sql: `INSERT INTO users (name, age, email) VALUES ${rows.join(', ')}` }), JSON_H);
    check(r, { 'seed insert 200': (x) => x.status === 200 });
  }
  return { users: SEED };
}

const rnd = (n) => 1 + Math.floor(Math.random() * n);

export default function (data) {
  const p = Math.random();
  if (p < 0.3) {
    // 30% 정적 페이지
    const r = http.get(`${BASE}/theory/index.html`, { tags: { name: 'page' } });
    t.page.add(r.timings.duration);
    check(r, { 'page 200': (x) => x.status === 200 });
  } else if (p < 0.55) {
    // 25% 미니 레디스: 쓰기 · 읽기 · INCR
    const key = `load:${rnd(500)}`;
    const w = http.put(`${BASE}/api/redis/keys/${key}`, JSON.stringify({ value: `v${__ITER}`, ttl: 60 }), { ...JSON_H, tags: { name: 'redis' } });
    const g = http.get(`${BASE}/api/redis/keys/${key}`, { tags: { name: 'redis' } });
    const c = http.post(`${BASE}/api/redis/keys/likes:video1/incr`, '{}', { ...JSON_H, tags: { name: 'redis' } });
    [w, g, c].forEach((r) => t.redis.add(r.timings.duration));
    check(g, { 'redis get 200': (x) => x.status === 200 });
    check(c, { 'redis incr 200': (x) => x.status === 200 });
  } else if (p < 0.75) {
    // 20% 캐시 API (원본 "DB" 는 120ms 걸림)
    const r = http.get(`${BASE}/api/demo/products/${rnd(5)}`, { tags: { name: 'cache' } });
    t.cache.add(r.timings.duration);
    check(r, { 'cache 200': (x) => x.status === 200 });
    cacheHit.add(/hit/i.test(r.headers['X-Cache'] || '') || (r.body || '').includes('"cache":"HIT"'));
  } else if (p < 0.95) {
    // 20% SQL: id 로 찾기 (B+ 트리 인덱스)
    const r = http.post(`${BASE}/api/sql`, JSON.stringify({ sql: `SELECT * FROM users WHERE id = ${rnd(data.users)}` }), { ...JSON_H, tags: { name: 'sql_index' } });
    t.sqlIndex.add(r.timings.duration);
    check(r, { 'sql index 200': (x) => x.status === 200 });
  } else {
    // 5% SQL: email 로 찾기 (인덱스 없음 → 전체 읽기)
    const r = http.post(`${BASE}/api/sql`, JSON.stringify({ sql: `SELECT * FROM users WHERE email = 'user${rnd(data.users) - 1}@load.test'` }), { ...JSON_H, tags: { name: 'sql_scan' } });
    t.sqlScan.add(r.timings.duration);
    check(r, { 'sql scan 200': (x) => x.status === 200 });
  }
}
