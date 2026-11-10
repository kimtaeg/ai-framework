/**
 * LIS MOVE 비교 — 같은 목록 조작을 두 가지 key diff 로 동시에 적용한다.
 *  A: 우리 diff (src/lib/diff.js) — LIS 로 이동 횟수 최소
 *  B: 앞에서부터 방식 (./naive.js) — React 의 lastPlacedIndex
 * 두 방식 모두 같은 applyPatches 로 실제 DOM 에 적용하고, 실제 DOM 조작은 MutationObserver 로 센다.
 */
import { h, createElement, diff, applyPatches, PatchType, longestIncreasingSubsequence } from '../src/lib/index.js';
import { diffNaive, naiveMoves } from './naive.js';

const $ = (s, el = document) => el.querySelector(s);
const nInput = $('#n');
const weightSel = $('#weight');
const fmt = (x) => Number(x).toLocaleString('ko-KR');

let items = [];
let nextId = 0;

// ---------------------------------------------------------------- 목록 VNode
const color = (id) => `hsl(${(id * 47) % 360} 65% 55%)`;
const imgCache = new Map();
function imgFor(id) {
  if (imgCache.has(id)) return imgCache.get(id);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color(id); g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.fillText(String(id), 32, 40);
  const url = c.toDataURL('image/png');
  imgCache.set(id, url);
  return url;
}
const row = (it) => {
  const w = weightSel.value;
  const kids = [h('span', { class: 'sw', style: { background: color(it.id) } })];
  if (w === 'image') kids.push(h('img', { class: 'pic', src: imgFor(it.id), width: 24, height: 24, alt: '' }));
  kids.push(h('span', { class: 'id' }, `#${it.id}`), h('span', { class: 'label' }, it.label));
  if (w !== 'light') kids.push(h('span', { class: 'extra' }, ...Array.from({ length: 12 }, (_, j) => h('b', { title: `${it.id}-${j}` }, String((it.id * 7 + j) % 10)))));
  kids.push(h('input', { placeholder: '메모' }), h('span', { class: 'tag' }));
  return h('li', { key: it.id }, ...kids);
};
const listV = (list) => h('ul', null, list.map(row));

// ---------------------------------------------------------------- 두 패널
const panes = [
  { el: $('#paneA'), diffFn: diff },
  { el: $('#paneB'), diffFn: diffNaive },
].map((p) => ({ ...p, stage: $('.stage', p.el), prev: null, root: null, born: new WeakMap(), observer: new MutationObserver(() => {}) }));

function mountPane(p) {
  p.observer.disconnect();
  p.prev = listV(items);
  p.root = createElement(p.prev);
  p.stage.replaceChildren(p.root);
  p.born = new WeakMap();
  [...p.root.children].forEach((li, i) => {
    p.born.set(li, items[i].id);
    $('input', li).value = `메모 ${items[i].id}`;
  });
  p.observer.observe(p.root, { subtree: true, childList: true, characterData: true, attributes: true });
  mark(p, new Set());
}

/** 입력칸 글자가 원래 줄 것인지 표시 (key 를 쓰는 두 방식 모두 항상 맞아야 한다) */
function mark(p, fresh) {
  let ok = 0;
  [...p.root.children].forEach((li, i) => {
    const wrong = p.born.get(li) !== items[i].id;
    li.classList.toggle('wrong', wrong);
    $('.tag', li).textContent = fresh.has(li) ? '새 줄' : '';
    if (!wrong) ok++;
  });
  return ok;
}

function flash(li) {
  li.classList.remove('fl-move');
  void li.offsetWidth; // 애니메이션 다시 시작
  li.classList.add('fl-move');
  $('.tag', li).textContent = '옮김';
}

