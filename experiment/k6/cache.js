// 캐시 실험 k6 시나리오 (experiment/run.js 가 조건을 바꿔 가며 반복 실행한다)
//
//  공통   BASE, BACKEND=none|mini|miniresp|redis, ORIGIN=index|scan, VUS, WARMUP(초), DURATION(초), OUT(결과 JSON 경로)
//         DELAY_MS  run.js 가 넣은 앱 → 캐시 네트워크 지연 (기록용 · 지연 자체는 tc netem 이 건다)
//  CPU    측정 시작 · 끝에 /admin/cpu 를 한 번씩 불러 그 사이 앱 서버 · 미니 레디스 · Redis 가 쓴 CPU 시간을 기록한다
//  MODE=hit    히트율을 정확히 조절: 확률 HIT 로 미리 데워 둔 키(HOT 개), 나머지는 매번 새 캐시 키(v=유일값) → 반드시 MISS
//  MODE=ycsb   YCSB 표준 워크로드: Zipf 분포(θ=0.99) 키 선택, WORKLOAD=A(읽기50:쓰기50) | B(95:5) | C(100:0)
//
//  워밍업 구간은 측정에서 뺀다 (lat · hit · reqs 는 measure 시나리오에서만 기록)
import http from 'k6/http';
import exec from 'k6/execution';
import { Trend, Rate, Counter, Gauge } from 'k6/metrics';

const E = __ENV;
const BASE = E.BASE || 'http://app:8080';
const BACKEND = E.BACKEND || 'none';
const ORIGIN = E.ORIGIN || 'scan';
const MODE = E.MODE || 'hit';
const HIT = Number(E.HIT ?? 0.9);
const HOT = Number(E.HOT || 1000);
const ROWS = Number(E.ROWS || 100000);
const VUS = Number(E.VUS || 20);
const WARMUP = Number(E.WARMUP || 3);
const DURATION = Number(E.DURATION || 10);
const WRITE_RATIO = { A: 0.5, B: 0.05, C: 0 }[E.WORKLOAD || 'C'];

const lat = new Trend('lat', true);
const latRead = new Trend('lat_read', true);
const latHit = new Trend('lat_hit', true);
const latMiss = new Trend('lat_miss', true);
const hit = new Rate('hit');
const reqs = new Counter('reqs');
const errors = new Rate('errors');
const DELAY_MS = Number(E.DELAY_MS || 0);
// CPU 누적값(µs)을 측정 시작(cpu0) · 끝(cpu1)에 한 번씩 적어 둔다
const CPU_KEYS = ['appUs', 'miniUs', 'redisUs', 'at'];
const cpuG = Object.fromEntries(['cpu0', 'cpu1'].map((s) => [s, Object.fromEntries(CPU_KEYS.map((k) => [k, new Gauge(`${s}_${k}`)]))]));

export const options = {
  scenarios: {
    warmup: { executor: 'constant-vus', vus: VUS, duration: `${WARMUP}s`, gracefulStop: '0s' },
    measure: { executor: 'constant-vus', vus: VUS, duration: `${DURATION}s`, startTime: `${WARMUP}s`, gracefulStop: '5s' },
    cpu0: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: `${WARMUP}s`, exec: 'cpuMark', maxDuration: '5s' },
    cpu1: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: `${WARMUP + DURATION}s`, exec: 'cpuMark', maxDuration: '5s' },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'min', 'max', 'count'],
  discardResponseBodies: true,
};

// ---- YCSB Zipfian 생성기 (Gray et al. — YCSB ZipfianGenerator 와 같은 식) ----
const THETA = 0.99;
let zetan = 0;
if (MODE === 'ycsb') for (let i = 1; i <= ROWS; i++) zetan += 1 / Math.pow(i, THETA);
const zeta2 = 1 + 1 / Math.pow(2, THETA);
const alpha = 1 / (1 - THETA);
const eta = (1 - Math.pow(2 / ROWS, 1 - THETA)) / (1 - zeta2 / zetan);
function zipfRank() {
  const u = Math.random();
  const uz = u * zetan;
  if (uz < 1) return 0;
  if (uz < zeta2) return 1;
  return Math.floor(ROWS * Math.pow(eta * u - eta + 1, alpha));
}
// YCSB 처럼 순위를 해시로 섞어서, 인기 키가 id 1,2,3… 에 몰리지 않게 한다 (FNV-1a)
function scramble(rank) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 4; i++) { h ^= (rank >>> (i * 8)) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return 1 + (h % ROWS);
}

