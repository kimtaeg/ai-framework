/**
 * miniReact 렌더링 벤치마크 (실제 브라우저에서 실행)
 *  실험 1  항목 수와 업데이트 비용: 한 줄만 바꿀 때 patch vs innerHTML 전체 다시 그리기
 *  실험 2  목록 조작과 key: key 있음 vs 없음 — 패치 수, 기존 DOM 재사용, 입력값 보존
 *  실험 3  섞기 비용이 항목 수에 따라 어떻게 늘어나나 (key 있음)
 *  실험 4  setState 연타와 batching
 *  실험 5  mount / unmount 반복 — effect 정리 누수
 *  실험 6  무작위 트리 퍼즈 — diff + patch 결과가 새로 그린 결과와 같은가
 * 결과는 화면에 그리고 window.__bench 에도 남긴다.
 */
import { h, createElement, diff, applyPatches, devConfig, FunctionComponent, useState, useEffect } from '../src/lib/index.js';
import { lineChart, barChart, esc } from './charts.js';

devConfig.warnings = false; // key 없는 목록을 일부러 만들므로 경고를 끈다

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const nowMs = () => performance.now();
// 화면이 가려져도 느려지지 않게 setTimeout/requestAnimationFrame 대신 MessageChannel 로 한 번 쉰다
const chan = new MessageChannel();
const waiters = [];
chan.port1.onmessage = () => waiters.shift()?.();
const tick = () => new Promise((r) => { waiters.push(r); chan.port2.postMessage(0); });
const frame = tick;
const status = (t) => { $('#status').textContent = t; window.__bench.status = t; };

window.__bench = { status: 'idle', results: {}, done: false };

// ---------------------------------------------------------------- 통계 · 난수
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => { const s = sorted(a); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = sorted(a); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r2 = (x) => Math.round(x * 100) / 100;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- 목록 만들기
const makeItems = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i, label: `항목 ${from + i}` }));
const row = (it, keyed, withInput) => {
  const kids = [h('span', { class: 'id' }, String(it.id)), h('span', null, it.label)];
  if (withInput) kids.push(h('input', { placeholder: '메모' }));
  return h('li', keyed ? { key: it.id } : null, ...kids);
};
const listV = (items, keyed, withInput = false) => h('ul', null, items.map((it) => row(it, keyed, withInput)));
const listHTML = (items) => '<ul>' + items.map((it) => `<li><span class="id">${it.id}</span><span>${esc(it.label)}</span></li>`).join('') + '</ul>';
const forceLayout = (el) => el.getBoundingClientRect().height + el.offsetHeight;

/** DOM 노드가 몇 개 새로 만들어졌는지 센다 (patch 가 쓰는 document.createElement/createTextNode) */
function countCreates(fn) {
  const ce = document.createElement, ct = document.createTextNode, cn = document.createElementNS;
  let n = 0;
  document.createElement = function (...a) { n++; return ce.apply(this, a); };
  document.createTextNode = function (...a) { n++; return ct.apply(this, a); };
  document.createElementNS = function (...a) { n++; return cn.apply(this, a); };
  try { fn(); } finally { document.createElement = ce; document.createTextNode = ct; document.createElementNS = cn; }
  return n;
}

