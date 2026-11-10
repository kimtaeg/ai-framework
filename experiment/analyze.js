/**
 * 결과 정리: results/raw/*.json → results/summary.json, results/summary.md, results/*.svg
 *   조건마다 반복 측정의 중앙값 · 평균 · 표준편차 · 95% 신뢰구간(t 분포) · 변동계수
 *   모델 검증
 *     E1 지연시간  T(h) = h·T_hit + (1−h)·T_miss            (대기열이 없을 때)
 *     E2 처리량    X(h) = min( X_db / (1−h), X_cache )      (DB 가 병목일 때: DB 로 가는 몫이 (1−h) 뿐)
 *   손익분기 히트율 (캐시를 써도 캐시 없음과 같아지는 히트율, 선형 보간)
 *     E3 처리량 · 지연 없음   E5 처리량 · 지연 있음   E6 응답시간(VU 1) · 지연 없음 / 있음
 *   요청당 CPU (k6 가 측정 시작 · 끝에 기록한 CPU 누적값의 차이 ÷ 요청 수) — 통신 방식 비교
 *   신뢰도: 성공률 · ±15% 재현성 · 시간에 따른 변화(앞 1/3 회차 vs 뒤 1/3 회차)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderHitChart, renderBarChart, COLORS, NAME } from './charts.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'results', 'raw');
// t 분포 95% 양측 임계값 (자유도 1~30). 30을 넘으면 정규분포 근사 1.96 (오차 2% 미만)
const T95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const LIGHT = ['mini', 'miniresp', 'redis'];

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
let brokenFiles = 0;
for (const f of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
  const key = f.replace(/_r\d+\.json$/, '');
  let d;
  try { d = JSON.parse(readFileSync(join(RAW, f), 'utf8')); } catch {
    console.error(`건너뜀: ${f} (잘렸거나 깨진 결과 파일 — node experiment/run.js --resume 로 다시 측정하세요)`);
    brokenFiles++;
    continue;
  }
  d.file = f;
  (groups[key] ??= { key, exp: key.split('_')[0], params: d.params, runs: [] }).runs.push(d);
}

// 캐시 서버 쪽 CPU: 미니 레디스(HTTP · RESP 둘 다 같은 프로세스) 또는 Redis
const cacheCpu = (b, r) => (b === 'redis' ? r.cpu?.redisMsPerReq : b === 'mini' || b === 'miniresp' ? r.cpu?.miniMsPerReq : null);
const conds = Object.values(groups).map((g) => ({
  key: g.key, exp: g.exp, ...g.params, DELAY_MS: g.params.DELAY_MS ?? 0,
  rps: stat(g.runs.map((r) => r.rps)),
  avg: stat(g.runs.map((r) => r.lat?.avg)),
  p50: stat(g.runs.map((r) => r.lat?.med)),
  p95: stat(g.runs.map((r) => r.lat?.['p(95)'])),
  p99: stat(g.runs.map((r) => r.lat?.['p(99)'])),
  hit: stat(g.runs.map((r) => r.hitRate)),
  errors: stat(g.runs.map((r) => r.errorRate)),
  cpuApp: stat(g.runs.map((r) => r.cpu?.appMsPerReq)),
  cpuCache: stat(g.runs.map((r) => cacheCpu(g.params.BACKEND, r))),
}));
const find = (exp, backend, extra = {}) => conds.find((c) => c.exp === exp && c.BACKEND === backend && Object.entries(extra).every(([k, v]) => c[k] === v));
const med = (s) => s?.median;

// 기준(캐시 없음 · 같은 실험 · 같은 워크로드 · 같은 지연) 대비 배율
for (const c of conds) {
  const base = c.MODE === 'ycsb' ? find(c.exp, 'none', { WORKLOAD: c.WORKLOAD }) : find(c.exp, 'none', { DELAY_MS: c.DELAY_MS });
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

/**
 * 손익분기 히트율: 캐시를 쓴 쪽이 캐시 없음과 같아지는 히트율 (측정한 히트율 사이를 선형 보간)
 *   field 'rps' 는 클수록, 'avg' 는 작을수록 좋다 → 작을수록 좋은 값은 부호를 뒤집어 같은 식으로 계산
 *   히트율 0% 에서 이미 같거나 좋으면(두 신뢰구간이 겹치면 같은 것으로 봄) 0 — 오차 범위 안의 차이로 가짜 정밀도를 만들지 않는다
 *   100% 여도 나쁘면 null
 */
