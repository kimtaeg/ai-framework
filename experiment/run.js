/**
 * 캐시 실험 실행기 — 조건마다 REPS 번, 매 반복마다 조건 순서를 섞어서(시간에 따른 편향 제거) k6 를 돌린다.
 *
 *   docker compose -f experiment/docker-compose.yml up -d --build --wait
 *   node experiment/run.js [--reps 6] [--only E1,E2] [--duration 10] [--delay 1ms] [--jitter 0.2ms] [--resume]
 *   node experiment/analyze.js
 *
 *  E1  지연시간 모델   VUS=1 (대기열 없음), 무거운 쿼리(scan), 히트율 0 ~ 100%
 *  E2  처리량 모델     VUS=50 (DB 가 병목), 무거운 쿼리(scan), 히트율 0 ~ 100%
 *  E3  가벼운 쿼리     VUS=50, B+ 트리 조회(index) — 캐시가 오히려 손해일 수 있는지 · 통신 방식 3자 비교
 *  E4  YCSB A/B/C      VUS=50, Zipf(θ=0.99) 키, 가벼운 쿼리, 워밍업 10초
 *  E5  네트워크 지연   E3 와 같은 조건 + 앱 → 캐시 왕복 지연(--delay, 기본 1ms ± 0.2ms) — 처리량 손익분기가 얼마나 움직이나
 *  E6  지연 · VU 1     VUS=1, B+ 트리 조회, 지연 없음 / 있음 — 대기열 없는 응답시간 손익분기 (지연이 그대로 보이는 경우)
 *
 *  캐시: none(없음) · mini(미니 레디스 HTTP+JSON) · miniresp(같은 미니 레디스를 RESP/TCP 로) · redis(실제 Redis 7)
 *  지연이 있는 조건은 tc netem 을 켠 채로, 나머지는 끈 채로 잰다 (같은 반복 안에서 섞인 순서대로 켜고 끈다)
 */
import { spawnSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, totalmem, release, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMs, setDelay, measureRtt } from './netem.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, 'docker-compose.yml');
const RAW = join(HERE, 'results', 'raw');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg('reps', 6));
const DURATION = Number(arg('duration', 10));
const ONLY = arg('only', 'E1,E2,E3,E4,E5,E6').split(',');
const DELAY = parseMs(arg('delay', '1ms'));
const JITTER = arg('jitter') == null ? DELAY * 0.2 : parseMs(arg('jitter'));
const resume = process.argv.includes('--resume');

const HITS_E1 = [0, 0.5, 0.9, 0.99, 1];
const HITS_E2 = [0, 0.5, 0.8, 0.9, 0.95, 0.99, 1];
const HITS_E3 = [0, 0.5, 0.7, 0.9, 1];  // 손익분기가 있을 구간(50~90%)을 촘촘히
const HITS_E6 = [0, 0.5, 0.9, 1];
const LIGHT = ['mini', 'miniresp', 'redis']; // 가벼운 쿼리 실험의 캐시 3종 (통신 방식 비교)

function grid(delay = 1) {
  const c = [];
  const sweep = (exp, origin, vus, hits, backends, extra = {}) => {
    c.push({ exp, BACKEND: 'none', ORIGIN: origin, MODE: 'hit', HIT: 0, VUS: vus, ...extra });
    for (const b of backends) for (const h of hits) c.push({ exp, BACKEND: b, ORIGIN: origin, MODE: 'hit', HIT: h, VUS: vus, ...extra });
  };
  if (ONLY.includes('E1')) sweep('E1', 'scan', 1, HITS_E1, ['mini', 'redis']);
  if (ONLY.includes('E2')) sweep('E2', 'scan', 50, HITS_E2, ['mini', 'redis']);
  if (ONLY.includes('E3')) sweep('E3', 'index', 50, HITS_E3, LIGHT);
  if (ONLY.includes('E4')) for (const b of ['none', ...LIGHT]) for (const w of ['A', 'B', 'C']) c.push({ exp: 'E4', BACKEND: b, ORIGIN: 'index', MODE: 'ycsb', WORKLOAD: w, VUS: 50, WARMUP: 10 });
  if (delay > 0 && ONLY.includes('E5')) sweep('E5', 'index', 50, HITS_E3, LIGHT, { DELAY_MS: delay });
  if (ONLY.includes('E6')) {
    sweep('E6', 'index', 1, HITS_E6, LIGHT);
    if (delay > 0) sweep('E6', 'index', 1, HITS_E6, LIGHT, { DELAY_MS: delay });
  }
  return c;
}

const id = (c) => [c.exp, c.BACKEND, c.ORIGIN, c.MODE === 'hit' ? `h${c.HIT}` : `ycsb${c.WORKLOAD}`, `vu${c.VUS}`, ...(c.DELAY_MS ? [`d${c.DELAY_MS}ms`] : [])].join('_');