// ================================================================ 실험 1
async function exp1() {
  const NS = [100, 1000, 2000, 3000, 5000, 10000, 25000, 50000];
  const out = [];
  for (const n of NS) {
    const reps = n <= 3000 ? 30 : n <= 10000 ? 15 : 8;
    const warm = 3;
    status(`실험 1 · 항목 ${n.toLocaleString()}개`);
    // --- patch 방식
    let items = makeItems(n);
    let prev = listV(items, true);
    let root = createElement(prev);
    stage.replaceChildren(root);
    forceLayout(stage);
    const P = { build: [], diff: [], patch: [], layout: [], total: [], patches: [] };
    for (let r = 0; r < warm + reps; r++) {
      const k = (r * 7919) % n;
      items = items.slice();
      items[k] = { ...items[k], label: `바뀐 항목 ${k} #${r}` };
      const t0 = nowMs();
      const next = listV(items, true);
      const t1 = nowMs();
      const patches = diff(prev, next);
      const t2 = nowMs();
      root = applyPatches(root, patches);
      const t3 = nowMs();
      forceLayout(stage);
      const t4 = nowMs();
      prev = next;
      if (r >= warm) {
        P.build.push(t1 - t0); P.diff.push(t2 - t1); P.patch.push(t3 - t2); P.layout.push(t4 - t3); P.total.push(t4 - t0); P.patches.push(patches.length);
      }
      await tick();
    }
    // --- innerHTML 방식 (같은 변경을 문자열로 전체 다시 그리기)
    items = makeItems(n);
    stage.innerHTML = listHTML(items);
    forceLayout(stage);
    const I = [];
    for (let r = 0; r < warm + reps; r++) {
      const k = (r * 7919) % n;
      items = items.slice();
      items[k] = { ...items[k], label: `바뀐 항목 ${k} #${r}` };
      const t0 = nowMs();
      stage.innerHTML = listHTML(items);
      forceLayout(stage);
      const t1 = nowMs();
      if (r >= warm) I.push(t1 - t0);
      await tick();
    }
    out.push({
      n, reps,
      build: r2(median(P.build)), diff: r2(median(P.diff)), patch: r2(median(P.patch)), layout: r2(median(P.layout)),
      total: r2(median(P.total)), totalP95: r2(pct(P.total, 95)), patches: median(P.patches),
      inner: r2(median(I)), innerP95: r2(pct(I, 95)),
    });
    stage.replaceChildren();
    await frame();
  }
  return out;
}

// ================================================================ 실험 2
const OPS = {
  '맨 뒤에 추가': (a) => [...a, { id: 1e6, label: '새 항목' }],
  '맨 앞에 추가': (a) => [{ id: 1e6, label: '새 항목' }, ...a],
  '가운데 삭제': (a) => a.filter((_, i) => i !== a.length >> 1),
  '두 줄 바꾸기': (a) => { const b = a.slice(); [b[1], b[b.length - 2]] = [b[b.length - 2], b[1]]; return b; },
  '뒤집기': (a) => a.slice().reverse(),
  '섞기': (a) => { const b = a.slice(); const R = rng(42); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; },
};

async function exp2() {
  const N = 1000, reps = 12, warm = 2;
  const out = [];
  for (const [name, op] of Object.entries(OPS)) {
    for (const keyed of [true, false]) {
      status(`실험 2 · ${name} · key ${keyed ? '있음' : '없음'}`);
      const base = makeItems(N);
      const nextItems = op(base);
      const times = [];
      let info = null;
      for (let r = 0; r < warm + reps; r++) {
        const prev = listV(base, keyed, true);
        const root = createElement(prev);
        stage.replaceChildren(root);
        // 각 줄의 입력칸에 그 줄의 id 를 적어 둔다 (사용자가 쓰던 글자)
        root.querySelectorAll('li').forEach((li) => { li.querySelector('input').value = li.firstChild.textContent; });
        const before = new Set(root.children);
        forceLayout(stage);
        const next = listV(nextItems, keyed, true);
        let patches;
        const t0 = nowMs();
        const created = countCreates(() => { patches = diff(prev, next); applyPatches(root, patches); });
        forceLayout(stage);
        const t1 = nowMs();
        if (r >= warm) times.push(t1 - t0);
        if (!info) {
          const lis = [...root.children];
          const reused = lis.filter((li) => before.has(li)).length;
          const kept = lis.filter((li) => li.querySelector('input').value === li.firstChild.textContent).length;
          const types = {};
          for (const p of patches) types[p.type] = (types[p.type] || 0) + 1;
          const correct = root.isEqualNode(createElement(next));
          info = { patches: patches.length, types, created, reused, kept, rows: lis.length, correct };
        }
        await tick();
      }
      out.push({ op: name, keyed, ms: r2(median(times)), p95: r2(pct(times, 95)), ...info });
    }
  }
  stage.replaceChildren();
  return out;
}