function breakEvenOf(exp, b, delay, field) {
  const sign = field === 'avg' ? -1 : 1;
  const none = find(exp, 'none', { DELAY_MS: delay });
  const pts = conds.filter((c) => c.exp === exp && c.BACKEND === b && c.DELAY_MS === delay).sort((a, z) => a.HIT - z.HIT);
  if (!none || pts.length < 2) return undefined;
  const v = (c) => sign * med(c[field]);
  const target = v(none);
  if (v(pts[0]) >= target || target - v(pts[0]) <= pts[0][field].ci95 + none[field].ci95) return 0;
  if (v(pts.at(-1)) < target) return null;
  for (let i = 1; i < pts.length; i++) {
    const [a, z] = [pts[i - 1], pts[i]];
    if (v(z) >= target) return a.HIT + (z.HIT - a.HIT) * (target - v(a)) / (v(z) - v(a));
  }
  return null;
}
const beTable = (exp, delay, field) => Object.fromEntries(LIGHT.map((b) => [b, breakEvenOf(exp, b, delay, field)]).filter(([, v]) => v !== undefined));
const delays = [...new Set(conds.map((c) => c.DELAY_MS).filter((d) => d > 0))].sort((a, b) => a - b);
const DELAY = delays[0] ?? null; // 지연 조건은 한 가지 값으로 잰다 (run.js --delay)
const breakEven = beTable('E3', 0, 'rps'); // 처리량 기준 · 지연 없음 (예전 결과와 같은 정의)
const breakEvens = {
  throughputLocal: breakEven,
  throughputDelayed: DELAY ? beTable('E5', DELAY, 'rps') : {},
  latencyLocal: beTable('E6', 0, 'avg'),
  latencyDelayed: DELAY ? beTable('E6', DELAY, 'avg') : {},
};

// 통신 방식 비교: 가벼운 쿼리 · 히트율 100% (DB 를 전혀 안 감 → 캐시 호출 비용만 남는다)
const protocol = LIGHT.map((b) => {
  const c = find('E3', b, { HIT: 1 });
  if (!c) return null;
  const app = med(c.cpuApp), cache = med(c.cpuCache);
  return { backend: b, rps: med(c.rps), rpsCi95: c.rps.ci95, speedupRps: c.speedupRps, appMsPerReq: app, cacheMsPerReq: cache, totalMsPerReq: app != null && cache != null ? app + cache : null, avgMs: med(c.avg) };
}).filter(Boolean);
const noneCpu = find('E3', 'none');

// 점검: 시간이 지나면서 결과가 변했는지 (발열 · 데이터 누적 같은 오염)
//   같은 조건의 앞 1/3 회차와 뒤 1/3 회차 처리량 평균 차이 (5회면 r1·r2 vs r4·r5). ±10% 를 넘으면 의심
const rep = (r) => Number(r.file.match(/_r(\d+)\.json$/)[1]);
const driftCheck = [];
for (const g of Object.values(groups)) {
  const R = Math.max(...g.runs.map(rep));
  const k = Math.ceil(R / 3);
  const early = g.runs.filter((r) => rep(r) <= k).map((r) => r.rps);
  const late = g.runs.filter((r) => rep(r) > R - k).map((r) => r.rps);
  if (R < 3 || !early.length || !late.length) continue;
  const e = stat(early).mean, l = stat(late).mean;
  driftCheck.push({ key: g.key, earlyRps: e, lateRps: l, diffPct: ((l - e) / e) * 100, earlyReps: `r1~r${k}`, lateReps: `r${R - k + 1}~r${R}` });
}
driftCheck.sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));

