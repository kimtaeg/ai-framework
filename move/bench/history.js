/**
 * 히스토리 비교 — 스냅샷(StateHistory) vs 키프레임 + 델타(DeltaHistory)
 *   node move/bench/history.js      → move/bench/history.json · history.svg
 *
 *  1,000줄 목록(한 줄 = 요소 5개 · 클래스 · 스타일 · 클릭 핸들러)을 100번 고친 기록을 쌓는다.
 *  고칠 때마다 컴포넌트처럼 트리 전체를 새로 만든다 (70% 한 줄 글자 · 15% 한 줄 맨 위로 · 10% 추가 · 5% 삭제).
 *   - 메모리: 기록을 다 쌓은 뒤 GC 를 돌리고 늘어난 힙 크기
 *   - push: 기록 하나 쌓는 시간 (델타는 뒤로 가는 패치를 위해 diff 를 한 번 더 한다)
 *   - 한 칸 뒤로: 실제 DOM 에 적용할 패치를 얻기까지 (스냅샷 = diff, 델타 = 저장된 패치 + VNode 적용)
 *   - 50칸 점프: 같은 기준
 *  클릭 핸들러를 매번 새로 만드는 경우(inline)와 하나를 계속 쓰는 경우(stable) 두 가지로 잰다.
 *  inline 이면 바뀐 게 없어도 줄마다 "핸들러 바뀜" 패치가 생겨 델타가 커진다.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  // 힙 크기를 정확히 재려면 GC 를 직접 돌려야 한다
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const { h, diff, devConfig } = await import('../../src/lib/index.js');
const { StateHistory, DeltaHistory } = await import('../../src/lib/history.js');
const { renderBars, C } = await import('./charts.js');
devConfig.warnings = false;

const N = 1000, EDITS = 100;
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
let seed = 99;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let MODE = 'inline';
const STABLE = () => {};
const row = (it) => h('li', { key: it.id, class: 'row' },
  h('span', { class: 'sw', style: { background: `hsl(${it.id % 360} 60% 50%)` } }),
  h('span', { class: 'id' }, `#${it.id}`),
  h('span', { class: 'label' }, it.label),
  h('input', { placeholder: '메모', value: '' }),
  h('button', { onClick: MODE === 'inline' ? () => {} : STABLE }, '삭제'));
const render = (items) => h('ul', { class: 'list' }, items.map(row));

/** 같은 편집 순서를 매번 다시 만든다 (모든 방식이 같은 기록을 쌓도록) */
function edits() {
  seed = 99;
  let items = Array.from({ length: N }, (_, i) => ({ id: i, label: `항목 ${i}` }));
  let nextId = N;
  const states = [items];
  for (let e = 0; e < EDITS; e++) {
    const r = rand();
    items = items.slice();
    const i = Math.floor(rand() * items.length);
    if (r < 0.7) items[i] = { ...items[i], label: `고침 ${e}` };
    else if (r < 0.85) { const [x] = items.splice(i, 1); items.unshift(x); }
    else if (r < 0.95) items.splice(i, 0, { id: nextId++, label: `새 ${e}` });
    else items.splice(i, 1);
    states.push(items);
  }
  return states;
}
const states = edits();

const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };

function build(make) {
  const base = heap();
  let cur = render(states[0]);
  const hist = make(cur);
  const push = [];
  for (let s = 1; s < states.length; s++) {
    const next = render(states[s]);
    const t0 = performance.now();
    const fwd = diff(cur, next); // 화면을 바꾸려면 어차피 하는 diff (두 방식 공통)
    hist.push(next, `${s}`, fwd);
    push.push(performance.now() - t0);
    cur = next;
  }
  const mem = heap() - base;
  return { hist, mem, push: med(push) };
}

