/**
 * 결과 정리: results/raw/*.json → results/summary.json, results/summary.md
 *   조건마다 반복 측정의 중앙값 · 평균 · 표준편차 · 95% 신뢰구간(t 분포) · 변동계수
 *   모델 검증
 *     E1 지연시간  T(h) = h·T_hit + (1−h)·T_miss            (대기열이 없을 때)
 *     E2 처리량    X(h) = min( X_db / (1−h), X_cache )      (DB 가 병목일 때: DB 로 가는 몫이 (1−h) 뿐)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hitChart, barChart, COLORS, NAME } from './charts.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'results', 'raw');
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };

const stat = (xs) => {
  xs = xs.filter((x) => x != null && Number.isFinite(x));
  const n = xs.length;
  if (!n) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, median: med, mean, sd, ci95: n > 1 ? (T95[n - 1] ?? 1.96) * sd / Math.sqrt(n) : 0, cvPct: mean ? (sd / mean) * 100 : 0, min: s[0], max: s[n - 1] };
};

const groups = {};
for (const f of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
  const key = f.replace(/_r\d+\.json$/, '');
  const d = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
  d.file = f;
  (groups[key] ??= { key, exp: key.split('_')[0], params: d.params, runs: [] }).runs.push(d);
}

const conds = Object.values(groups).map((g) => ({
  key: g.key, exp: g.exp, ...g.params,
  rps: stat(g.runs.map((r) => r.rps)),
  avg: stat(g.runs.map((r) => r.lat?.avg)),
  p50: stat(g.runs.map((r) => r.lat?.med)),
  p95: stat(g.runs.map((r) => r.lat?.['p(95)'])),
  p99: stat(g.runs.map((r) => r.lat?.['p(99)'])),
  hit: stat(g.runs.map((r) => r.hitRate)),
  errors: stat(g.runs.map((r) => r.errorRate)),
}));
const find = (exp, backend, extra = {}) => conds.find((c) => c.exp === exp && c.BACKEND === backend && Object.entries(extra).every(([k, v]) => c[k] === v));
const med = (s) => s?.median;

// 기준(캐시 없음) 대비 배율
for (const c of conds) {
  const base = c.MODE === 'ycsb' ? find(c.exp, 'none', { WORKLOAD: c.WORKLOAD }) : find(c.exp, 'none');
  if (base && c !== base) { c.speedupRps = med(c.rps) / med(base.rps); c.speedupAvgLat = med(base.avg) / med(c.avg); c.speedupP95 = med(base.p95) / med(c.p95); }
}

const models = { E1: [], E2: [] };
for (const b of ['mini', 'redis']) {
  const h0 = find('E1', b, { HIT: 0 }), h1 = find('E1', b, { HIT: 1 });
  if (h0 && h1) for (const c of conds.filter((x) => x.exp === 'E1' && x.BACKEND === b)) {
    const h = med(c.hit) ?? c.HIT;
    const pred = h * med(h1.avg) + (1 - h) * med(h0.avg);
    models.E1.push({ backend: b, hitNominal: c.HIT, hitMeasured: h, measuredMs: med(c.avg), predictedMs: pred, errorPct: ((med(c.avg) - pred) / pred) * 100, ci95Ms: c.avg.ci95 });
  }
  const x0 = find('E2', b, { HIT: 0 }), x1 = find('E2', b, { HIT: 1 });
  if (x0 && x1) for (const c of conds.filter((x) => x.exp === 'E2' && x.BACKEND === b)) {
    const h = med(c.hit) ?? c.HIT;
    const pred = Math.min(h >= 1 ? Infinity : med(x0.rps) / (1 - h), med(x1.rps));
    models.E2.push({ backend: b, hitNominal: c.HIT, hitMeasured: h, measuredRps: med(c.rps), predictedRps: pred, errorPct: ((med(c.rps) - pred) / pred) * 100, ci95Rps: c.rps.ci95 });
  }
}
for (const m of Object.values(models)) m.sort((a, b) => a.backend.localeCompare(b.backend) || a.hitNominal - b.hitNominal);

// E3: 가벼운 쿼리에서 캐시가 이득이 되는 히트율 (캐시 없음 처리량과 같아지는 지점, 선형 보간)
const breakEven = {};
const none3 = find('E3', 'none');
for (const b of ['mini', 'redis']) {
  const pts = conds.filter((c) => c.exp === 'E3' && c.BACKEND === b).sort((a, z) => a.HIT - z.HIT);
  if (!none3 || pts.length < 2) continue;
  const target = med(none3.rps);
  if (med(pts[0].rps) >= target) { breakEven[b] = 0; continue; }
  if (med(pts.at(-1).rps) < target) { breakEven[b] = null; continue; } // 100% 여도 손해
  for (let i = 1; i < pts.length; i++) {
    const [a, z] = [pts[i - 1], pts[i]];
    if (med(z.rps) >= target) { breakEven[b] = a.HIT + (z.HIT - a.HIT) * (target - med(a.rps)) / (med(z.rps) - med(a.rps)); break; }
  }
}

// 점검: 시간이 지나면서 결과가 변했는지 (발열 · 데이터 누적 같은 오염)
//   같은 조건의 앞 회차(r1·r2)와 뒤 회차(r4·r5) 처리량 평균 차이. ±10% 를 넘으면 의심
const rep = (r) => Number(r.file.match(/_r(\d+)\.json$/)[1]);
const driftCheck = [];
for (const g of Object.values(groups)) {
  const early = g.runs.filter((r) => rep(r) <= 2).map((r) => r.rps);
  const late = g.runs.filter((r) => rep(r) >= 4).map((r) => r.rps);
  if (!early.length || !late.length) continue;
  const e = stat(early).mean, l = stat(late).mean;
  driftCheck.push({ key: g.key, earlyRps: e, lateRps: l, diffPct: ((l - e) / e) * 100 });
}
driftCheck.sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));

const env = JSON.parse(readFileSync(join(HERE, 'results', 'env.json'), 'utf8'));
const summary = { env, conditions: conds.sort((a, b) => a.key.localeCompare(b.key)), models, breakEven, driftCheck, maxCvPct: Math.max(...conds.map((c) => c.rps?.cvPct ?? 0)) };
writeFileSync(join(HERE, 'results', 'summary.json'), JSON.stringify(summary, null, 2));

// 사람이 읽는 표
const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
let md = `# 캐시 실험 결과\n\n측정 ${env.measuredAt} · ${env.host.cpu} · Docker ${env.docker.version} · 반복 ${env.method.reps}회 · ${env.method.durationSec}초\n\n`;
md += `| 조건 | 처리량 req/s (중앙값 ± 95%CI) | CV% | 평균 ms | p95 ms | p99 ms | 히트율 | 캐시없음 대비 |\n|---|---|---|---|---|---|---|---|\n`;
for (const c of summary.conditions) md += `| ${c.key} | ${f(med(c.rps))} ± ${f(c.rps.ci95)} | ${f(c.rps.cvPct)} | ${f(med(c.avg), 2)} | ${f(med(c.p95), 2)} | ${f(med(c.p99), 2)} | ${c.hit ? f(med(c.hit) * 100) + '%' : '-'} | ${c.speedupRps ? f(c.speedupRps, 2) + '배' : '-'} |\n`;
md += `\n## E1 지연시간 모델 T(h) = h·T_hit + (1−h)·T_miss\n\n| 캐시 | 히트율 | 실측 ms | 예측 ms | 오차 |\n|---|---|---|---|---|\n`;
for (const m of models.E1) md += `| ${m.backend} | ${f(m.hitMeasured * 100)}% | ${f(m.measuredMs, 2)} | ${f(m.predictedMs, 2)} | ${f(m.errorPct)}% |\n`;
md += `\n## E2 처리량 모델 X(h) = min(X_db/(1−h), X_cache)\n\n| 캐시 | 히트율 | 실측 req/s | 예측 req/s | 오차 |\n|---|---|---|---|---|\n`;
for (const m of models.E2) md += `| ${m.backend} | ${f(m.hitMeasured * 100)}% | ${f(m.measuredRps)} | ${f(m.predictedRps)} | ${f(m.errorPct)}% |\n`;
md += `\n## E3 가벼운 쿼리 손익분기 히트율\n\n${Object.entries(breakEven).map(([b, v]) => `- ${b}: ${v == null ? '100% 여도 캐시 없음보다 느림' : f(v * 100) + '% 이상이어야 이득'}`).join('\n')}\n`;
const drifted = driftCheck.filter((d) => Math.abs(d.diffPct) > 10);
md += `\n## 점검: 시간에 따른 변화 (앞 회차 r1·r2 vs 뒤 회차 r4·r5 처리량)\n\n`;
md += `- ±10% 를 넘는 조건: ${drifted.length}개 / ${driftCheck.length}개\n`;
md += driftCheck.slice(0, 8).map((d) => `- ${d.key}: ${f(d.earlyRps)} → ${f(d.lateRps)} req/s (${d.diffPct > 0 ? '+' : ''}${f(d.diffPct)}%)`).join('\n') + '\n';
writeFileSync(join(HERE, 'results', 'summary.md'), md);
console.log(md);

// ---- 그래프 (README 용 SVG) ----
const pts = (exp, b, field) => conds.filter((c) => c.exp === exp && c.BACKEND === b).sort((a, z) => a.HIT - z.HIT)
  .map((c) => ({ h: med(c.hit) ?? c.HIT, y: med(c[field]), ci: c[field].ci95 }));
const modelLine = (rows, field) => rows.map((m) => ({ h: m.hitMeasured, y: m[field] })).filter((m) => Number.isFinite(m.y));
const svg = (name, s) => writeFileSync(join(HERE, 'results', name), s);
const none1 = find('E1', 'none'), none2 = find('E2', 'none');
if (models.E1.length) svg('e1-latency.svg', hitChart({
  title: 'E1 · 응답시간은 공식대로 줄어든다 (VU 1, 전체 읽기 쿼리)',
  subtitle: '점: 실측 중앙값 (막대 = 95% 신뢰구간) · 점선: T(h) = h·T_hit + (1−h)·T_miss',
  yLabel: '평균 응답시간 (ms)', logY: true,
  series: ['mini', 'redis'].map((b) => ({ key: b, color: COLORS[b], points: pts('E1', b, 'avg'), model: modelLine(models.E1.filter((m) => m.backend === b), 'predictedMs') })),
  baseline: none1 && { y: med(none1.avg), label: `캐시 없음 ${f(med(none1.avg))}ms` },
  legendItems: [[NAME.mini, COLORS.mini], [NAME.redis, COLORS.redis], ['공식 예측', COLORS.soft, true]],
}));
if (models.E2.length) svg('e2-throughput.svg', hitChart({
  title: 'E2 · 처리량은 DB 로 가는 몫(1−h)에 반비례 (VU 50, 전체 읽기 쿼리)',
  subtitle: '점: 실측 중앙값 · 점선: X(h) = min(X_db / (1−h), X_cache) · 세로축 로그',
  yLabel: '처리량 (req/s)', logY: true,
  series: ['mini', 'redis'].map((b) => ({ key: b, color: COLORS[b], points: pts('E2', b, 'rps'), model: modelLine(models.E2.filter((m) => m.backend === b), 'predictedRps') })),
  baseline: none2 && { y: med(none2.rps), label: `캐시 없음 ${f(med(none2.rps))}/s` },
  legendItems: [[NAME.mini, COLORS.mini], [NAME.redis, COLORS.redis], ['공식 예측', COLORS.soft, true]],
}));
if (none3) svg('e3-light-query.svg', barChart({
  title: 'E3 · 가벼운 쿼리(B+ 트리 조회)에서는 캐시가 손해일 수 있다',
  subtitle: 'VU 50 · 처리량 중앙값 (막대 위 숫자) · 오차 막대 = 95% 신뢰구간',
  yLabel: '처리량 (req/s)',
  groups: [0, 0.9, 1].map((h) => ({ label: `히트율 ${h * 100}%`, bars: ['none', 'mini', 'redis'].map((b) => { const c = b === 'none' ? none3 : find('E3', b, { HIT: h }); return c ? { key: b, y: med(c.rps), ci: c.rps.ci95 } : null; }).filter(Boolean) })),
}));
if (find('E4', 'none', { WORKLOAD: 'C' })) svg('e4-ycsb.svg', barChart({
  title: 'E4 · YCSB 표준 워크로드 (Zipf θ=0.99, B+ 트리 조회, VU 50)',
  subtitle: '쓰기가 늘수록 캐시 무효화와 쓰기 락 때문에 이득이 줄어든다 · 막대 위: 처리량 (히트율)',
  yLabel: '처리량 (req/s)',
  groups: [['C', 'C · 읽기 100%'], ['B', 'B · 읽기 95 : 쓰기 5'], ['A', 'A · 읽기 50 : 쓰기 50']].map(([w, label]) => ({
    label, bars: ['none', 'mini', 'redis'].map((b) => { const c = find('E4', b, { WORKLOAD: w }); return c ? { key: b, y: med(c.rps), ci: c.rps.ci95, note: `${fmtK(med(c.rps))}${c.hit ? ` (${Math.round(med(c.hit) * 100)}%)` : ''}` } : null; }).filter(Boolean),
  })),
}));
function fmtK(x) { return x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0); }
