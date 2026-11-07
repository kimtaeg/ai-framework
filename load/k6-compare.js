// k6 비교 실험: 같은 부하를 "기술 있음(a)" 과 "없음(b)" 으로 한 번씩 보낸다. 테스트 실험실이 a, b 를 차례로 돌린다.
//   k6 run -e MODE=cache -e VARIANT=a load/k6-compare.js
//   MODE    cache  캐시 있음(a) vs 캐시 없이 매번 원본 조회 ?cache=0 (b)
//           index  id 로 찾기 = B+ 트리 인덱스 (a) vs email 로 찾기 = 전체 읽기 (b)
//           pool   같은 SQL 을 스레드 풀 워커 4개 (a) vs 1개 (b) 서버에 — 워커 수는 실험실이 대상 서버에 넣어 줌
//           aof    같은 쓰기를 AOF everysec(묶어서 1초마다) (a) vs always(쓸 때마다 디스크) (b) — 역시 대상 서버 설정
//           altcache  대안 비교: 미니 레디스 캐시 (a) vs API 서버 안 메모리 캐시 Map (b) vs 캐시 없음 (c)
//   VUS (기본 50), DURATION (기본 20s)
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { setup as seedUsers } from './k6-mixed.js';

const BASE = __ENV.BASE || 'http://localhost:5201';
const MODE = __ENV.MODE || 'cache';
const VARIANT = __ENV.VARIANT === 'b' ? 'b' : 'a';
const JSON_H = { headers: { 'Content-Type': 'application/json' } };
const cacheHit = new Rate('cache_hit');

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '20s' },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (MODE === 'index' || MODE === 'pool') return seedUsers();
  const r = http.get(`${BASE}/index.html`);
  if (r.status !== 200) throw new Error(`서버에 연결할 수 없습니다: ${BASE}`);
  return { users: 0 };
}

const rnd = (n) => 1 + Math.floor(Math.random() * n);

export default function (data) {
  let r;
  if (MODE === 'cache') {
    r = http.get(`${BASE}/api/demo/products/${rnd(5)}${VARIANT === 'b' ? '?cache=0' : ''}`);
    cacheHit.add(r.headers['X-Cache'] === 'HIT');
  } else if (MODE === 'altcache') {
    // 대안 비교: a = 미니 레디스 캐시, b = API 서버 안 메모리 캐시(Map), c = 캐시 없음
    r = http.get(`${BASE}/api/demo/products/${rnd(5)}${{ a: '', b: '?cache=local', c: '?cache=0' }[__ENV.VARIANT] ?? ''}`);
    cacheHit.add(r.headers['X-Cache'] === 'HIT');
  } else if (MODE === 'index') {
    const sql = VARIANT === 'a' ? `SELECT * FROM users WHERE id = ${rnd(data.users)}` : `SELECT * FROM users WHERE email = 'user${rnd(data.users) - 1}@load.test'`;
    r = http.post(`${BASE}/api/sql`, JSON.stringify({ sql }), JSON_H);
  } else if (MODE === 'pool') {
    r = http.post(`${BASE}/api/sql`, JSON.stringify({ sql: `SELECT * FROM users WHERE email = 'user${rnd(data.users) - 1}@load.test'` }), JSON_H);
  } else {
    r = http.put(`${BASE}/api/redis/keys/aof:${rnd(1000)}`, JSON.stringify({ value: `v${__ITER}` }), JSON_H);
  }
  // PUT 은 처음 만드는 키면 201 Created
  check(r, { 'status 200/201': (x) => x.status === 200 || x.status === 201 });
}
