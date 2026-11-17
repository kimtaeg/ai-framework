/**
 * README 에 넣을 SVG 그래프 (의존성 없음, GitHub 에서 <img> 로 보임 — 색은 고정값)
 */
export const C = { ours: '#1F9D6B', common: '#D64545', naive: '#8A93A3', v0: '#D64545', v1: '#E0A23B', v2: '#1F9D6B', ink: '#1A2233', soft: '#5A6578', grid: '#E3E1DA', bg: '#FBFAF7' };
const FONT = "font-family=\"-apple-system, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif\"";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const fmt = (x) => (x >= 10000 ? `${Math.round(x / 1000)}k` : x >= 1000 ? `${+(x / 1000).toFixed(1)}k` : x >= 10 ? String(Math.round(x)) : x >= 1 ? String(+x.toFixed(1)) : String(+x.toFixed(2)));
const textW = (s) => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 14 : 8), 0);

function frame(w, h, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${FONT}>
<rect width="${w}" height="${h}" fill="${C.bg}" rx="12"/>
<text x="32" y="44" font-size="22" font-weight="700" fill="${C.ink}">${esc(title)}</text>
<text x="32" y="72" font-size="15" fill="${C.soft}">${esc(subtitle)}</text>
${body}
</svg>`;
}

function legend(x, y, items) {
  let next = x;
  return items.map(([label, color, dashed]) => {
    const xx = next;
    next += 36 + textW(label) + 28;
    return `<line x1="${xx}" y1="${y}" x2="${xx + 28}" y2="${y}" stroke="${color}" stroke-width="3" ${dashed ? 'stroke-dasharray="6 5"' : ''}/>` +
      `<text x="${xx + 36}" y="${y + 5}" font-size="14" fill="${C.ink}">${esc(label)}</text>`;
  }).join('\n');
}

/**
 * 로그-로그 선 그래프. series: [{ label, color, dashed, points: [{x, y}], endLabel }]
 */
export function renderLogLog({ title, subtitle, xLabel, yLabel, series, xTicks, yUnit = '', legendExtra = [] }) {
  const W = 880, H = 540, L = 92, R = 120, T = 112, B = 72;
  const pw = W - L - R, ph = H - T - B;
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v > 0);
  const x0 = Math.log10(Math.min(...xs)), x1 = Math.log10(Math.max(...xs));
  const y0 = Math.floor(Math.log10(Math.min(...ys))), y1 = Math.ceil(Math.log10(Math.max(...ys)));
  const sx = (v) => L + ((Math.log10(v) - x0) / (x1 - x0)) * pw;
  const sy = (v) => T + ph - ((Math.log10(Math.max(v, 10 ** y0)) - y0) / (y1 - y0)) * ph;
  let g = '';
  for (let e = y0; e <= y1; e++) g += `<line x1="${L}" y1="${sy(10 ** e)}" x2="${L + pw}" y2="${sy(10 ** e)}" stroke="${C.grid}"/><text x="${L - 10}" y="${sy(10 ** e) + 5}" font-size="13" fill="${C.soft}" text-anchor="end">${fmt(10 ** e)}${yUnit}</text>`;
  for (const t of xTicks) g += `<text x="${sx(t)}" y="${T + ph + 24}" font-size="13" fill="${C.soft}" text-anchor="middle">${fmt(t)}</text>`;
  g += `<text x="${L + pw / 2}" y="${H - 18}" font-size="14" fill="${C.ink}" text-anchor="middle">${esc(xLabel)}</text>`;
  g += `<text x="22" y="${T + ph / 2}" font-size="14" fill="${C.ink}" text-anchor="middle" transform="rotate(-90 22 ${T + ph / 2})">${esc(yLabel)}</text>`;
  for (const s of series) {
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="3" ${s.dashed ? 'stroke-dasharray="7 6"' : ''} points="${s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>`;
    for (const p of s.points) g += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4.5" fill="${s.color}"/>`;
    const last = s.points.at(-1);
    if (s.endLabel) g += `<text x="${sx(last.x) + 10}" y="${sy(last.y) + 5}" font-size="14" font-weight="700" fill="${s.color}">${esc(s.endLabel)}</text>`;
  }
  g += legend(L, T - 22, [...series.filter((s) => s.label).map((s) => [s.label, s.color, s.dashed]), ...legendExtra]);
  return frame(W, H, title, subtitle, g);
}

