/**
 * 캐시 실험 실행기 — 조건마다 REPS 번, 매 반복마다 조건 순서를 섞어서(시간에 따른 편향 제거) k6 를 돌린다.
 *
 *   docker compose -f experiment/docker-compose.yml up -d --build --wait
 *   node experiment/run.js [--reps 5] [--only E1,E2] [--duration 10]
 *   node experiment/analyze.js
 *
 *  E1  지연시간 모델   VUS=1 (대기열 없음), 무거운 쿼리(scan), 히트율 0 ~ 100%
 *  E2  처리량 모델     VUS=50 (DB 가 병목), 무거운 쿼리(scan), 히트율 0 ~ 100%
 *  E3  가벼운 쿼리     VUS=50, B+ 트리 조회(index) — 캐시가 오히려 손해일 수 있는지
 *  E4  YCSB A/B/C      VUS=50, Zipf(θ=0.99) 키, 가벼운 쿼리, 워밍업 10초
 */
import { spawnSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, totalmem, release, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, 'docker-compose.yml');
const RAW = join(HERE, 'results', 'raw');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg('reps', 5));
const DURATION = Number(arg('duration', 10));
const ONLY = arg('only', 'E1,E2,E3,E4').split(',');
const resume = process.argv.includes('--resume');

const HITS_E1 = [0, 0.5, 0.9, 0.99, 1];
const HITS_E2 = [0, 0.5, 0.8, 0.9, 0.95, 0.99, 1];
const HITS_E3 = [0, 0.9, 1];

function grid() {
  const c = [];
  const sweep = (exp, origin, vus, hits) => {
    c.push({ exp, BACKEND: 'none', ORIGIN: origin, MODE: 'hit', HIT: 0, VUS: vus });
    for (const b of ['mini', 'redis']) for (const h of hits) c.push({ exp, BACKEND: b, ORIGIN: origin, MODE: 'hit', HIT: h, VUS: vus });
  };
  if (ONLY.includes('E1')) sweep('E1', 'scan', 1, HITS_E1);
  if (ONLY.includes('E2')) sweep('E2', 'scan', 50, HITS_E2);
  if (ONLY.includes('E3')) sweep('E3', 'index', 50, HITS_E3);
  if (ONLY.includes('E4')) for (const b of ['none', 'mini', 'redis']) for (const w of ['A', 'B', 'C']) c.push({ exp: 'E4', BACKEND: b, ORIGIN: 'index', MODE: 'ycsb', WORKLOAD: w, VUS: 50, WARMUP: 10 });
  return c;
}

const id = (c) => [c.exp, c.BACKEND, c.ORIGIN, c.MODE === 'hit' ? `h${c.HIT}` : `ycsb${c.WORKLOAD}`, `vu${c.VUS}`].join('_');

function shuffle(a, seed) {
  // 재현 가능한 섞기 (반복 번호가 씨앗)
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }

function environment() {
  const info = JSON.parse(sh('docker info --format "{{json .}}"') ?? '{}');
  const appInfo = JSON.parse(sh('curl -s http://localhost:8080/admin/info') ?? '{}');
  return {
    measuredAt: new Date().toISOString(),
    host: { cpu: cpus()[0]?.model, logicalCores: cpus().length, memGB: +(totalmem() / 2 ** 30).toFixed(1), os: `${platform()} ${release()}` },
    docker: { version: info.ServerVersion, vmCpus: info.NCPU, vmMemGB: +((info.MemTotal ?? 0) / 2 ** 30).toFixed(1), kernel: info.KernelVersion },
    limits: { app: 'cpuset 2-4 (3 CPU), 1GB, DB 워커 2', miniredis: 'cpuset 5 (1 CPU), 512MB', redis: 'cpuset 6 (1 CPU), 512MB, 영속성 끔, io-threads 1', k6: 'cpuset 8-11 (4 CPU), 1GB' },
    versions: { node: appInfo.node, redis: appInfo.redisVersion, k6: 'grafana/k6:1.0.0' },
    data: appInfo.rows,
    method: { reps: REPS, durationSec: DURATION, warmupSec: '3 (E4: 10)', order: '반복마다 조건 순서를 섞음' },
  };
}

mkdirSync(RAW, { recursive: true });
writeFileSync(join(HERE, 'results', 'env.json'), JSON.stringify(environment(), null, 2));

const conds = grid();
const total = conds.length * REPS;
let n = 0;
const t0 = Date.now();
for (let rep = 1; rep <= REPS; rep++) {
  for (const c of shuffle([...conds], rep)) {
    n++;
    const name = `${id(c)}_r${rep}.json`;
    if (resume && existsSync(join(RAW, name))) continue;
    const env = { ...c, WARMUP: c.WARMUP ?? 3, DURATION, OUT: `/out/${name}` };
    delete env.exp;
    const args = ['compose', '-f', COMPOSE, 'run', '--rm', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'k6', 'run', '-q', '/scripts/cache.js'];
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('rps=')).pop() ?? `실패: ${(r.stderr || '').trim().split('\n').pop()}`;
    const eta = Math.round(((Date.now() - t0) / n) * (total - n) / 60000);
    console.log(`[${n}/${total}] r${rep} ${id(c)} → ${line}  (남은 시간 약 ${eta}분)`);
  }
}
console.log('끝. node experiment/analyze.js 로 정리하세요.');