// ================================================================ 실험 3
async function exp3() {
  const NS = [1000, 2000, 5000, 10000, 20000];
  const out = [];
  for (const n of NS) {
    status(`실험 3 · 섞기 · 항목 ${n.toLocaleString()}개`);
    const reps = n <= 5000 ? 7 : 3;
    const base = makeItems(n);
    const nextItems = OPS['섞기'](base);
    const rev = base.slice().reverse();
    const D = [], P = [], RD = [];
    for (let r = 0; r < 1 + reps; r++) {
      const prev = listV(base, true);
      const root = createElement(prev);
      stage.replaceChildren(root);
      forceLayout(stage);
      const next = listV(nextItems, true);
      const t0 = nowMs();
      const patches = diff(prev, next);
      const t1 = nowMs();
      applyPatches(root, patches);
      forceLayout(stage);
      const t2 = nowMs();
      const t3 = nowMs();
      diff(prev, listV(rev, true));
      const t4 = nowMs();
      if (r >= 1) { D.push(t1 - t0); P.push(t2 - t1); RD.push(t4 - t3); }
      await tick();
    }
    out.push({ n, diff: r2(median(D)), patch: r2(median(P)), reverseDiff: r2(median(RD)) });
  }
  stage.replaceChildren();
  return out;
}

// ================================================================ 실험 4
async function exp4() {
  status('실험 4 · setState 연타');
  const host = document.createElement('div');
  stage.replaceChildren(host);
  let api;
  const App = () => {
    const [count, setCount] = useState(0);
    api = { count, setCount };
    return h('p', null, `count = ${count}`);
  };
  const comp = new FunctionComponent(App).mount(host);
  const micro = () => Promise.resolve();
  const settle = async () => { await micro(); await micro(); await frame(); };
  const out = [];

  let r0 = comp.renderCount, t0 = nowMs();
  for (let i = 0; i < 1000; i++) api.setCount((c) => c + 1);
  await settle();
  out.push({ case: '한 이벤트 안에서 1,000번 (함수형 업데이트)', renders: comp.renderCount - r0, value: api.count, expected: 1000, ms: r2(nowMs() - t0) });

  r0 = comp.renderCount; const start = api.count; t0 = nowMs();
  const { count } = api;
  for (let i = 0; i < 1000; i++) api.setCount(count + 1);
  await settle();
  out.push({ case: '한 이벤트 안에서 1,000번 (count + 1, 옛 값 사용)', renders: comp.renderCount - r0, value: api.count - start, expected: 1000, ms: r2(nowMs() - t0) });

  r0 = comp.renderCount; const start2 = api.count; t0 = nowMs();
  for (let i = 0; i < 1000; i++) { api.setCount((c) => c + 1); await micro(); await micro(); }
  await settle();
  out.push({ case: '1,000번을 따로따로 (클릭 1,000번)', renders: comp.renderCount - r0, value: api.count - start2, expected: 1000, ms: r2(nowMs() - t0) });

  comp.unmount();
  stage.replaceChildren();
  return out;
}

// ================================================================ 실험 5
async function exp5() {
  const CYCLES = 3000;
  status(`실험 5 · mount/unmount ${CYCLES.toLocaleString()}번`);
  const live = { listeners: 0, timers: 0, peakListeners: 0 };
  const realAdd = window.addEventListener, realRemove = window.removeEventListener;
  const App = () => {
    const [n] = useState(0);
    useEffect(() => {
      const onResize = () => n;
      window.addEventListener('resize', onResize);
      live.listeners++; live.peakListeners = Math.max(live.peakListeners, live.listeners);
      const id = setInterval(() => {}, 1e6);
      live.timers++;
      return () => { window.removeEventListener('resize', onResize); live.listeners--; clearInterval(id); live.timers--; };
    }, []);
    return h('div', null, h('span', null, '타이머와 이벤트를 쓰는 컴포넌트'));
  };
  const heap = () => performance.memory?.usedJSHeapSize ?? null;
  const heap0 = heap();
  const t0 = nowMs();
  let firstHalf = 0;
  for (let i = 0; i < CYCLES; i++) {
    const host = document.createElement('div');
    stage.replaceChildren(host);
    const c = new FunctionComponent(App).mount(host);
    c.flushPassiveEffects(); // useEffect 를 바로 실행 (원래는 화면을 그린 뒤)
    c.unmount();
    if (i === CYCLES / 2) firstHalf = nowMs() - t0;
    if (i % 300 === 0) await tick();
  }
  const total = nowMs() - t0;
  const heap1 = heap();
  stage.replaceChildren();
  window.addEventListener = realAdd; window.removeEventListener = realRemove;
  return {
    cycles: CYCLES, leftListeners: live.listeners, leftTimers: live.timers, peakListeners: live.peakListeners,
    msPerCycle: r2(total / CYCLES), firstHalfMs: r2(firstHalf), secondHalfMs: r2(total - firstHalf),
    heapDeltaKB: heap0 != null && heap1 != null ? Math.round((heap1 - heap0) / 1024) : null,
  };
}