function shuffle(a, seed) {
  // 재현 가능한 섞기 (반복 번호가 씨앗)
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }

async function environment() {
  const info = JSON.parse(sh('docker info --format "{{json .}}"') ?? '{}');
  let appInfo = {};
  try { appInfo = JSON.parse(sh('curl -s http://localhost:8080/admin/info') ?? '{}'); } catch { /* 응답이 JSON 이 아님 */ }
  if (!appInfo.rows) {
    console.error('실험 서버(localhost:8080)에 연결할 수 없습니다. 먼저 컨테이너를 띄우세요:');
    console.error('  docker compose -f experiment/docker-compose.yml up -d --build --wait');
    process.exit(1);
  }
  // 지연을 넣었을 때와 뺐을 때 캐시까지 PING 왕복 시간을 직접 재서 기록한다 (지연이 실제로 걸렸는지 증거)
  // 하나씩 차례로 잰다 (동시에 재면 앱 서버 이벤트 루프를 나눠 써서 서로의 왕복 시간을 늘린다)
  const rtt = async () => { const o = {}; for (const b of ['mini', 'miniresp', 'redis']) o[b] = await measureRtt(b, 500); return o; };
  setDelay(0);
  const network = { delayMs: DELAY, jitterMs: JITTER, method: 'tc netem (앱 컨테이너 eth0 → 캐시 컨테이너 IP 만, 안쪽 큐 pfifo)', rttLocal: await rtt() };
  if (DELAY > 0) { setDelay(DELAY, JITTER); network.rttDelayed = await rtt(); setDelay(0); }
  return {
    measuredAt: new Date().toISOString(),
    host: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memGB: +(totalmem() / 2 ** 30).toFixed(1), os: `${platform()} ${release()}` },
    docker: { version: info.ServerVersion, vmCpus: info.NCPU, vmMemGB: +((info.MemTotal ?? 0) / 2 ** 30).toFixed(1), kernel: info.KernelVersion },
    limits: { app: 'cpuset 2-4 (3 CPU), 1GB, DB 워커 2', miniredis: 'cpuset 5 (1 CPU), 512MB, HTTP :6380 + RESP :6381 (저장소 하나)', redis: 'cpuset 6 (1 CPU), 512MB, 영속성 끔, io-threads 1', k6: 'cpuset 8-11 (4 CPU), 1GB' },
    versions: { node: appInfo.node, redis: appInfo.redisVersion, k6: 'grafana/k6:1.0.0' },
    data: appInfo.rows,
    network,
    method: { reps: REPS, durationSec: DURATION, warmupSec: '3 (E4: 10)', order: '반복마다 조건 순서를 섞음', conditions: grid(DELAY).length, runs: grid(DELAY).length * REPS },
  };
}

mkdirSync(RAW, { recursive: true });
// 서버가 꺼져 있으면 여기서 멈춘다. --resume 이고 이미 env.json 이 있으면 앞선 측정의 환경 정보를 지키기 위해 덮어쓰지 않는다
const ENV_FILE = join(HERE, 'results', 'env.json');
if (!(resume && existsSync(ENV_FILE))) writeFileSync(ENV_FILE, JSON.stringify(await environment(), null, 2));

// 지연 상태: 바뀔 때만 tc 를 부른다. 어떤 식으로 끝나든(완료 · Ctrl+C · 오류) 지연을 꺼 둔다
let current = null;
const applyDelay = (ms) => { if (current !== ms) { setDelay(ms, JITTER); current = ms; } };
const cleanup = () => { try { setDelay(0); } catch { /* 컨테이너가 이미 꺼짐 */ } };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('exit', () => { if (current) cleanup(); });
applyDelay(0);

const conds = grid(DELAY);
const total = conds.length * REPS;
let n = 0, done = 0;
const t0 = Date.now();
for (let rep = 1; rep <= REPS; rep++) {
  for (const c of shuffle([...conds], rep)) {
    n++;
    const name = `${id(c)}_r${rep}.json`;
    if (resume && existsSync(join(RAW, name))) continue;
    applyDelay(c.DELAY_MS ?? 0);
    const env = { ...c, DELAY_MS: c.DELAY_MS ?? 0, WARMUP: c.WARMUP ?? 3, DURATION, OUT: `/out/${name}` };
    delete env.exp;
    const args = ['compose', '-f', COMPOSE, 'run', '--rm', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'k6', 'run', '-q', '/scripts/cache.js'];
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    done++;
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('rps=')).pop() ?? `실패: ${(r.stderr || '').trim().split('\n').pop()}`;
    const eta = Math.round(((Date.now() - t0) / done) * (total - n) / 60000);
    console.log(`[${n}/${total}] r${rep} ${id(c)} → ${line}  (남은 시간 약 ${eta}분)`);
  }
}
applyDelay(0);
console.log('끝. node experiment/analyze.js 로 정리하세요.');
