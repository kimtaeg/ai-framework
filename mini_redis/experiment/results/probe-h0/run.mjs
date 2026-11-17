// 사용: node run.mjs <프로젝트 루트> <태그> [반복 수]
//   히트율 0% · VU 50 · B+ 트리 조회만: 캐시 없음 / Redis / 미니 RESP × 지연 없음 / +1ms 를 반복마다 순서를 바꿔 잰다
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [root, tag, repsArg] = process.argv.slice(2);
const REPS = Number(repsArg ?? 4);
const { setDelay } = await import(pathToFileURL(join(root, 'experiment', 'netem.js')).href);
const COMPOSE = ['compose', '-f', join(root, 'experiment', 'docker-compose.yml'), '-f', join(HERE, 'override.yml')];
mkdirSync(join(HERE, 'out', tag), { recursive: true });

const ALL = [['none', 0], ['redis', 1], ['none', 1], ['miniresp', 1], ['redis', 0]];
const CONDS = process.argv[5] === 'short' ? ALL.filter(([b, d]) => !(b === 'none' && d) && b !== 'miniresp') : ALL;
const rows = [];
try {
  for (let rep = 1; rep <= REPS; rep++) {
    const order = rep % 2 ? CONDS : [...CONDS].reverse(); // 시간에 따른 편향을 줄이려고 번갈아 뒤집는다
    for (const [backend, delay] of order) {
      setDelay(delay, delay * 0.2);
      const name = `${tag}/${backend}_d${delay}_r${rep}.json`;
      const env = { BACKEND: backend, ORIGIN: 'index', MODE: 'hit', HIT: 0, VUS: 50, DELAY_MS: delay, WARMUP: 3, DURATION: 10, OUT: `/out/${name}` };
      const r = spawnSync('docker', [...COMPOSE, 'run', '--rm', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'k6', 'run', '-q', '/scripts/cache.js'], { encoding: 'utf8' });
      const rps = Number((r.stdout || '').match(/rps=([\d.]+)/)?.[1] ?? NaN);
      const probe = await (await fetch('http://localhost:8080/admin/probe')).json();
      rows.push({ backend, delay, rep, rps, probe });
      console.log(`r${rep} ${backend} d${delay} rps=${rps}`, Number.isNaN(rps) ? (r.stderr || '').trim().split('\n').pop() : '');
    }
  }
} finally {
  setDelay(0);
  writeFileSync(join(HERE, 'out', `${tag}.json`), JSON.stringify(rows, null, 2));
}