// ================================================================ 실험 6
function randTree(R, depth = 0) {
  const tags = ['div', 'span', 'p', 'ul', 'li', 'b'];
  const t = tags[Math.floor(R() * tags.length)];
  const props = {};
  if (R() < 0.5) props.class = `c${Math.floor(R() * 4)}`;
  if (R() < 0.3) props.title = `t${Math.floor(R() * 4)}`;
  const kids = [];
  const n = depth > 3 ? 0 : Math.floor(R() * 5);
  const keyed = R() < 0.5;
  const used = new Set();
  for (let i = 0; i < n; i++) {
    if (R() < 0.3) kids.push(`글자${Math.floor(R() * 5)}`);
    else {
      const c = randTree(R, depth + 1);
      if (keyed) { let k; do k = Math.floor(R() * 20); while (used.has(k)); used.add(k); c.props.key = k; }
      kids.push(c);
    }
  }
  return { t, props, kids };
}
function mutate(R, node, depth = 0) {
  const c = structuredClone(node);
  const r = R();
  if (r < 0.15) c.t = ['div', 'span', 'p'][Math.floor(R() * 3)];
  else if (r < 0.3) { if (R() < 0.5) delete c.props.class; else c.props.class = `c${Math.floor(R() * 4)}`; }
  if (R() < 0.4 && c.kids.length > 1) { const i = Math.floor(R() * c.kids.length), j = Math.floor(R() * c.kids.length); [c.kids[i], c.kids[j]] = [c.kids[j], c.kids[i]]; }
  if (R() < 0.2 && c.kids.length) c.kids.splice(Math.floor(R() * c.kids.length), 1);
  if (R() < 0.2 && depth < 3) { const n = randTree(R, depth + 1); n.props.key = 100 + Math.floor(R() * 1000); c.kids.splice(Math.floor(R() * (c.kids.length + 1)), 0, n); }
  c.kids = c.kids.map((k) => (typeof k === 'string' ? (R() < 0.2 ? `${k}!` : k) : R() < 0.5 ? mutate(R, k, depth + 1) : k));
  // 형제 key 중복 제거
  const seen = new Set();
  for (const k of c.kids) if (typeof k !== 'string' && k.props.key != null) { if (seen.has(k.props.key)) delete k.props.key; else seen.add(k.props.key); }
  return c;
}
const toV = (n) => (typeof n === 'string' ? n : h(n.t, { ...n.props }, ...n.kids.map(toV)));

async function exp6() {
  const CASES = 2000;
  const R = rng(7);
  let pass = 0, totalPatches = 0, strictDiff = 0;
  const fails = [];
  const t0 = nowMs();
  for (let i = 0; i < CASES; i++) {
    if (i % 200 === 0) { status(`실험 6 · 퍼즈 ${i.toLocaleString()} / ${CASES.toLocaleString()}`); await tick(); }
    const a = randTree(R);
    let b = mutate(R, a);
    if (R() < 0.5) b = mutate(R, b);
    const va = h('div', null, toV(a)), vb = h('div', null, toV(b));
    const root = createElement(va);
    const patches = diff(va, vb);
    totalPatches += patches.length;
    const out = applyPatches(root, patches);
    // 속성 순서는 DOM 에서 의미가 없으므로 문자열(outerHTML)이 아니라 isEqualNode 로 비교한다
    const fresh = createElement(vb);
    const got = out.outerHTML, want = fresh.outerHTML;
    if (got !== want) strictDiff++;
    if (out.isEqualNode(fresh)) pass++;
    else {
      if (fails.length < 3) fails.push(i);
      (window.__bench.fuzzFails ??= []).push({ i, a, b, got, want, patches: JSON.parse(JSON.stringify(patches, (k, v) => (k === 'node' || k === 'oldNode' ? (v ? `<${v.type}>` : v) : v))) });
    }
  }
  return { cases: CASES, pass, fails, strictDiff, avgPatches: r2(totalPatches / CASES), ms: Math.round(nowMs() - t0) };
}