const rnd = (n) => 1 + Math.floor(Math.random() * n);
const url = (id, extra = '') => `${BASE}/item/${id}?backend=${BACKEND}&origin=${ORIGIN}${extra}`;

export function setup() {
  const r = http.post(`${BASE}/admin/reset`, null, { timeout: '60s' }); // 캐시 비우기 + DB 를 정확히 ROWS 건으로
  if (r.status !== 200) throw new Error(`reset 실패: ${r.status}`);
  // MODE=hit: 뜨거운 키 HOT 개를 미리 캐시에 넣는다
  if (MODE === 'hit' && BACKEND !== 'none') {
    const w = http.post(`${BASE}/admin/warm?backend=${BACKEND}&origin=${ORIGIN}&n=${HOT}`, null, { timeout: '60s' });
    if (w.status !== 200) throw new Error(`warm 실패: ${w.status}`);
  }
  return {};
}

export default function () {
  const measuring = exec.scenario.name === 'measure';
  let r, write = false;
  if (MODE === 'hit') {
    r = Math.random() < HIT ? http.get(url(rnd(HOT))) : http.get(url(rnd(ROWS), `&v=${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${exec.scenario.name}`));
  } else {
    const id = scramble(zipfRank());
    write = Math.random() < WRITE_RATIO;
    r = write ? http.post(url(id)) : http.get(url(id));
  }
  if (!measuring) return;
  const ok = r.status === 200 || r.status === 404;
  errors.add(!ok);
  reqs.add(1);
  lat.add(r.timings.duration);
  if (!write) {
    latRead.add(r.timings.duration);
    const state = r.headers['X-Cache'];
    if (BACKEND !== 'none') {
      hit.add(state === 'HIT');
      (state === 'HIT' ? latHit : latMiss).add(r.timings.duration);
    } else latMiss.add(r.timings.duration);
  }
}

// 측정 시작 · 끝 표시: 그 순간까지의 CPU 누적값을 기록 (본문을 읽어야 하므로 이 요청만 응답 본문을 받는다)
export function cpuMark() {
  const r = http.get(`${BASE}/admin/cpu`, { responseType: 'text', timeout: '5s' });
  if (r.status !== 200) return;
  const v = JSON.parse(r.body);
  for (const k of CPU_KEYS) if (typeof v[k] === 'number') cpuG[exec.scenario.name][k].add(v[k]);
}

export function handleSummary(data) {
  const m = (name) => data.metrics[name]?.values ?? null;
  const g = (name) => m(name)?.value ?? null;
  const d = (k) => (g(`cpu0_${k}`) != null && g(`cpu1_${k}`) != null ? g(`cpu1_${k}`) - g(`cpu0_${k}`) : null);
  const n = m('reqs')?.count ?? 0;
  const perReq = (us) => (us != null && n ? us / 1000 / n : null);
  // cpu: 측정 구간 동안 쓴 CPU 시간 (µs) · 요청 하나당 CPU (ms) · 구간 길이 (ms)
  const cpu = { windowMs: d('at'), appUs: d('appUs'), miniUs: d('miniUs'), redisUs: d('redisUs') };
  Object.assign(cpu, { appMsPerReq: perReq(cpu.appUs), miniMsPerReq: perReq(cpu.miniUs), redisMsPerReq: perReq(cpu.redisUs) });
  const out = {
    params: { BACKEND, ORIGIN, MODE, HIT: MODE === 'hit' ? HIT : null, WORKLOAD: MODE === 'ycsb' ? (E.WORKLOAD || 'C') : null, VUS, WARMUP, DURATION, ROWS, HOT, DELAY_MS },
    cpu,
    rps: n / DURATION,
    lat: m('lat'), latRead: m('lat_read'), latHit: m('lat_hit'), latMiss: m('lat_miss'),
    hitRate: m('hit')?.rate ?? null,
    errorRate: m('errors')?.rate ?? null,
  };
  return { [E.OUT || '/out/last.json']: JSON.stringify(out, null, 2), stdout: `rps=${out.rps.toFixed(1)} avg=${out.lat?.avg?.toFixed(2)}ms p95=${out.lat?.['p(95)']?.toFixed(2)}ms hit=${out.hitRate}\n` };
}