// 신뢰도 (check.js 와 같은 정의): 성공률 · 각 회차가 그 조건 중앙값 ±15% 안에 든 비율
const allRuns = Object.values(groups).flatMap((g) => g.runs.map((r) => ({ ...r, key: g.key })));
const okRuns = allRuns.filter((r) => r.rps > 0 && (r.errorRate ?? 0) < 0.01);
let inBand = 0, counted = 0;
const outliers = [];
for (const c of conds) {
  const rs = okRuns.filter((r) => r.key === c.key);
  if (rs.length < 2) continue;
  const m = stat(rs.map((r) => r.rps)).median;
  for (const r of rs) { counted++; const dev = (r.rps - m) / m; if (Math.abs(dev) <= 0.15) inBand++; else outliers.push({ file: r.file, devPct: dev * 100 }); }
}
const totalRuns = allRuns.length + brokenFiles;
const reliability = {
  runs: totalRuns, successRuns: okRuns.length, successPct: totalRuns ? (okRuns.length / totalRuns) * 100 : null,
  reproPct: counted ? (inBand / counted) * 100 : null, inBand, counted,
  outliers: outliers.sort((a, b) => Math.abs(b.devPct) - Math.abs(a.devPct)),
  outliersByRep: outliers.reduce((o, x) => { const r = `r${x.file.match(/_r(\d+)\.json$/)[1]}`; o[r] = (o[r] ?? 0) + 1; return o; }, {}),
  cvUnder10: conds.filter((c) => (c.rps?.cvPct ?? 0) < 10).length,
  conditions: conds.length,
};

// env.json 은 run.js 가 측정 환경(CPU · Docker · 반복 횟수)을 적어 두는 파일 — 결과 파일만 받아 온 경우 없을 수 있다
const ENV_FILE = join(HERE, 'results', 'env.json');
let env;
try { env = JSON.parse(readFileSync(ENV_FILE, 'utf8')); } catch (e) {
  console.error(`측정 환경 파일을 읽을 수 없습니다: ${ENV_FILE}`);
  console.error(e.code === 'ENOENT' ? '  → 측정한 컴퓨터의 experiment/results/env.json 도 함께 복사하거나, node experiment/run.js 로 다시 측정하세요.' : `  → 파일이 깨졌습니다 (${e.message})`);
  process.exit(1);
}
const summary = {
  env, conditions: conds.sort((a, b) => a.key.localeCompare(b.key)), models, breakEven, breakEvens, protocol, reliability, driftCheck,
  maxCvPct: Math.max(...conds.map((c) => c.rps?.cvPct ?? 0)),
};
writeFileSync(join(HERE, 'results', 'summary.json'), JSON.stringify(summary, null, 2));

