/**
 * MOVE 있을 때와 없을 때 — 같은 목록 조작을 두 방식으로 동시에 적용해 비교한다.
 *  A: key 있음 → diff 가 같은 줄을 찾아 DOM 노드를 옮긴다 (MOVE, LIS 로 최소 횟수)
 *  B: key 없음 → i 번째끼리 짝지어 글자·속성만 바꿔 쓴다 (MOVE 없음)
 * 실제 DOM 조작 횟수는 MutationObserver 로 센다.
 * 입력칸 글자가 맞는지는 "그 DOM 노드가 처음 어느 줄로 태어났나" 로 판단한다 (사용자가 무엇을 적든 상관없음).
 */
import { h, createElement, diff, applyPatches, devConfig, PatchType } from '../src/lib/index.js';

devConfig.warnings = false; // B 는 일부러 key 없는 목록이다

const $ = (s, el = document) => el.querySelector(s);
const nInput = $('#n');

let items = [];
let nextId = 0;
let last = null; // 방금 한 조작의 결과 (비교 표)

// ---------------------------------------------------------------- 목록 VNode
const color = (id) => `hsl(${(id * 47) % 360} 65% 55%)`;
const row = (it, keyed) =>
  h('li', keyed ? { key: it.id } : null,
    h('span', { class: 'sw', style: { background: color(it.id) } }),
    h('span', { class: 'id' }, `#${it.id}`),
    h('span', { class: 'label' }, it.label),
    h('input', { placeholder: '메모' }),
    h('span', { class: 'tag' }));
const listV = (list, keyed) => h('ul', null, list.map((it) => row(it, keyed)));

// ---------------------------------------------------------------- 두 패널
function makePane(el, keyed) {
  const pane = { el, keyed, stage: $('.stage', el), prev: null, root: null, born: new WeakMap(), observer: null };
  pane.observer = new MutationObserver(() => {});
  return pane;
}
const panes = [makePane($('#paneA'), true), makePane($('#paneB'), false)];

