/** 작은 SVG 차트 (선 · 막대). 마우스를 올리면 값이 보인다 (data-tip). */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const W = 640, H = 300, M = { l: 56, r: 16, t: 14, b: 40 };
const fmt = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

function scale(lo, hi, a, b, log) {
  if (log) { const L0 = Math.log10(lo), L1 = Math.log10(hi); return (v) => a + ((Math.log10(Math.max(v, lo)) - L0) / (L1 - L0)) * (b - a); }
  return (v) => a + ((v - lo) / (hi - lo || 1)) * (b - a);
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(10 ** e);
  return out.filter((v) => v >= lo * 0.999 && v <= hi * 1.001);
}
const yRange = (vals, log, ref) => {
  const all = vals.concat(ref != null ? [ref] : []).filter((v) => v > 0);
  if (log) return [10 ** Math.floor(Math.log10(Math.min(...all))), 10 ** Math.ceil(Math.log10(Math.max(...all)))];
  return [0, Math.max(...all) * 1.1];
};
const yAxis = (lo, hi, y, log) => {
  const ticks = log ? logTicks(lo, hi) : Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  return ticks.map((v) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('');
};

export function lineChart({ xs, series, logX, logY, xLabel, yLabel, ref }) {
  const RIGHT = 150; // 선 끝 이름표 자리
  const x = scale(Math.min(...xs), Math.max(...xs), M.l + 10, W - RIGHT, logX);
  const [lo, hi] = yRange(series.flatMap((s) => s.ys), logY, ref?.y);
  const y = scale(lo, hi, H - M.b, M.t, logY);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} / ${esc(xLabel)}">`;
  s += yAxis(lo, hi, y, logY);
  const ends = [];
  let lastX = -Infinity; // 너무 붙는 눈금 글자는 건너뛴다
  s += xs.map((v, i) => { const px = x(v); if (px - lastX < 40 && i !== xs.length - 1) return ''; lastX = px; return `<text x="${px}" y="${H - M.b + 18}" text-anchor="middle">${v.toLocaleString()}</text>`; }).join('');
  s += `<text x="${(M.l + W - M.r) / 2}" y="${H - 6}" text-anchor="middle">${esc(xLabel)}</text><text x="12" y="${M.t + 4}" >${esc(yLabel)}</text>`;
  if (ref) s += `<line x1="${M.l}" x2="${W - RIGHT + 10}" y1="${y(ref.y)}" y2="${y(ref.y)}" stroke="var(--ref)" stroke-width="1.5" stroke-dasharray="5 4"/><text class="lab" x="${M.l + 6}" y="${y(ref.y) - 6}">${esc(ref.label)}</text>`;
  for (const se of series) {
    const pts = xs.map((v, i) => [x(v), y(se.ys[i])]);
    s += `<polyline fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
    s += pts.map(([px, py], i) => `<circle cx="${px}" cy="${py}" r="4.5" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/><circle cx="${px}" cy="${py}" r="12" fill="transparent" data-tip="${esc(se.name)} · ${xs[i].toLocaleString()} → ${fmt(se.ys[i])}ms"/>`).join('');
    ends.push({ x: pts.at(-1)[0] + 12, y: pts.at(-1)[1] + 4, text: `${se.name} ${fmt(se.ys.at(-1))}ms` });
  }
  // 끝 이름표가 서로 겹치지 않게 14px 이상 띄운다
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  s += ends.map((e) => `<text class="lab" x="${e.x}" y="${e.y}">${esc(e.text)}</text>`).join('');
  return s + '</svg>';
}

export function barChart({ cats, series, logY, yLabel }) {
  const [lo, hi] = yRange(series.flatMap((s) => s.ys), logY);
  const base = logY ? Math.max(lo, 0.5) : 0;
  const y = scale(logY ? base : lo, hi, H - M.b, M.t, logY);
  const band = (W - M.l - M.r) / cats.length;
  const bw = Math.min(28, (band - 16) / series.length - 2);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">`;
  s += yAxis(logY ? base : lo, hi, y, logY);
  s += `<text x="12" y="${M.t + 4}">${esc(yLabel)}</text>`;
  cats.forEach((c, i) => {
    const cx = M.l + band * i + band / 2;
    const groupW = series.length * bw + (series.length - 1) * 2;
    series.forEach((se, j) => {
      const v = Math.max(se.ys[i], base);
      const x0 = cx - groupW / 2 + j * (bw + 2);
      const top = y(v), bottom = H - M.b, hgt = Math.max(1, bottom - top), r = Math.min(4, hgt / 2, bw / 2);
      s += `<path d="M${x0},${bottom} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${bottom} Z" fill="${se.color}" data-tip="${esc(c)} · ${esc(se.name)} → ${se.ys[i].toLocaleString()}"/>`;
      s += `<text class="lab" x="${x0 + bw / 2}" y="${top - 5}" text-anchor="middle">${se.ys[i].toLocaleString()}</text>`;
    });
    s += `<text x="${cx}" y="${H - M.b + 18}" text-anchor="middle">${esc(c)}</text>`;
  });
  return s + '</svg>';
}