// ================================================================ 화면
const fmt = (x) => (x == null ? '-' : typeof x === 'number' ? x.toLocaleString(undefined, { maximumFractionDigits: 2 }) : esc(x));
const table = (head, rows) => `<div class="table-wrap"><table class="t"><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const section = (title, sub, finding, body) => `<section class="card exp"><div class="card-head"><h2>${title}</h2><span class="sub">${sub}</span></div><div class="card-body"><p class="finding">${finding}</p>${body}</div></section>`;

function render(R) {
  const parts = [];
  if (R.exp1) {
    const d = R.exp1;
    const budget = d.filter((x) => x.total <= 16.7).at(-1);
    const big = d.at(-1);
    parts.push(section('실험 1 · 한 줄만 바꿀 때, 항목 수에 따른 비용', '중앙값 · 렌더 + diff + patch + 레이아웃',
      `항목 ${big.n.toLocaleString()}개에서 patch 는 <b>${fmt(big.total)}ms</b>, innerHTML 전체 다시 그리기는 <b>${fmt(big.inner)}ms</b> (${fmt(r2(big.inner / big.total))}배 느림). 한 프레임(16.7ms) 안에 끝나는 크기는 <b>${budget ? budget.n.toLocaleString() : '-'}개까지</b>${(() => { const over = d.find((x) => x.total > 16.7); return over ? ` (${over.n.toLocaleString()}개는 ${fmt(over.total)}ms)` : ''; })()}. 실제 DOM 을 고치는 patch 는 ${fmt(big.patch)}ms 뿐이고, 비용의 <b>${Math.round((big.diff / big.total) * 100)}%</b>는 한 줄만 바뀌어도 트리 전체를 훑는 diff 다.`,
      `<div class="legend"><span><i style="background:var(--s1)"></i>patch (미니 리액트)</span><span><i style="background:var(--s2)"></i>innerHTML 전체 다시 그리기</span></div>
       <div class="chart" id="c1">${lineChart({ xs: d.map((x) => x.n), series: [{ name: 'patch', color: 'var(--s1)', ys: d.map((x) => x.total) }, { name: 'innerHTML', color: 'var(--s2)', ys: d.map((x) => x.inner) }], logX: true, logY: true, xLabel: '항목 수', yLabel: 'ms (로그)', ref: { y: 16.7, label: '16.7ms = 1프레임' } })}</div>
       ${table(['항목 수', '반복', 'VDOM 만들기', 'diff', 'patch', '레이아웃', 'patch 합계', 'p95', 'innerHTML', 'p95', '패치 수'],
        d.map((x) => [x.n.toLocaleString(), x.reps, fmt(x.build), fmt(x.diff), fmt(x.patch), fmt(x.layout), `<b>${fmt(x.total)}</b>`, fmt(x.totalP95), `<b>${fmt(x.inner)}</b>`, fmt(x.innerP95), x.patches]))}`));
  }
  if (R.exp2) {
    const d = R.exp2;
    const ops = [...new Set(d.map((x) => x.op))];
    const get = (op, k) => d.find((x) => x.op === op && x.keyed === k);
    const rev = get('뒤집기', false), revK = get('뒤집기', true);
    parts.push(section('실험 2 · 목록 1,000줄 조작: key 있음 vs 없음', '각 줄의 입력칸에 글자를 써 둔 상태에서 조작',
      `뒤집기에서 key 가 없으면 패치 <b>${rev.patches.toLocaleString()}개</b>에 입력값이 제 줄에 남은 비율 <b class="bad">${Math.round((rev.kept / rev.reused) * 100)}%</b>, key 가 있으면 패치 <b>${revK.patches.toLocaleString()}개</b>에 <b class="ok">${Math.round((revK.kept / revK.reused) * 100)}%</b>. key 가 있으면 줄을 옮기느라 시간은 더 들지만(${fmt(revK.ms)}ms vs ${fmt(rev.ms)}ms), 사용자가 쓰던 값이 엉뚱한 줄로 가지 않는다.`,
      `<div class="legend"><span><i style="background:var(--s1)"></i>key 있음</span><span><i style="background:var(--s2)"></i>key 없음</span></div>
       <div class="chart" id="c2">${barChart({ cats: ops, series: [{ name: 'key 있음', color: 'var(--s1)', ys: ops.map((o) => get(o, true).patches) }, { name: 'key 없음', color: 'var(--s2)', ys: ops.map((o) => get(o, false).patches) }], logY: true, yLabel: 'DOM 조작(패치) 수, 로그' })}</div>
       ${table(['조작', 'key', '시간(ms)', '패치 수', '패치 종류', '새로 만든 노드', '기존 줄 재사용', '입력값 보존', '결과 정확'],
        d.map((x) => [x.op, x.keyed ? '있음' : '없음', fmt(x.ms), x.patches.toLocaleString(), esc(Object.entries(x.types).map(([k, v]) => `${k} ${v}`).join(', ') || '없음'), x.created.toLocaleString(), `${x.reused} / ${x.rows}`, `<span class="${x.kept === x.reused ? 'ok' : 'bad'}">${Math.round((x.kept / x.reused) * 100)}%</span>`, x.correct ? '<span class="ok">맞음</span>' : '<span class="bad">틀림</span>']))}`));
  }
  if (R.exp3) {
    const d = R.exp3;
    const a = d[0], b = d.at(-1);
    const size = b.n / a.n;
    const k = (y0, y1) => r2(Math.log(y1 / y0) / Math.log(size)); // 시간 ∝ n^k
    parts.push(section('실험 3 · 섞기의 비용이 항목 수에 따라 늘어나는 모양', 'key 있음 · 중앙값',
      `항목이 ${size}배가 되면 섞기 diff 는 <b>${r2(b.diff / a.diff)}배</b>(n<sup>${k(a.diff, b.diff)}</sup>), patch + 레이아웃은 <b>${r2(b.patch / a.patch)}배</b>(n<sup>${k(a.patch, b.patch)}</sup>)로 늘었다. 항목 수보다 빠르게 늘어서, ${b.n.toLocaleString()}개를 섞으면 <b>${fmt(r2((b.diff + b.patch) / 1000))}초</b>가 걸린다.`,
      `<div class="legend"><span><i style="background:var(--s1)"></i>diff</span><span><i style="background:var(--s2)"></i>patch + 레이아웃</span></div>
       <div class="chart" id="c3">${lineChart({ xs: d.map((x) => x.n), series: [{ name: 'diff', color: 'var(--s1)', ys: d.map((x) => x.diff) }, { name: 'patch', color: 'var(--s2)', ys: d.map((x) => x.patch) }], logX: true, logY: true, xLabel: '항목 수 (섞기)', yLabel: 'ms (로그)', ref: { y: 16.7, label: '16.7ms = 1프레임' } })}</div>
       ${table(['항목 수', '섞기 diff', '섞기 patch + 레이아웃', '뒤집기 diff'], d.map((x) => [x.n.toLocaleString(), fmt(x.diff), fmt(x.patch), fmt(x.reverseDiff)]))}`));
  }
  if (R.exp4) {
    const d = R.exp4;
    parts.push(section('실험 4 · setState 1,000번', '렌더 횟수와 최종 값',
      `한 이벤트 안의 1,000번은 <b>${d[0].renders}번</b>만 렌더했다(batching). 따로따로 1,000번이면 <b>${d[2].renders.toLocaleString()}번</b>. 옛 값으로 <code>count + 1</code> 을 쓰면 1,000이 아니라 <b>${d[1].value}</b>만 오른다.`,
      table(['경우', '렌더 횟수', '값 증가', '기대', '시간(ms)'], d.map((x) => [esc(x.case), x.renders.toLocaleString(), x.value.toLocaleString(), x.expected.toLocaleString(), fmt(x.ms)]))));
  }
  if (R.exp5) {
    const x = R.exp5;
    parts.push(section('실험 5 · mount / unmount 반복', '타이머 + window 이벤트를 쓰는 컴포넌트',
      `${x.cycles.toLocaleString()}번 붙였다 떼고 나서 남은 이벤트 리스너 <b class="${x.leftListeners ? 'bad' : 'ok'}">${x.leftListeners}개</b>, 타이머 <b class="${x.leftTimers ? 'bad' : 'ok'}">${x.leftTimers}개</b>. 한 번에 ${fmt(x.msPerCycle)}ms, 앞 절반 ${fmt(x.firstHalfMs)}ms · 뒤 절반 ${fmt(x.secondHalfMs)}ms (느려지지 않음 = 쌓이는 것 없음).`,
      table(['반복', '동시에 살아 있던 최대 리스너', '남은 리스너', '남은 타이머', '1회 (ms)'], [[x.cycles.toLocaleString(), x.peakListeners, x.leftListeners, x.leftTimers, fmt(x.msPerCycle)]])));
  }
  if (R.exp6) {
    const x = R.exp6;
    parts.push(section('실험 6 · 무작위 트리 퍼즈', 'diff + patch 결과 == 새로 그린 결과',
      `무작위로 만든 트리 쌍 ${x.cases.toLocaleString()}개 중 <b class="${x.pass === x.cases ? 'ok' : 'bad'}">${x.pass.toLocaleString()}개</b>가 새로 그린 결과와 같은 DOM 이 됐다 (평균 패치 ${fmt(x.avgPatches)}개, ${x.ms.toLocaleString()}ms).${x.strictDiff ? ` HTML 문자열로 비교하면 ${x.strictDiff}건이 다르게 나오는데, 모두 속성 순서 차이(<code>title class</code> ↔ <code>class title</code>)뿐이다.` : ''}`,
      table(['경우', 'DOM 일치 (isEqualNode)', '문자열까지 일치', '불일치 예', '평균 패치 수'], [[x.cases.toLocaleString(), x.pass.toLocaleString(), (x.cases - x.strictDiff).toLocaleString(), x.fails.join(', ') || '없음', fmt(x.avgPatches)]])));
  }
  $('#results').innerHTML = parts.join('');
}

// ---------------------------------------------------------------- 툴팁
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  const tip = $('#tip');
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.dataset.tip;
  tip.style.display = 'block';
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY + 12}px`;
});

