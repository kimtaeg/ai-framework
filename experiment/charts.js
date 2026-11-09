/**
 * summary.json → README 에 넣을 SVG 그래프 (의존성 없음, GitHub 에서 <img> 로 보임)
 *   analyze.js 가 불러서 results/*.svg 를 만든다.
 */
const C = { none: '#8A93A3', mini: '#E07B24', redis: '#2F6FD6', ink: '#1A2233', soft: '#5A6578', grid: '#E3E1DA', bg: '#FBFAF7' };
const NAME = { none: '캐시 없음', mini: '미니 레디스', redis: 'Redis 7' };
const FONT = "font-family=\"-apple-system, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif\"";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (x) => (x === 0 ? '0' : x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)}k` : x >= 10 ? x.toFixed(0) : x.toFixed(1));

function frame(w, h, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${FONT}>
<rect width="${w}" height="${h}" fill="${C.bg}" rx="12"/>
<text x="32" y="44" font-size="22" font-weight="700" fill="${C.ink}">${esc(title)}</text>
<text x="32" y="72" font-size="15" fill="${C.soft}">${esc(subtitle)}</text>
${body}
</svg>`;
}

function legend(x, y, items) {
  return items.map(([label, color, dashed], i) => {
    const xx = x + i * 170;
    return `<line x1="${xx}" y1="${y}" x2="${xx + 28}" y2="${y}" stroke="${color}" stroke-width="3" ${dashed ? 'stroke-dasharray="6 5"' : ''}/>` +
      (dashed ? '' : `<circle cx="${xx + 14}" cy="${y}" r="5" fill="${color}"/>`) +
      `<text x="${xx + 36}" y="${y + 5}" font-size="14" fill="${C.ink}">${esc(label)}</text>`;
  }).join('\n');
}

/**
 * 히트율(x) 그래프. series: [{ key, color, points:[{h, y, ci}], model:[{h,y}] }]
 * logY: 처리량처럼 범위가 큰 값
 */
export function hitChart({ title, subtitle, yLabel, series, baseline, logY = false, legendItems }) {
  const W = 880, H = 520, L = 88, R = 32, T = 104, B = 72;
  const pw = W - L - R, ph = H - T - B;
  const ys = series.flatMap((s) => [...s.points.map((p) => p.y + (p.ci || 0)), ...(s.model || []).map((m) => m.y)]).concat(baseline ? [baseline.y] : []).filter((v) => v > 0 && Number.isFinite(v));
  let y0 = logY ? Math.pow(10, Math.floor(Math.log10(Math.min(...ys)))) : 0;
  let y1 = logY ? Math.pow(10, Math.ceil(Math.log10(Math.max(...ys)))) : Math.max(...ys) * 1.1;
  const sx = (h) => L + h * pw;
  const sy = (v) => logY ? T + ph - (Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) * ph : T + ph - (v - y0) / (y1 - y0) * ph;
  let g = '';
  // 격자
  const ticks = logY ? Array.from({ length: Math.round(Math.log10(y1 / y0)) + 1 }, (_, i) => y0 * 10 ** i) : Array.from({ length: 6 }, (_, i) => (y1 / 5) * i);
  for (const t of ticks) g += `<line x1="${L}" y1="${sy(t)}" x2="${W - R}" y2="${sy(t)}" stroke="${C.grid}"/><text x="${L - 10}" y="${sy(t) + 5}" font-size="13" fill="${C.soft}" text-anchor="end">${fmt(t)}</text>`;
  for (const h of [0, 0.25, 0.5, 0.75, 1]) g += `<text x="${sx(h)}" y="${T + ph + 24}" font-size="13" fill="${C.soft}" text-anchor="middle">${h * 100}%</text>`;
  g += `<text x="${L + pw / 2}" y="${H - 18}" font-size="14" fill="${C.ink}" text-anchor="middle">캐시 히트율</text>`;
  g += `<text x="22" y="${T + ph / 2}" font-size="14" fill="${C.ink}" text-anchor="middle" transform="rotate(-90 22 ${T + ph / 2})">${esc(yLabel)}</text>`;
  if (baseline) g += `<line x1="${L}" y1="${sy(baseline.y)}" x2="${W - R}" y2="${sy(baseline.y)}" stroke="${C.none}" stroke-width="2" stroke-dasharray="2 4"/><text x="${W - R - 4}" y="${sy(baseline.y) - 8}" font-size="13" fill="${C.soft}" text-anchor="end">${esc(baseline.label)}</text>`;
  for (const s of series) {
    if (s.model?.length) g += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="6 5" opacity="0.8" points="${s.model.map((m) => `${sx(m.h)},${sy(m.y)}`).join(' ')}"/>`;
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.points.map((p) => `${sx(p.h)},${sy(p.y)}`).join(' ')}"/>`;
    for (const p of s.points) {
      if (p.ci) g += `<line x1="${sx(p.h)}" y1="${sy(p.y - p.ci)}" x2="${sx(p.h)}" y2="${sy(p.y + p.ci)}" stroke="${s.color}" stroke-width="2"/>`;
      g += `<circle cx="${sx(p.h)}" cy="${sy(p.y)}" r="5" fill="${s.color}"/>`;
    }
  }
  g += legend(L, T - 16, legendItems);
  return frame(W, H, title, subtitle, g);
}