function mountPane(p) {
  p.observer.disconnect();
  p.prev = listV(items, p.keyed);
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

/** 각 줄의 상태 표시: 입력칸이 다른 줄 것이면 빨간색, 새로 만든 줄이면 '새 노드' */
function mark(p, fresh) {
  let ok = 0;
  [...p.root.children].forEach((li, i) => {
    const id = items[i].id;
    const born = p.born.get(li);
    const wrong = born !== id;
    li.classList.toggle('wrong', wrong);
    li.classList.toggle('fresh', fresh.has(li));
    $('.tag', li).textContent = wrong ? `#${born} 의 것` : fresh.has(li) ? '새 노드' : '';
    if (!wrong) ok++;
  });
  return ok;
}

function flash(li, cls) {
  if (!li) return;
  li.classList.remove('fl-move', 'fl-text');
  void li.offsetWidth; // 애니메이션 다시 시작
  li.classList.add(cls);
}

function update(p, nextItems) {
  p.observer.takeRecords(); // 지난번 표시용 변경(클래스·태그 글자)은 버린다
  const next = listV(nextItems, p.keyed);
  const touched = new Map(); // li → 'fl-move' | 'fl-text'
  const fresh = new Set();
  let patches;
  document.body.offsetHeight; // 앞 패널의 표시 변경(클래스·애니메이션)이 이 패널 시간에 섞이지 않게 먼저 계산해 둔다
  const t0 = performance.now();
  patches = diff(p.prev, next);
  const tDiff = performance.now();
  p.root = applyPatches(p.root, patches, {
    onApply(patch, node) {
      if (patch.type === PatchType.MOVE) touched.set(node, 'fl-move');
      else if (patch.type === PatchType.INSERT && node?.nodeName === 'LI') fresh.add(node);
      else if (patch.type === PatchType.TEXT || patch.type === PatchType.PROPS) {
        const li = (node?.nodeType === 3 ? node.parentElement : node)?.closest('li');
        if (li && !touched.has(li)) touched.set(li, 'fl-text');
      }
    },
  });
  const tApply = performance.now();
  p.stage.getBoundingClientRect(); // 레이아웃까지 포함해서 잰다
  const ms = performance.now() - t0;
  const parts = { diff: tDiff - t0, patch: tApply - tDiff, layout: t0 + ms - tApply };
  const records = p.observer.takeRecords();
  p.prev = next;

  items = nextItems; // mark 가 새 순서를 쓰도록 (두 패널 모두 같은 nextItems)
  for (const li of fresh) {
    p.born.set(li, nextItems[[...p.root.children].indexOf(li)].id);
    $('input', li).value = '';
  }
  const ok = mark(p, fresh);
  touched.forEach((cls, li) => flash(li, cls));

  const types = {};
  for (const x of patches) types[x.type] = (types[x.type] || 0) + 1;
  const res = { ms, parts, patches: patches.length, types, dom: records.length, ok, rows: nextItems.length, list: patches };
  render(p, res);
  return res;
}

// ---------------------------------------------------------------- 표시
function render(p, r) {
  const ratio = r.rows ? r.ok / r.rows : 1;
  $('.stats', p.el).innerHTML = [
    ['', (r.parts ? r.parts.diff + r.parts.patch : 0).toFixed(1), 'diff + patch (ms)'],
    ['', r.patches, '패치 수'],
    ['', r.dom, '실제 DOM 조작'],
    [ratio === 1 ? 'good' : 'bad', `${r.ok}/${r.rows}`, '입력칸 제자리'],
  ].map(([c, v, l]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  const t = Object.entries(r.types);
  $('.types', p.el).innerHTML = t.length ? t.map(([k, v]) => `<span class="chip ${k}">${k} ${v}</span>`).join('') : '<span class="chip none">패치 없음</span>';
  const shown = r.list.slice(0, 200).map(describe);
  if (r.list.length > 200) shown.push(`… 외 ${r.list.length - 200}개`);
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

/** React 식 '앞에서부터' 방식으로 같은 key 매칭을 처리하면 몇 번 옮기나 */
function lastPlacedMoves(oldList, newList) {
  const oldIndex = new Map(oldList.map((it, i) => [it.id, i]));
  let lastIdx = -1, moves = 0;
  for (const it of newList) {
    const i = oldIndex.get(it.id);
    if (i === undefined) continue; // 새로 들어온 줄은 이동이 아니라 삽입
    if (i < lastIdx) moves++;
    else lastIdx = i;
  }
  return moves;
}

function renderCompare(name, a, b, lp) {
  const win = (x, y, lowGood = true) => (x === y ? ['', ''] : (lowGood ? x < y : x > y) ? ['win', ''] : ['', 'win']);
  const cell = (v, c = '') => `<td class="${c}">${v}</td>`;
  const rows = [];
  const mv = a.types.MOVE || 0;
  const [m1, m2] = win(mv, lp);
  rows.push(`<tr><td>노드 옮기기 (MOVE)</td>${cell(mv, m1)}${cell(lp, m2)}${cell(0)}</tr>`);
  let [x, y] = win(a.patches, b.patches);
  rows.push(`<tr><td>패치 수</td>${cell(a.patches, x)}${cell('—')}${cell(b.patches, y)}</tr>`);
  [x, y] = win(a.dom, b.dom);
  rows.push(`<tr><td>실제 DOM 조작 (MutationObserver)</td>${cell(a.dom, x)}${cell('—')}${cell(b.dom, y)}</tr>`);
  for (const [k, label] of [['diff', 'diff 계산 (ms)'], ['patch', 'patch 적용 = DOM 조작 (ms)'], ['layout', '브라우저 레이아웃 (ms, 참고)']]) {
    [x, y] = win(+a.parts[k].toFixed(1), +b.parts[k].toFixed(1));
    rows.push(`<tr><td>${label}</td>${cell(a.parts[k].toFixed(1), x)}${cell('—')}${cell(b.parts[k].toFixed(1), y)}</tr>`);
  }
  [x, y] = win(a.ok, b.ok, false);
  rows.push(`<tr><td>입력칸 글자가 제자리인 줄</td>${cell(`${a.ok}/${a.rows}`, x)}${cell('같음 (key 매칭)')}${cell(`${b.ok}/${b.rows}`, y)}</tr>`);
  $('#cmp').innerHTML = `<thead><tr><th>${name} · ${a.rows}줄</th><th>MOVE 있음 (LIS)</th><th>key + 앞에서부터 방식</th><th>MOVE 없음 (key 없음)</th></tr></thead><tbody>${rows.join('')}</tbody>`;
}

// ---------------------------------------------------------------- 조작
const OPS = {
  lastToFirst: ['맨 뒤 → 맨 앞', (a) => [a.at(-1), ...a.slice(0, -1)]],
  firstToLast: ['맨 앞 → 맨 뒤', (a) => [...a.slice(1), a[0]]],
  swap: ['두 줄 바꾸기', (a) => {
    const b = a.slice();
    const i = b.length >= 4 ? 1 : 0, j = b.length >= 4 ? b.length - 2 : b.length - 1;
    [b[i], b[j]] = [b[j], b[i]];
    return b;
  }],
  reverse: ['뒤집기', (a) => a.slice().reverse()],
  shuffle: ['섞기', (a) => {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  }],
  prepend: ['맨 앞에 추가', (a) => { const id = nextId++; return [{ id, label: `항목 ${id}` }, ...a]; }],
  removeMid: ['가운데 삭제', (a) => (a.length ? a.filter((_, i) => i !== a.length >> 1) : a)],
};

function run(op) {
  const [name, fn] = OPS[op];
  const before = items;
  const nextItems = fn(before);
  const [a, b] = panes.map((p) => update(p, nextItems));
  const lp = lastPlacedMoves(before, nextItems);
  last = { op: name, a, b, lp };
  window.__move = last;
  renderCompare(name, a, b, lp);
}

function reset() {
  const n = Math.max(2, Math.min(2000, Number(nInput.value) || 8));
  nInput.value = n;
  nextId = n;
  items = Array.from({ length: n }, (_, i) => ({ id: i, label: `항목 ${i}` }));
  panes.forEach(mountPane);
  const empty = { ms: 0, parts: { diff: 0, patch: 0, layout: 0 }, patches: 0, types: {}, dom: 0, ok: n, rows: n, list: [] };
  panes.forEach((p) => render(p, empty));
  $('#cmp').innerHTML = '<tbody><tr><td>버튼을 눌러 보세요. 입력칸에 글자를 적어 두면 차이가 더 잘 보입니다.</td></tr></tbody>';
}

document.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => run(btn.dataset.op)));
$('#reset').addEventListener('click', reset);
nInput.addEventListener('change', reset);
reset();