// ---------------------------------------------------------------- 실행
const ENV = `${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? '브라우저'} · CPU ${navigator.hardwareConcurrency}개`;
$('#env').textContent = ENV;

async function runAll() {
  $('#run').disabled = true;
  // ?only=exp1 → 그 실험만 다시 돌리고, 나머지는 지난번(이 브라우저에 저장된) 결과를 쓴다
  const only = new URLSearchParams(location.search).get('only')?.split(',');
  let saved = null;
  try { saved = only ? JSON.parse(localStorage.getItem('bench-saved')) : null; } catch {}
  const R = window.__bench.results = { ...(saved || {}), env: ENV, at: new Date().toISOString() };
  try {
    for (const [k, fn] of [['exp1', exp1], ['exp2', exp2], ['exp3', exp3], ['exp4', exp4], ['exp5', exp5], ['exp6', exp6]]) {
      if (only && !only.includes(k) && R[k]) { render(R); continue; }
      R[k] = await fn();
      render(R);
      await frame();
    }
    status('끝');
    try { localStorage.setItem('bench-saved', JSON.stringify(R)); } catch {}
  } catch (e) {
    status(`오류: ${e.message}`);
    window.__bench.error = String(e.stack || e);
  } finally {
    window.__bench.done = true;
    $('#run').disabled = false;
  }
}
$('#run').addEventListener('click', runAll);
window.__run = { exp1, exp2, exp3, exp4, exp5, exp6, render };
if (new URLSearchParams(location.search).has('auto')) runAll();