// 사람이 읽는 표
const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
const pct = (v) => (v == null ? '100% 여도 캐시 없음보다 나쁨' : v === 0 ? '0% (히트율 0% 에서도 오차 범위 안에서 같음)' : `${f(v * 100)}% 이상이어야 이득`);
let md = `# 캐시 실험 결과\n\n측정 ${env.measuredAt} · ${env.host.cpu} · Docker ${env.docker.version} · 반복 ${env.method.reps}회 · ${env.method.durationSec}초 · 총 ${totalRuns}회\n\n`;
md += `| 조건 | 처리량 req/s (중앙값 ± 95%CI) | CV% | 평균 ms | p95 ms | p99 ms | 히트율 | 캐시없음 대비 | 앱 CPU ms/요청 | 캐시 CPU ms/요청 |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const c of summary.conditions) md += `| ${c.key} | ${f(med(c.rps))} ± ${f(c.rps.ci95)} | ${f(c.rps.cvPct)} | ${f(med(c.avg), 2)} | ${f(med(c.p95), 2)} | ${f(med(c.p99), 2)} | ${c.hit ? f(med(c.hit) * 100) + '%' : '-'} | ${c.speedupRps ? f(c.speedupRps, 2) + '배' : '-'} | ${f(med(c.cpuApp), 3)} | ${f(med(c.cpuCache), 3)} |\n`;
md += `\n## E1 지연시간 모델 T(h) = h·T_hit + (1−h)·T_miss\n\n| 캐시 | 히트율 | 실측 ms | 예측 ms | 오차 |\n|---|---|---|---|---|\n`;
for (const m of models.E1) md += `| ${m.backend} | ${f(m.hitMeasured * 100)}% | ${f(m.measuredMs, 2)} | ${f(m.predictedMs, 2)} | ${f(m.errorPct)}% |\n`;
md += `\n## E2 처리량 모델 X(h) = min(X_db/(1−h), X_cache)\n\n| 캐시 | 히트율 | 실측 req/s | 예측 req/s | 오차 |\n|---|---|---|---|---|\n`;
for (const m of models.E2) md += `| ${m.backend} | ${f(m.hitMeasured * 100)}% | ${f(m.measuredRps)} | ${f(m.predictedRps)} | ${f(m.errorPct)}% |\n`;
md += `\n## E3 가벼운 쿼리 손익분기 히트율\n\n${Object.entries(breakEven).map(([b, v]) => `- ${b}: ${pct(v)}`).join('\n')}\n`;
if (DELAY || Object.keys(breakEvens.latencyLocal).length) {
  md += `\n## 손익분기 히트율: 지연 없음 vs 앱 → 캐시 왕복 +${DELAY ?? '-'}ms\n\n| 캐시 | 처리량 (VU 50) · 지연 없음 (E3) | 처리량 · 지연 (E5) | 응답시간 (VU 1) · 지연 없음 (E6) | 응답시간 · 지연 (E6) |\n|---|---|---|---|---|\n`;
  const cell = (v) => (v === undefined ? '-' : v == null ? '100% 여도 손해' : `${f(v * 100)}%`);
  for (const b of LIGHT) md += `| ${b} | ${cell(breakEvens.throughputLocal[b])} | ${cell(breakEvens.throughputDelayed[b])} | ${cell(breakEvens.latencyLocal[b])} | ${cell(breakEvens.latencyDelayed[b])} |\n`;
  if (env.network) {
    md += `\n캐시까지 PING 왕복 (앱 서버 안에서 500회, 중앙값): `;
    md += ['mini', 'miniresp', 'redis'].map((b) => `${b} ${f(env.network.rttLocal?.[b]?.medianMs, 3)}ms${env.network.rttDelayed ? ` → ${f(env.network.rttDelayed[b]?.medianMs, 3)}ms` : ''}`).join(' · ') + '\n';
  }
}
if (protocol.length) {
  md += `\n## 통신 방식 비교 (E3 · 가벼운 쿼리 · 히트율 100%)\n\n| 캐시 | 처리량 req/s | 캐시없음 대비 | 앱 서버 CPU ms/요청 | 캐시 서버 CPU ms/요청 | 합계 |\n|---|---|---|---|---|---|\n`;
  if (noneCpu) md += `| none | ${f(med(noneCpu.rps))} | 1.00배 | ${f(med(noneCpu.cpuApp), 3)} | - | ${f(med(noneCpu.cpuApp), 3)} |\n`;
  for (const p of protocol) md += `| ${p.backend} | ${f(p.rps)} ± ${f(p.rpsCi95)} | ${f(p.speedupRps, 2)}배 | ${f(p.appMsPerReq, 3)} | ${f(p.cacheMsPerReq, 3)} | ${f(p.totalMsPerReq, 3)} |\n`;
}
const R = reliability;
md += `\n## 신뢰도\n\n- 성공 ${R.successRuns}/${R.runs} (${f(R.successPct)}%) · ±15% 재현 ${R.inBand}/${R.counted} (${f(R.reproPct)}%) · CV 10% 미만 ${R.cvUnder10}/${R.conditions} 조건 · 최대 CV ${f(summary.maxCvPct)}%\n`;
md += `- ±15% 밖 회차의 반복 번호 분포: ${Object.entries(R.outliersByRep).sort().map(([k, v]) => `${k} ${v}개`).join(' · ') || '없음'}\n`;
const drifted = driftCheck.filter((d) => Math.abs(d.diffPct) > 10);
md += `\n## 점검: 시간에 따른 변화 (앞 1/3 회차 vs 뒤 1/3 회차 처리량)\n\n`;
md += `- ±10% 를 넘는 조건: ${drifted.length}개 / ${driftCheck.length}개\n`;
md += driftCheck.slice(0, 8).map((d) => `- ${d.key}: ${f(d.earlyRps)} (${d.earlyReps}) → ${f(d.lateRps)} (${d.lateReps}) req/s (${d.diffPct > 0 ? '+' : ''}${f(d.diffPct)}%)`).join('\n') + '\n';
writeFileSync(join(HERE, 'results', 'summary.md'), md);
console.log(md);