/** 묶음 막대. groups: [{ label, bars: [{ key, label, y, note }] }] */
export function renderBars({ title, subtitle, yLabel, groups, legendItems }) {
  const W = 880, H = 500, L = 88, R = 32, T = 112, B = 80;
  const pw = W - L - R, ph = H - T - B;
  const raw = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.y))) * 1.15;
  const mag = 10 ** Math.floor(Math.log10(raw / 5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 5 >= raw);
  const max = step * 5;
  const sy = (v) => T + ph - (v / max) * ph;
  const gw = pw / groups.length;
  let g = '';
  for (let i = 0; i <= 5; i++) { const t = step * i; g += `<line x1="${L}" y1="${sy(t)}" x2="${W - R}" y2="${sy(t)}" stroke="${C.grid}"/><text x="${L - 10}" y="${sy(t) + 5}" font-size="13" fill="${C.soft}" text-anchor="end">${fmt(t)}</text>`; }
  g += `<text x="22" y="${T + ph / 2}" font-size="14" fill="${C.ink}" text-anchor="middle" transform="rotate(-90 22 ${T + ph / 2})">${esc(yLabel)}</text>`;
  groups.forEach((grp, gi) => {
    const bw = Math.min(70, (gw - 40) / grp.bars.length);
    const xg = L + gi * gw + (gw - bw * grp.bars.length) / 2;
    grp.bars.forEach((b, bi) => {
      const x = xg + bi * bw;
      g += `<rect x="${x + 4}" y="${sy(b.y)}" width="${bw - 8}" height="${T + ph - sy(b.y)}" fill="${C[b.key]}" rx="3"/>`;
      g += `<text x="${x + bw / 2}" y="${sy(b.y) - 8}" font-size="13" font-weight="${b.key === 'ours' ? 700 : 400}" fill="${C.ink}" text-anchor="middle">${esc(b.note ?? fmt(b.y))}</text>`;
    });
    g += `<text x="${L + gi * gw + gw / 2}" y="${T + ph + 26}" font-size="14" fill="${C.ink}" text-anchor="middle">${esc(grp.label)}</text>`;
    if (grp.sub) g += `<text x="${L + gi * gw + gw / 2}" y="${T + ph + 46}" font-size="13" font-weight="700" fill="${C.ours}" text-anchor="middle">${esc(grp.sub)}</text>`;
  });
  g += legend(L, T - 22, legendItems);
  return frame(W, H, title, subtitle, g);
}

/** 막대 하나짜리 분포 (히스토그램). bins: [{ label, count, color }] */
export function renderHistogram({ title, subtitle, yLabel, bins, note }) {
  const W = 880, H = 460, L = 88, R = 32, T = 100, B = 90;
  const pw = W - L - R, ph = H - T - B;
  const raw = Math.max(...bins.map((b) => b.count)) * 1.15;
  const mag = 10 ** Math.floor(Math.log10(raw / 5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 5 >= raw);
  const max = step * 5;
  const sy = (v) => T + ph - (v / max) * ph;
  const bw = pw / bins.length;
  let g = '';
  for (let i = 0; i <= 5; i++) { const t = step * i; g += `<line x1="${L}" y1="${sy(t)}" x2="${W - R}" y2="${sy(t)}" stroke="${C.grid}"/><text x="${L - 10}" y="${sy(t) + 5}" font-size="13" fill="${C.soft}" text-anchor="end">${t.toLocaleString('en-US')}</text>`; }
  g += `<text x="22" y="${T + ph / 2}" font-size="14" fill="${C.ink}" text-anchor="middle" transform="rotate(-90 22 ${T + ph / 2})">${esc(yLabel)}</text>`;
  bins.forEach((b, i) => {
    const x = L + i * bw;
    if (b.count > 0) g += `<rect x="${x + 10}" y="${sy(b.count)}" width="${bw - 20}" height="${T + ph - sy(b.count)}" fill="${b.color}" rx="3"/>`;
    g += `<text x="${x + bw / 2}" y="${sy(b.count) - 8}" font-size="14" font-weight="700" fill="${b.count === 0 ? C.common : C.ink}" text-anchor="middle">${b.count.toLocaleString('en-US')}</text>`;
    g += `<text x="${x + bw / 2}" y="${T + ph + 24}" font-size="13" fill="${C.ink}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (note) g += `<text x="${L}" y="${H - 22}" font-size="14" fill="${C.soft}">${esc(note)}</text>`;
  return frame(W, H, title, subtitle, g);
}