const VARIANTS = [
  ['스냅샷 (지금까지)', (v) => new StateHistory(v, { limit: 1000 })],
  ['델타 · 키프레임 1칸마다', (v) => new DeltaHistory(v, { limit: 1000, keyframeEvery: 1 })],
  ['델타 · 키프레임 5칸마다', (v) => new DeltaHistory(v, { limit: 1000, keyframeEvery: 5 })],
  ['델타 · 키프레임 10칸마다', (v) => new DeltaHistory(v, { limit: 1000, keyframeEvery: 10 })],
  ['델타 · 키프레임 25칸마다', (v) => new DeltaHistory(v, { limit: 1000, keyframeEvery: 25 })],
  ['델타 · 키프레임 없음 (처음만)', (v) => new DeltaHistory(v, { limit: 1000, keyframeEvery: 1000 })],
];

const rows = [];
for (const mode of ['inline', 'stable']) {
MODE = mode;
console.log(`--- 클릭 핸들러: ${mode === 'inline' ? '매번 새로 만듦 (onClick: () => …)' : '하나를 계속 씀'}`);
for (const [name, make] of VARIANTS) {
  const mems = [], pushes = [];
  let hist;
  for (let r = 0; r < 3; r++) { const b = build(make); mems.push(b.mem); pushes.push(b.push); hist = b.hist; }
  // 이동 시간: 실제 DOM 에 적용할 패치를 얻기까지
  const isDelta = hist instanceof DeltaHistory;
  const travel = (target) => {
    const from = hist.index;
    const before = hist.current;
    const t0 = performance.now();
    if (isDelta) hist.travel(target);
    else { hist.go(target); diff(before, hist.current); }
    const ms = performance.now() - t0;
    hist.go(from); // 원래 자리로 (측정 밖)
    return ms;
  };
  const backs = [], jumps = [];
  for (let r = 0; r < 25; r++) {
    hist.go(EDITS);
    backs.push(travel(EDITS - 1));
    hist.go(EDITS);
    jumps.push(travel(EDITS - 50 - (r % 7))); // 키프레임 바로 위가 아닌 자리도 섞는다
  }
  const row = { mode, name, memMB: +(med(mems) / 1048576).toFixed(2), pushMs: +med(pushes).toFixed(3), backMs: +med(backs).toFixed(3), jumpMs: +med(jumps).toFixed(3) };
  rows.push(row);
  console.log(`${name.padEnd(22)} 메모리 ${String(row.memMB).padStart(6)}MB · push ${row.pushMs}ms · 한 칸 뒤로 ${row.backMs}ms · 50칸 점프 ${row.jumpMs}ms`);
}
}
writeFileSync(new URL('history.json', import.meta.url), JSON.stringify({ when: new Date().toISOString(), node: process.version, rows: N, edits: EDITS, results: rows }, null, 2));
const SHORT = ['스냅샷', '키프레임 1칸', '5칸', '10칸', '25칸', '처음만'];
const stable = rows.filter((r) => r.mode === 'stable');
const inline = rows.filter((r) => r.mode === 'inline');
writeFileSync(new URL('history.svg', import.meta.url), renderBars({
  title: `히스토리 메모리 — ${N.toLocaleString('en-US')}줄 화면을 ${EDITS}번 고친 기록`,
  subtitle: '스냅샷 = 기록마다 화면 트리 전체 · 델타 = 키프레임 사이는 패치만 · GC 뒤 늘어난 힙 (MB) · 낮을수록 적게 씀',
  yLabel: '메모리 (MB)',
  legendItems: [['스냅샷 (이전)', C.v0], ['키프레임 + 델타', C.v2], ['핸들러를 매번 새로 만들 때', C.naive]],
  groups: stable.map((r, i) => ({
    label: SHORT[i],
    sub: i === 0 ? '' : stable[0].memMB / r.memMB < 1.1 ? '같음' : `${(stable[0].memMB / r.memMB).toFixed(1)}배 적음`,
    bars: [{ key: i === 0 ? 'v0' : 'v2', y: r.memMB }, { key: 'naive', y: inline[i].memMB }],
  })),
}));
console.log('완료: move/bench/history.json · history.svg');