// ---- 그래프 (README 용 SVG) ----
const pts = (exp, b, field, delay = 0) => conds.filter((c) => c.exp === exp && c.BACKEND === b && c.DELAY_MS === delay).sort((a, z) => a.HIT - z.HIT)
  .map((c) => ({ h: med(c.hit) ?? c.HIT, y: med(c[field]), ci: c[field].ci95 }));
const modelLine = (rows, field) => rows.map((m) => ({ h: m.hitMeasured, y: m[field] })).filter((m) => Number.isFinite(m.y));
const svg = (name, s) => writeFileSync(join(HERE, 'results', name), s);
const has = (b, exp) => conds.some((c) => c.exp === exp && c.BACKEND === b);
const none1 = find('E1', 'none'), none2 = find('E2', 'none');
if (models.E1.length) svg('e1-latency.svg', renderHitChart({
  title: 'E1 · 응답시간은 공식대로 줄어든다 (VU 1, 전체 읽기 쿼리)',
  subtitle: '점: 실측 중앙값 (막대 = 95% 신뢰구간) · 점선: T(h) = h·T_hit + (1−h)·T_miss',
  yLabel: '평균 응답시간 (ms)', logY: true,
  series: ['mini', 'redis'].map((b) => ({ key: b, color: COLORS[b], points: pts('E1', b, 'avg'), model: modelLine(models.E1.filter((m) => m.backend === b), 'predictedMs') })),
  baseline: none1 && { y: med(none1.avg), label: `캐시 없음 ${f(med(none1.avg))}ms` },
  legendItems: [[NAME.mini, COLORS.mini], [NAME.redis, COLORS.redis], ['공식 예측', COLORS.soft, true]],
}));
if (models.E2.length) svg('e2-throughput.svg', renderHitChart({
  title: 'E2 · 처리량은 DB 로 가는 몫(1−h)에 반비례 (VU 50, 전체 읽기 쿼리)',
  subtitle: '점: 실측 중앙값 · 점선: X(h) = min(X_db / (1−h), X_cache) · 세로축 로그',
  yLabel: '처리량 (req/s)', logY: true,
  series: ['mini', 'redis'].map((b) => ({ key: b, color: COLORS[b], points: pts('E2', b, 'rps'), model: modelLine(models.E2.filter((m) => m.backend === b), 'predictedRps') })),
  baseline: none2 && { y: med(none2.rps), label: `캐시 없음 ${f(med(none2.rps))}/s` },
  legendItems: [[NAME.mini, COLORS.mini], [NAME.redis, COLORS.redis], ['공식 예측', COLORS.soft, true]],
}));
const none3 = find('E3', 'none');
if (none3) {
  const hits3 = [...new Set(conds.filter((c) => c.exp === 'E3' && c.BACKEND !== 'none').map((c) => c.HIT))].sort((a, b) => a - b);
  svg('e3-light-query.svg', renderBarChart({
    title: 'E3 · 가벼운 쿼리(B+ 트리 조회)에서는 캐시가 손해일 수 있다',
    subtitle: 'VU 50 · 처리량 중앙값 (막대 위 숫자) · 오차 막대 = 95% 신뢰구간',
    yLabel: '처리량 (req/s)',
    groups: hits3.map((h) => ({ label: `히트율 ${Math.round(h * 100)}%`, bars: ['none', ...LIGHT].map((b) => { const c = b === 'none' ? none3 : find('E3', b, { HIT: h }); return c ? { key: b, y: med(c.rps), ci: c.rps.ci95 } : null; }).filter(Boolean) })),
  }));
}
if (find('E4', 'none', { WORKLOAD: 'C' })) svg('e4-ycsb.svg', renderBarChart({
  title: 'E4 · YCSB 표준 워크로드 (Zipf θ=0.99, B+ 트리 조회, VU 50)',
  subtitle: '쓰기가 늘수록 캐시 무효화와 쓰기 락 때문에 이득이 줄어든다 · 막대 위: 처리량 (히트율)',
  yLabel: '처리량 (req/s)',
  groups: [['C', 'C · 읽기 100%'], ['B', 'B · 읽기 95 : 쓰기 5'], ['A', 'A · 읽기 50 : 쓰기 50']].map(([w, label]) => ({
    label, bars: ['none', ...LIGHT].map((b) => { const c = find('E4', b, { WORKLOAD: w }); return c ? { key: b, y: med(c.rps), ci: c.rps.ci95, note: `${fmtK(med(c.rps))}${c.hit ? ` (${Math.round(med(c.hit) * 100)}%)` : ''}` } : null; }).filter(Boolean),
  })),
}));
// E5: 지연을 넣은 처리량 (실선) vs 지연 없는 E3 (점선)
const none5 = DELAY && find('E5', 'none', { DELAY_MS: DELAY });
if (none5) svg('e5-delay.svg', renderHitChart({
  title: `E5 · 캐시까지 왕복 +${DELAY}ms · 동시 요청 50개면 처리량은 크게 안 준다`,
  subtitle: `VU 50 · B+ 트리 조회 · 실선: 지연 +${DELAY}ms (E5) · 점선: 지연 없음 (E3) · 가로 점선: 캐시 없음`,
  yLabel: '처리량 (req/s)',
  series: LIGHT.filter((b) => has(b, 'E5')).map((b) => ({ key: b, color: COLORS[b], points: pts('E5', b, 'rps', DELAY), model: pts('E3', b, 'rps').map(({ h, y }) => ({ h, y })) })),
  baseline: { y: med(none5.rps), label: `캐시 없음 ${f(med(none5.rps), 0)}/s` },
  legendItems: [...LIGHT.filter((b) => has(b, 'E5')).map((b) => [NAME[b], COLORS[b]]), ['지연 없음', COLORS.soft, true]],
}));
// E6: VU 1 응답시간 — 지연이 그대로 보이는 경우
const none6 = find('E6', 'none', { DELAY_MS: 0 });
if (none6 && DELAY) svg('e6-latency-delay.svg', renderHitChart({
  title: `E6 · 대기열이 없으면 왕복 +${DELAY}ms 가 응답시간에 그대로 더해진다 (VU 1)`,
  subtitle: `실선: 지연 +${DELAY}ms · 점선: 지연 없음 · 가로 점선: 캐시 없음 · B+ 트리 조회`,
  yLabel: '평균 응답시간 (ms)',
  series: LIGHT.filter((b) => has(b, 'E6')).map((b) => ({ key: b, color: COLORS[b], points: pts('E6', b, 'avg', DELAY), model: pts('E6', b, 'avg', 0).map(({ h, y }) => ({ h, y })) })),
  baseline: { y: med(none6.avg), label: `캐시 없음 ${f(med(none6.avg), 2)}ms` },
  legendItems: [...LIGHT.filter((b) => has(b, 'E6')).map((b) => [NAME[b], COLORS[b]]), ['지연 없음', COLORS.soft, true]],
}));
// 통신 방식: 요청 하나당 CPU (앱 서버 · 캐시 서버)
if (protocol.length && protocol.every((p) => p.appMsPerReq != null && p.cacheMsPerReq != null)) svg('e3-cpu-protocol.svg', renderBarChart({
  title: '통신 방식 비교 · 요청 하나에 드는 CPU (가벼운 쿼리, 히트율 100%)',
  subtitle: '같은 미니 레디스 저장소를 HTTP+JSON / RESP 로 · 실제 Redis 7 · 중앙값, 오차 막대 = 95% 신뢰구간',
  yLabel: 'CPU 시간 (ms / 요청)',
  groups: [['cpuApp', '앱 서버 (캐시를 부르는 쪽)'], ['cpuCache', '캐시 서버 (응답하는 쪽)']].map(([field, label]) => ({
    label, bars: protocol.map((p) => { const c = find('E3', p.backend, { HIT: 1 }); return { key: p.backend, y: med(c[field]), ci: c[field].ci95, note: med(c[field]).toFixed(3) }; }),
  })),
}));
function fmtK(x) { return x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0); }
