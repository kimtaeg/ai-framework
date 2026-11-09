/**
 * 측정 중 신뢰도 점검 — results/raw 를 읽어서 지금까지의 품질을 숫자로 낸다.
 *   node experiment/check.js          한 줄 요약 (RELIABILITY=xx.x% ...)
 *
 *  신뢰도 = 두 지표 중 낮은 값
 *   ① 성공률      : 요청이 1건 이상이고 에러율 1% 미만인 회차 비율
 *   ② 재현성      : 2회 이상 측정된 조건에서, 각 회차 처리량이 그 조건 중앙값의 ±15% 안에 든 비율
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = join(dirname(fileURLToPath(import.meta.url)), 'results', 'raw');
const runs = readdirSync(RAW).filter((f) => f.endsWith('.json')).map((f) => ({ f, key: f.replace(/_r\d+\.json$/, ''), ...JSON.parse(readFileSync(join(RAW, f), 'utf8')) }));
const ok = runs.filter((r) => r.rps > 0 && (r.errorRate ?? 0) < 0.01);
const success = runs.length ? ok.length / runs.length : 1;

const byKey = {};
for (const r of ok) (byKey[r.key] ??= []).push(r);
let inBand = 0, counted = 0;
const outliers = [];
for (const [key, rs] of Object.entries(byKey)) {
  if (rs.length < 2) continue;
  const s = rs.map((r) => r.rps).sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  for (const r of rs) {
    counted++;
    const dev = (r.rps - med) / med;
    if (Math.abs(dev) <= 0.15) inBand++;
    else outliers.push(`${r.f.replace('.json', '')} ${(dev * 100).toFixed(0)}%`);
  }
}
const repro = counted ? inBand / counted : 1;
const reliability = Math.min(success, repro);
console.log(`RELIABILITY=${(reliability * 100).toFixed(1)}% runs=${runs.length} success=${(success * 100).toFixed(1)}% repro=${(repro * 100).toFixed(1)}% (${inBand}/${counted})`);
if (process.argv.includes('-v')) console.log(outliers.join('\n'));
