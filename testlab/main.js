// 테스트 실험실 화면: 작업 버튼, 실시간 출력, 기록, 리포트
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS = { running: '도는 중', passed: '성공', failed: '실패', stopped: '멈춤' };
const dur = (a, b) => { const s = Math.round(((b || Date.now()) - a) / 1000); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };
const time = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let shownId = null, shownLines = 0, jobsDrawn = false, timer = null;

async function api(path, body) {
  const r = await fetch(`/api/testlab/${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { location.replace(`/testlab/login.html?next=${encodeURIComponent('/testlab/')}`); throw new Error('login'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `오류 ${r.status}`);
  return d;
}

function drawJobs(jobs) {
  const card = ([id, j]) => `
    <div class="card job">
      <h2>${esc(j.title)}</h2>
      <p>${esc(j.desc)}</p>
      <div class="row">
        ${j.options ? `<select data-opt="${esc(id)}" aria-label="${esc(j.title)} 옵션">${Object.entries(j.options).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>` : ''}
        <button class="primary" data-run="${esc(id)}">실행</button>
      </div>
    </div>`;
  const all = Object.entries(jobs);
  $('#jobs').innerHTML = all.filter(([, j]) => !j.compare && !j.alt).map(card).join('');
  $('#cmp-jobs').innerHTML = all.filter(([, j]) => j.compare).map(card).join('');
  $('#alt-jobs').innerHTML = all.filter(([, j]) => j.alt).map(card).join('');
  jobsDrawn = true;
}

// ---------------------------------------------------------------- 결과 비교
const fmtNum = (v) => (v == null ? '-' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString());
const withUnit = (v, info) => (v == null ? '-' : `${fmtNum(v)}${info?.unit === '/s' ? '/s' : info?.unit ? ` ${info.unit}` : ''}`);
const when = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 두 값 중 좋은 쪽이 몇 배 좋은가 (better: high = 클수록 좋음) */
function ratio(a, b, better) {
  if (a == null || b == null) return null;
  if (better === 'high') return b > 0 ? a / b : null;
  return a > 0 ? b / a : null;
}
/** 지난번(prev) → 이번(cur) 변화. ±10% 안은 측정 오차 */
function change(cur, prev, better) {
  if (cur == null || prev == null || prev === 0) return '<span class="same">-</span>';
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 10) return `<span class="same">${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% 비슷함</span>`;
  const good = better === 'high' ? pct > 0 : pct < 0;
  return `<span class="${good ? 'good' : 'worse'}">${pct > 0 ? '+' : ''}${pct.toFixed(0)}% ${good ? '좋아짐' : '나빠짐'}</span>`;
}

function drawCompare(group, M, jobs) {
  const [cur, prev] = group.runs;
  const keys = ['rps', 'p95', 'med', 'fail', 'cacheHit'].filter((k) => cur.a.metrics[k] != null || cur.b.metrics[k] != null);
  const x = ratio(cur.a.metrics.rps, cur.b.metrics.rps, 'high');
  const y = ratio(cur.a.metrics.p95, cur.b.metrics.p95, 'low');
  const headline = x == null ? '' : x >= 1
    ? `<b>${esc(cur.a.label)}</b> 쪽이 초당 요청 <b>${fmtNum(x)}배</b>, p95 응답 <b>${fmtNum(y)}배</b> 빠름`
    : `오히려 <b>${esc(cur.b.label)}</b> 쪽이 초당 요청 ${fmtNum(1 / x)}배 — 이 조건에서는 기술의 이점이 안 보임`;
  const max = Math.max(cur.a.metrics.rps || 0, cur.b.metrics.rps || 0, 1);
  const bar = (side, cls) => `<span>${esc(side.label)}</span><div class="bar ${cls}" style="width:${Math.max(0.5, (side.metrics.rps / max) * 100)}%"></div><span class="num">${fmtNum(side.metrics.rps)}/s</span>`;
  const rows = keys.map((k) => {
    const r = ratio(cur.a.metrics[k], cur.b.metrics[k], M[k].better);
    const rt = r == null || k === 'fail' ? '-' : r >= 1 ? `있음이 ${fmtNum(r)}배 좋음` : `없음이 ${fmtNum(1 / r)}배 좋음`;
    return `<tr><td>${esc(M[k].label)}</td><td class="num">${withUnit(cur.a.metrics[k], M[k])}</td><td class="num">${withUnit(cur.b.metrics[k], M[k])}</td><td>${rt}</td><td>${prev ? change(cur.a.metrics[k], prev.a.metrics[k], M[k].better) : '<span class="same">첫 실행</span>'}</td></tr>`;
  }).join('');
  const opt = group.option ? ` · ${esc(jobs[group.job]?.options?.[group.option] ?? group.option)}` : '';
  return `<div class="cmp"><h3>${esc(group.title)}${opt}</h3>
    <p class="head">${headline}</p>
    <div class="bars">${bar(cur.a, '')}${bar(cur.b, 'b')}</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>지표</th><th>기술 있음</th><th>기술 없음</th><th>차이</th><th>지난번 대비 (있음 기준)</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin:8px 0 0;font-size:12px">${when(cur.at)} 실행${prev ? ` · 지난번 ${when(prev.at)}` : ''}</p></div>`;
}

/** 대안 비교: 여러 방식 × 여러 지표. 지표마다 가장 좋은 칸에 ★, 우리 기술(첫 줄)이 몇 등인지 한 줄로 */
function drawAlt(group, M, jobs) {
  const [cur, prev] = group.runs;
  const V = cur.variants;
  const keys = [...new Set(V.flatMap((v) => Object.keys(v.metrics)))].filter((k) => M[k] && V.some((v) => v.metrics[k] != null));
  const bestOf = (k) => {
    const vals = V.map((v) => v.metrics[k]).filter((x) => x != null);
    return M[k].better === 'high' ? Math.max(...vals) : Math.min(...vals);
  };
  const main = cur.main && M[cur.main] ? cur.main : keys[0];
  const ours = V[0];
  const wins = keys.filter((k) => ours.metrics[k] === bestOf(k) && !(k === 'fail' && V.every((v) => v.metrics[k] === ours.metrics[k])));
  const others = V.slice(1);
  // 우리 기술 vs 다른 것들: 주 지표 기준 몇 배
  const vsText = others.map((o) => {
    const r = ratio(ours.metrics[main], o.metrics[main], M[main].better);
    if (r == null) return '';
    return r >= 1 ? `${esc(o.label)} 보다 ${fmtNum(r)}배 좋음` : `${esc(o.label)} 이 ${fmtNum(1 / r)}배 좋음`;
  }).filter(Boolean).join(' · ');
  const headline = `<b>${esc(ours.label)}</b> — ${esc(M[main].label)}: ${vsText}${wins.length ? ` · 가장 좋은 지표 ${wins.length}/${keys.length}개 (${wins.map((k) => esc(M[k].label)).join(', ')})` : ''}`;
  const max = Math.max(...V.map((v) => (M[main].better === 'high' ? v.metrics[main] : 1 / Math.max(v.metrics[main], 1e-9)) || 0), 1e-9);
  const barVal = (v) => (M[main].better === 'high' ? v.metrics[main] : 1 / Math.max(v.metrics[main], 1e-9));
  const bars = V.map((v, i) => `<span>${esc(v.label)}</span><div class="bar ${['', 'b', 'c'][i] ?? 'c'}" style="width:${Math.max(0.5, (barVal(v) / max) * 100)}%"></div><span class="num">${withUnit(v.metrics[main], M[main])}</span>`).join('');
  const head = `<tr><th>방식</th>${keys.map((k) => `<th>${esc(M[k].label)} <span class="muted">(${M[k].better === 'high' ? '클수록' : '작을수록'} 좋음)</span></th>`).join('')}</tr>`;
  const rows = V.map((v, i) => `<tr class="${i === 0 ? 'alt-ours' : ''}"><td>${esc(v.label)}</td>${keys.map((k) => {
    const isBest = v.metrics[k] != null && v.metrics[k] === bestOf(k) && !V.every((w) => w.metrics[k] === v.metrics[k]);
    return `<td class="num">${withUnit(v.metrics[k], M[k])}${isBest ? ' <span class="star" title="가장 좋음">★</span>' : ''}</td>`;
  }).join('')}</tr>`).join('');
  const prevRow = prev ? `<tr><td class="muted">지난번 대비 (우리)</td>${keys.map((k) => `<td>${change(ours.metrics[k], prev.variants?.[0]?.metrics?.[k], M[k].better)}</td>`).join('')}</tr>` : '';
  const opt = group.option ? ` · ${esc(jobs[group.job]?.options?.[group.option] ?? group.option)}` : '';
  return `<div class="cmp"><h3>${esc(group.title)}${opt}</h3>
    <p class="head">${headline}</p>
    <p class="note" style="margin:0 0 4px">막대: ${esc(M[main].label)} (${M[main].better === 'high' ? '길수록' : '짧은 시간일수록 길게'} 좋음)</p>
    <div class="bars">${bars}</div>
    <div class="table-wrap"><table class="t"><thead>${head}</thead><tbody>${rows}${prevRow}</tbody></table></div>
    ${jobs[group.job]?.why ? `<p class="head" style="margin:10px 0 0"><b>왜 이걸 골랐나</b> — ${esc(jobs[group.job].why)}</p>` : ''}
    ${cur.note ? `<p class="note">${esc(cur.note)}</p>` : ''}
    <p class="note">${when(cur.at)} 실행${prev ? ` · 지난번 ${when(prev.at)}` : ''}</p></div>`;
}

function drawTrend(groups, M, jobs) {
  const rows = [];
  for (const g of groups) {
    if (g.runs[0].compare || g.runs[0].alt || g.runs.length < 2) continue;
    const [cur, prev] = g.runs;
    for (const [k, v] of Object.entries(cur.metrics || {})) {
      if (!M[k]) continue;
      const opt = g.option ? ` (${esc(jobs[g.job]?.options?.[g.option] ?? g.option)})` : '';
      rows.push(`<tr><td>${esc(g.title)}${opt}</td><td>${esc(M[k].label)}</td><td class="num">${withUnit(prev.metrics?.[k], M[k])}</td><td class="num">${withUnit(v, M[k])}</td><td>${change(v, prev.metrics?.[k], M[k].better)}</td></tr>`);
    }
  }
  return rows.length ? `<table class="t"><thead><tr><th>작업</th><th>지표</th><th>지난번</th><th>이번</th><th>변화</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '';
}

let resultsKey = '';
function drawResults(s) {
  const key = JSON.stringify(s.results);
  if (key === resultsKey) return;
  resultsKey = key;
  const cmp = s.results.filter((g) => g.runs[0].compare);
  if (cmp.length) $('#cmp-results').innerHTML = cmp.map((g) => drawCompare(g, s.metrics, s.jobs)).join('');
  const alt = s.results.filter((g) => g.runs[0].alt && g.runs[0].variants);
  if (alt.length) $('#alt-results').innerHTML = alt.map((g) => drawAlt(g, s.metrics, s.jobs)).join('');
  const trend = drawTrend(s.results, s.metrics, s.jobs);
  if (trend) $('#trend-results').innerHTML = trend;
}

function lineHtml(l) {
  const cls = /^\$ /.test(l) ? 'cmd' : /✓|^ℹ fail 0$|✓ '/.test(l) ? 'ok' : /✗|✖|^ℹ fail [1-9]|오류|실패|Error/.test(l) ? 'bad' : '';
  return cls ? `<span class="${cls}">${esc(l)}</span>\n` : `${esc(l)}\n`;
}

function draw(s) {
  if (!jobsDrawn) drawJobs(s.jobs);
  drawResults(s);
  const c = s.current;
  const running = c?.status === 'running';
  document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = running; });
  $('#stop').disabled = !running;
  if (c) {
    $('#run-title').textContent = c.title + (c.option ? ` · ${s.jobs[c.job]?.options?.[c.option] ?? c.option}` : '');
    const badge = $('#run-status');
    badge.textContent = STATUS[c.status] ?? c.status;
    badge.className = `badge ${c.status}`;
    $('#run-time').textContent = `${time(c.startedAt)} 시작 · ${dur(c.startedAt, c.endedAt)}`;
    const out = $('#out');
    if (shownId !== c.id) { out.innerHTML = ''; shownId = c.id; shownLines = 0; }
    if (c.from === shownLines && c.lines.length) {
      out.insertAdjacentHTML('beforeend', c.lines.map(lineHtml).join(''));
      shownLines += c.lines.length;
      if ($('#follow').checked) out.scrollTop = out.scrollHeight;
    } else if (c.from !== shownLines) {
      shownLines = 0; out.innerHTML = '';
    }
  }
  $('#history').innerHTML = s.history.length
    ? s.history.map((h) => `<tr><td>${time(h.startedAt)}</td><td>${esc(h.title)}${h.option ? ` (${esc(s.jobs[h.job]?.options?.[h.option] ?? h.option)})` : ''}</td><td><span class="badge ${h.status}">${STATUS[h.status] ?? h.status}</span></td><td>${dur(h.startedAt, h.endedAt)}</td><td>${esc(h.summary || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">아직 없음</td></tr>';
  $('#reports').innerHTML = s.reports.length
    ? s.reports.map((r) => `<a class="btn" href="${esc(r.path)}" target="_blank" rel="noopener">${esc(r.name.replace(/\.html$/, ''))}</a>`).join('')
    : '<span class="muted">아직 없음</span>';
  return running;
}

async function poll() {
  clearTimeout(timer);
  try {
    const s = await api(`state?from=${shownLines}`);
    const running = draw(s);
    timer = setTimeout(poll, running ? 700 : 3000);
  } catch (e) {
    if (e.message !== 'login') { $('#err').textContent = e.message; timer = setTimeout(poll, 3000); }
  }
}

document.addEventListener('click', async (e) => {
  const run = e.target.closest('[data-run]');
  if (run) {
    $('#err').textContent = '';
    const id = run.dataset.run;
    const opt = document.querySelector(`[data-opt="${CSS.escape(id)}"]`)?.value;
    try { await api('run', { job: id, option: opt }); shownId = null; poll(); } catch (err) { if (err.message !== 'login') $('#err').textContent = err.message; }
  }
});
$('#stop').addEventListener('click', async () => { try { await api('stop', {}); poll(); } catch (err) { $('#err').textContent = err.message; } });
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); } finally { location.replace('/testlab/login.html'); } });

poll();
