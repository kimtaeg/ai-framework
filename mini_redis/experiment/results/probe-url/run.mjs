// 사용: node run.mjs <프로젝트 루트> <태그> <반복 수> <조건 묶음: base | curve>
//   같은 요청을 보내되 k6 가 URL 을 유일한 이름으로 셀 때(원래)와 이름 하나로 묶을 때(NAMED)를 번갈아 잰다
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [root, tag, reps, set] = process.argv.slice(2);
const COMPOSE = ['compose', '-f', join(root, 'experiment', 'docker-compose.yml'), '-f', join(HERE, 'override.yml')];
const c = (BACKEND, HIT, NAMED, VUS = 50) => ({ BACKEND, HIT, NAMED, VUS });
const SETS = {
  // VU 1 (응답시간): 캐시 없음과 히트율 0% Redis 를 원래대로 / 이름 묶기
  vu1: [c('none', 0, 0, 1), c('none', 0, 1, 1), c('redis', 0, 0, 1), c('redis', 0, 1, 1), c('redis', 1, 1, 1)],
  // 기준선: 캐시 없음 · 히트율 0% 를 원래대로 / 이름 묶기 / (참고) 유일 꼬리표 없는 URL
  base: [c('none', 0, 0), c('none', 0, 1), c('none', 1, 0), c('redis', 0, 0), c('redis', 0, 1)],
  // 발표 표(E3)의 칸들을 이름 묶기로 다시
  curve: [c('none', 0, 1), ...['mini', 'miniresp', 'redis'].flatMap((b) => [0, 0.5, 0.7, 0.9, 1].map((h) => c(b, h, 1))), c('none', 0, 0), c('redis', 1, 0), c('miniresp', 1, 0), c('mini', 1, 0)],
};
const rows = [];
try {
  for (let rep = 1; rep <= Number(reps); rep++) {
    const order = rep % 2 ? SETS[set] : [...SETS[set]].reverse();
    for (const { BACKEND, HIT, NAMED, VUS } of order) {
      const env = { BACKEND, ORIGIN: 'index', MODE: 'hit', HIT, VUS, DELAY_MS: 0, WARMUP: 3, DURATION: 10, NAMED, OUT: `/out/${tag}_${BACKEND}_h${HIT}_n${NAMED}_vu${VUS}_r${rep}.json` };
      const t0 = Date.now();
      const r = spawnSync('docker', [...COMPOSE, 'run', '--rm', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'k6', 'run', '-q', '/scripts/cache.js'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      const m = (r.stdout || '').match(/rps=([\d.]+) avg=([\d.]+)ms p95=([\d.]+)ms/);
      rows.push({ BACKEND, HIT, NAMED, VUS, rep, rps: m ? Number(m[1]) : NaN, avg: m ? Number(m[2]) : NaN, p95: m ? Number(m[3]) : NaN });
      console.log(`r${rep} ${BACKEND} h${HIT} named=${NAMED} vu=${VUS} →`, m ? m[0] : (r.stderr || '').trim().split('\n').pop(), `(${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
} finally {
  writeFileSync(join(HERE, 'out', `${tag}.json`), JSON.stringify(rows, null, 2));
}