function update(p, nextItems) {
  p.observer.takeRecords();
  const next = listV(nextItems);
  const moved = new Set();
  const fresh = new Set();
  document.body.offsetHeight; // 앞에서 남은 스타일 계산을 먼저 끝내 둔다
  const t0 = performance.now();
  const patches = p.diffFn(p.prev, next);
  const tDiff = performance.now();
  p.root = applyPatches(p.root, patches, {
    onApply(patch, node) {
      if (patch.type === PatchType.MOVE) moved.add(node);
      else if (patch.type === PatchType.INSERT && node?.nodeName === 'LI') fresh.add(node);
    },
  });
  const tApply = performance.now();
  p.stage.getBoundingClientRect();
  const ms = performance.now() - t0;
  const records = p.observer.takeRecords();
  p.prev = next;
  const types = {};
  for (const x of patches) types[x.type] = (types[x.type] || 0) + 1;
  const res = {
    t0, ms, diffMs: tDiff - t0, patchMs: tApply - tDiff,
    moves: types.MOVE || 0, movedKeys: new Set(patches.filter((x) => x.type === PatchType.MOVE).map((x) => x.key)),
    patches: patches.length, types, dom: records.length, ok: 0, rows: nextItems.length, list: patches,
  };
  // 표시는 화면 반영 시간을 잰 뒤에 (측정에 섞이지 않게)
  res.finish = () => {
    items = nextItems;
    for (const li of fresh) {
      p.born.set(li, nextItems[[...p.root.children].indexOf(li)].id);
      $('input', li).value = '';
    }
    res.ok = mark(p, fresh);
    if (moved.size <= 400) moved.forEach(flash); // 너무 많으면 번쩍임은 생략 (숫자로 충분)
    render(p, res);
  };
  return res;
}

/** 다음 화면이 그려질 때까지 기다린다 → true. 탭이 가려져 그리지 않으면 0.3초 뒤 false */
const nextPaint = () => new Promise((r) => {
  const done = setTimeout(() => r(false), 300);
  requestAnimationFrame(() => setTimeout(() => { clearTimeout(done); r(true); }, 0));
});