/** 묶음 막대. groups: [{ label, bars:[{ key, y, ci, note }] }] */
export function barChart({ title, subtitle, yLabel, groups }) {
  const W = 880, H = 500, L = 88, R = 32, T = 104, B = 80;
  const pw = W - L - R, ph = H - T - B;
  const raw = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.y + (b.ci || 0)))) * 1.12;
  const mag = 10 ** Math.floor(Math.log10(raw / 5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 5 >= raw);
  const max = step * 5;
  const sy = (v) => T + ph - (v / max) * ph;
  const gw = pw / groups.length;
  let g = '';
  for (let i = 0; i <= 5; i++) { const t = step * i; g += `<line x1="${L}" y1="${sy(t)}" x2="${W - R}" y2="${sy(t)}" stroke="${C.grid}"/><text x="${L - 10}" y="${sy(t) + 5}" font-size="13" fill="${C.soft}" text-anchor="end">${fmt(t)}</text>`; }
  g += `<text x="22" y="${T + ph / 2}" font-size="14" fill="${C.ink}" text-anchor="middle" transform="rotate(-90 22 ${T + ph / 2})">${esc(yLabel)}</text>`;
  groups.forEach((grp, gi) => {
    const bw = Math.min(64, (gw - 40) / grp.bars.length);
    const x0 = L + gi * gw + (gw - bw * grp.bars.length) / 2;
    grp.bars.forEach((b, bi) => {
      const x = x0 + bi * bw;
      g += `<rect x="${x + 4}" y="${sy(b.y)}" width="${bw - 8}" height="${T + ph - sy(b.y)}" fill="${C[b.key]}" rx="3"/>`;
      if (b.ci) g += `<line x1="${x + bw / 2}" y1="${sy(Math.max(0, b.y - b.ci))}" x2="${x + bw / 2}" y2="${sy(b.y + b.ci)}" stroke="${C.ink}" stroke-width="1.5"/>`;
      g += `<text x="${x + bw / 2}" y="${sy(b.y + (b.ci || 0)) - 8}" font-size="13" fill="${C.ink}" text-anchor="middle">${b.note ?? fmt(b.y)}</text>`;
    });
    g += `<text x="${L + gi * gw + gw / 2}" y="${T + ph + 26}" font-size="14" fill="${C.ink}" text-anchor="middle">${esc(grp.label)}</text>`;
  });
  g += legend(L, T - 16, ['none', 'mini', 'redis'].map((k) => [NAME[k], C[k]]));
  return frame(W, H, title, subtitle, g);
}

export { C as COLORS, NAME };