// ---------------------------------------------------------------- 표시
function render(p, r) {
  $('.moves b', p.el).textContent = fmt(r.moves);
  $('.stats', p.el).innerHTML = [
    ['', fmt(r.dom), '실제 DOM 조작'],
    ['', (r.diffMs + r.patchMs).toFixed(1), 'diff + patch (ms)'],
    ['', r.frame != null ? r.frame.toFixed(1) : '—', r.painted === false ? '레이아웃까지 (ms)' : '화면 반영까지 (ms)'],
    [r.ok === r.rows ? 'good' : 'bad', `${fmt(r.ok)}/${fmt(r.rows)}`, '입력칸 제자리'],
  ].map(([c, v, l]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  const t = Object.entries(r.types);
  $('.types', p.el).innerHTML = t.length ? t.map(([k, v]) => `<span class="chip ${k}">${k} ${fmt(v)}</span>`).join('') : '<span class="chip none">패치 없음</span>';
  const shown = r.list.slice(0, 200).map(describe);
  if (r.list.length > 200) shown.push(`… 외 ${fmt(r.list.length - 200)}개`);
  $('.log ol', p.el).innerHTML = shown.map((s) => `<li>${s}</li>`).join('');
}

function describe(p) {
  const at = `[${p.path.join(',')}]`;
  switch (p.type) {
    case 'MOVE': return `MOVE ${at} key=${p.key} : ${p.from} → ${p.to}`;
    case 'INSERT': return `INSERT ${at} @${p.index}`;
    case 'REMOVE': return `REMOVE ${at} @${p.index}`;
    case 'TEXT': return `TEXT ${at} "${String(p.text).slice(0, 20)}"`;
    case 'PROPS': return `PROPS ${at} ${p.changes.map((c) => c.name).join(',')}`;
    default: return `${p.type} ${at}`;
  }
}

/** 히어로 숫자 — 세어 올라가는 애니메이션 */
function countTo(el, to, suffix = '') {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  const token = (el._anim = (el._anim || 0) + 1); // 앞서 돌던 애니메이션은 멈춘다
  const start = performance.now(), dur = 600;
  const step = (now) => {
    if (el._anim !== token) return;
    const k = Math.min(1, (now - start) / dur);
    const v = from + (to - from) * (1 - (1 - k) ** 3);
    el.textContent = fmt(Math.round(v)) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = fmt(to) + suffix; // 화면이 그려지지 않는 상황에서도 최종값은 보이게
  requestAnimationFrame(step);
}

function setText(el, text) {
  el._anim = (el._anim || 0) + 1;
  el.dataset.v = 0;
  el.textContent = text;
}

function setHero(naive, lis, minMoves, text) {
  countTo($('[data-k=naive]'), naive);
  countTo($('[data-k=lis]'), lis);
  const ratio = $('[data-k=ratio]');
  if (lis === 0 && naive === 0) setText(ratio, '같음');
  else if (lis === 0) setText(ratio, `${fmt(naive)} → 0`);
  else if (naive / lis >= 1.995) countTo(ratio, Math.round(naive / lis), '×');
  else setText(ratio, `${(naive / lis).toFixed(2)}×`);
  $('[data-k=min]').textContent = lis === minMoves ? '= 최소' : `최소 ${fmt(minMoves)}`;
  $('#scenario').textContent = text;
}

/** 새 순서대로 각 줄의 옛 위치를 칸으로 보여 준다. 반환: 이론상 최소 이동 횟수 */
function renderSeq(before, after, a, b) {
  const oldIndex = new Map(before.map((it, i) => [it.id, i]));
  const kept = after.filter((it) => oldIndex.has(it.id));
  const LIMIT = 60;
  const cells = (cls) => kept.slice(0, LIMIT).map((it) => `<i class="${cls(it)}">${oldIndex.get(it.id)}</i>`).join('') + (kept.length > LIMIT ? `<i>… +${fmt(kept.length - LIMIT)}</i>` : '');
  $('#seqLis').innerHTML = cells((it) => (a.movedKeys.has(it.id) ? 'move' : 'stay'));
  $('#seqNaive').innerHTML = cells((it) => (b.movedKeys.has(it.id) ? 'nmove' : ''));
  const seq = kept.map((it) => oldIndex.get(it.id));
  const lisLen = longestIncreasingSubsequence(seq).length;
  $('#formula').innerHTML = `남은 줄 ${fmt(kept.length)} − LIS 길이 ${fmt(lisLen)} = <b style="color:var(--lis)">최소 ${fmt(kept.length - lisLen)}번</b> · 우리 diff ${fmt(a.moves)}번 · 앞에서부터 ${fmt(b.moves)}번`;
  return kept.length - lisLen;
}

// ---------------------------------------------------------------- 조작
const OPS = {
  lastToFirst: ['맨 아래 줄을 맨 위로 (채팅방 목록에 새 메시지가 온 방을 올리는 경우)', (a) => [a.at(-1), ...a.slice(0, -1)]],
  tailToFront: ['아래 10% 를 맨 위로 (최근 활동한 몇 개를 위로 올리는 경우)', (a) => { const k = Math.max(1, Math.round(a.length / 10)); return [...a.slice(-k), ...a.slice(0, -k)]; }],
  firstToLast: ['맨 위 줄을 맨 아래로', (a) => [...a.slice(1), a[0]]],
  swap: ['두 줄 바꾸기', (a) => { const b = a.slice(); const i = b.length >= 4 ? 1 : 0, j = b.length >= 4 ? b.length - 2 : b.length - 1; [b[i], b[j]] = [b[j], b[i]]; return b; }],
  reverse: ['뒤집기', (a) => a.slice().reverse()],
  shuffle: ['섞기 (거의 모든 줄이 움직임 — 두 방식의 차이가 가장 작은 경우)', (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }],
  prepend: ['맨 위에 새 줄 추가', (a) => { const id = nextId++; return [{ id, label: `항목 ${id}` }, ...a]; }],
};

let busy = false, flip = false;
async function run(op, { quiet = false } = {}) {
  if (busy) return null;
  busy = true;
  document.body.classList.add('busy');
  try {
    const [name, fn] = OPS[op];
    const before = items;
    const nextItems = fn(before);
    // 두 패널을 서로 다른 프레임에서 바꿔 화면 반영 시간을 따로 잰다. 먼저 하는 쪽이 유리하지 않게 순서를 번갈아 바꾼다.
    flip = !flip;
    const res = [];
    await nextPaint();
    for (const k of flip ? [0, 1] : [1, 0]) {
      const r = update(panes[k], nextItems);
      const painted = await nextPaint();
      r.frame = painted ? performance.now() - r.t0 : r.ms;
      r.painted = painted;
      res[k] = r;
      await nextPaint();
    }
    res.forEach((r) => r.finish());
    const [a, b] = res;
    const minMoves = renderSeq(before, nextItems, a, b);
    if (!quiet) setHero(b.moves, a.moves, minMoves, `${fmt(nextItems.length)}줄 · ${name} · 실측`);
    window.__move = { op, a, b, minMoves };
    return window.__move;
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

function reset() {
  const n = Math.max(2, Math.min(2000, Number(nInput.value) || 12));
  nInput.value = n;
  nextId = n;
  items = Array.from({ length: n }, (_, i) => ({ id: i, label: `항목 ${i}` }));
  panes.forEach(mountPane);
  panes.forEach((p) => render(p, { moves: 0, dom: 0, diffMs: 0, patchMs: 0, frame: null, types: {}, ok: n, rows: n, list: [] }));
}

// ---------------------------------------------------------------- 규모별 (순서만 계산)
function scaleData() {
  const sizes = [10, 100, 1000, 10000, 100000];
  const minOf = (o, nw) => { const idx = new Map(o.map((k, i) => [k, i])); const seq = nw.map((k) => idx.get(k)); return nw.length - longestIncreasingSubsequence(seq).length; };
  return sizes.map((n) => {
    const keys = Array.from({ length: n }, (_, i) => i);
    const last = [n - 1, ...keys.slice(0, -1)];
    const k = Math.max(1, Math.round(n / 10));
    const tail = [...keys.slice(-k), ...keys.slice(0, -k)];
    return { n, lastNaive: naiveMoves(keys, last), lastLis: minOf(keys, last), tailNaive: naiveMoves(keys, tail), tailLis: minOf(keys, tail) };
  });
}

function renderScale() {
  const data = scaleData();
  const W = 520, H = 260, L = 60, R = 40, T = 22, B = 34;
  const pw = W - L - R, ph = H - T - B;
  const x = (i) => L + (i / (data.length - 1)) * pw;
  const y = (v) => T + ph - (Math.log10(Math.max(v, 1)) / 5) * ph; // 1 ~ 100,000
  let g = '';
  for (let e = 0; e <= 5; e++) g += `<line x1="${L}" x2="${W - R}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" stroke="var(--border)"/><text x="${L - 8}" y="${y(10 ** e) + 4}" text-anchor="end">${fmt(10 ** e)}</text>`;
  data.forEach((d, i) => { g += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${fmt(d.n)}줄</text>`; });
  const line = (key, colorVar, op) => `<polyline fill="none" stroke="var(${colorVar})" stroke-opacity="${op}" stroke-width="3" points="${data.map((d, i) => `${x(i)},${y(d[key])}`).join(' ')}"/>` + data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d[key])}" r="4" fill="var(${colorVar})" fill-opacity="${op}"><title>${fmt(d.n)}줄 · ${fmt(d[key])}번</title></circle>`).join('');
  g += line('tailNaive', '--naive', 0.45) + line('tailLis', '--lis', 0.45) + line('lastNaive', '--naive', 1) + line('lastLis', '--lis', 1);
  const last = data.at(-1);
  g += `<text x="${x(data.length - 1) - 8}" y="${y(last.lastNaive) - 10}" text-anchor="end" style="fill:var(--naive);font-weight:700;font-size:12px">${fmt(last.lastNaive)}번</text>`;
  g += `<text x="${x(data.length - 1) - 8}" y="${y(last.lastLis) - 10}" text-anchor="end" style="fill:var(--lis);font-weight:700;font-size:12px">${fmt(last.lastLis)}번</text>`;
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="목록 크기별 DOM 이동 횟수">${g}</svg>`;
  $('#scaleTable').innerHTML = `<thead><tr><th>줄 수</th><th>맨 아래 → 맨 위<br>앞에서부터 / LIS</th><th>아래 10% → 위<br>앞에서부터 / LIS</th></tr></thead><tbody>${data.map((d) => `<tr><td>${fmt(d.n)}</td><td><span class="lose">${fmt(d.lastNaive)}</span> / <span class="win">${fmt(d.lastLis)}</span></td><td><span class="lose">${fmt(d.tailNaive)}</span> / <span class="win">${fmt(d.tailLis)}</span></td></tr>`).join('')}</tbody>`;
}

// ---------------------------------------------------------------- 규모별 (실제 DOM)
const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
async function measureScale() {
  if (busy) return;
  const sizes = [250, 500, 1000, 2000];
  const reps = 3;
  const keepN = nInput.value;
  const rows = [];
  for (const n of sizes) {
    nInput.value = n;
    reset();
    const A = { dom: 0, js: [], frame: [] }, B = { dom: 0, js: [], frame: [] };
    for (let r = 0; r < reps; r++) {
      $('#scaleStatus').textContent = `${fmt(n)}줄 · ${r + 1}/${reps}`;
      const m = await run('lastToFirst', { quiet: true });
      for (const [S, x] of [[A, m.a], [B, m.b]]) { S.dom = x.dom; S.js.push(x.diffMs + x.patchMs); S.frame.push(x.frame); }
    }
    rows.push({ n, A, B });
    renderDomTable(rows);
  }
  $('#scaleStatus').textContent = '완료';
  nInput.value = keepN;
  reset();
  window.__scale = rows;
}

function renderDomTable(rows) {
  const c = (a, b, f = (v) => v.toFixed(1)) => `<td class="${a <= b ? 'win' : ''}">${f(a)}</td><td class="${b < a ? 'win' : 'lose'}">${f(b)}</td>`;
  $('#domTable').innerHTML = `<thead><tr><th>줄 수</th><th>DOM 조작<br>LIS</th><th><br>앞에서부터</th><th>화면 반영 ms<br>LIS</th><th><br>앞에서부터</th><th>JS ms<br>LIS</th><th><br>앞에서부터</th></tr></thead><tbody>${rows.map(({ n, A, B }) =>
    `<tr><td>${fmt(n)}</td>${c(A.dom, B.dom, fmt)}${c(med(A.frame), med(B.frame))}${c(med(A.js), med(B.js))}</tr>`).join('')}</tbody>`;
}

// ---------------------------------------------------------------- 시작
document.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => run(btn.dataset.op)));
$('#reset').addEventListener('click', reset);
nInput.addEventListener('change', reset);
weightSel.addEventListener('change', reset);
$('#scale').addEventListener('click', measureScale);
reset();
renderScale();
// 히어로 첫 화면: 1,000줄 맨 아래 → 맨 위 (순서만 계산한 값)
{
  const keys = Array.from({ length: 1000 }, (_, i) => i);
  setHero(naiveMoves(keys, [999, ...keys.slice(0, -1)]), 1, 1, '1,000줄 목록에서 맨 아래 줄을 맨 위로 (채팅방 목록에 새 메시지가 온 방을 올리는 경우) · 아래 버튼을 누르면 실측값으로 바뀝니다.');
}
