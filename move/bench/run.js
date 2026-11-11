/**
 * README 1주차 발표용 측정 · 그래프 생성
 *   node move/bench/run.js        →  move/bench/results.json, move/bench/*.svg
 *
 *  1. diff 계산 시간 (Node): 흔한 LIS(최적화 전 우리 코드) · 우리 LIS · 앞에서부터, 1천 ~ 5만 줄 섞기 · 뒤집기
 *  2. DOM 이동 횟수: 10 ~ 10만 줄 (순서만 계산, 실제 diff 로 교차 확인)
 *  3. 손해 없음: 무작위 재배치 1만 번에서 (앞에서부터 이동 − 우리 이동) 의 분포, 우리 이동 = 이론상 최소인지
 *  4. 브라우저 시간: browser.json (move/ 페이지에서 잰 값) → 막대 그래프
 *  5. 단계별 diff 지연: 처음(0cc8727) · 1단계(목록 재배치 최적화, 9f4e772) · 지금(할당 제거), 실제 앱 같은 줄로
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { h, diff, devConfig, longestIncreasingSubsequence } from '../../src/lib/index.js';
import { diff as diffCommon } from './lis-common.js';
import { diff as diffV1 } from './diff-v1.js';
import { diffNaive, naiveMoves } from '../naive.js';
import { renderLogLog, renderBars, renderHistogram, C, fmt } from './charts.js';

devConfig.warnings = false;
const dir = new URL('./', import.meta.url);
const out = (name, text) => writeFileSync(new URL(name, dir), text);
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
let seed = 20261110;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const row = (i) => h('li', { key: i }, h('span', null, `#${i}`), h('span', null, `항목 ${i}`), h('input', {}));
const list = (keys) => h('ul', null, keys.map(row));
const moveCount = (patches) => patches.filter((p) => p.type === 'MOVE').length;
const minMoves = (oldKeys, newKeys) => { const idx = new Map(oldKeys.map((k, i) => [k, i])); const kept = newKeys.filter((k) => idx.has(k)); return kept.length - longestIncreasingSubsequence(kept.map((k) => idx.get(k))).length; };

// node move/bench/run.js browser → browser.json 으로 브라우저 그래프만 다시 그린다 (측정은 move/ 페이지에서)
const ONLY_BROWSER = process.argv[2] === 'browser';
const browser = JSON.parse(readFileSync(new URL('browser.json', dir), 'utf8'));
const browserChart = () => out('browser.svg', renderBars({
  title: `실제 브라우저 — ${browser.rows.toLocaleString('en-US')}줄 목록, 화면에 반영되기까지`,
  subtitle: 'diff + patch + 스타일 · 레이아웃 · 페인트 (ms, 9회 중앙값, 두 방식을 번갈아 실행) · 낮을수록 빠름',
  yLabel: '시간 (ms)',
  legendItems: [['앞에서부터', C.naive], ['우리 LIS', C.ours]],
  groups: browser.ops.map((o) => ({ label: o.label, sub: o.naive / o.ours >= 1.15 ? `${(o.naive / o.ours).toFixed(1)}배` : '같음', bars: [{ key: 'naive', y: o.naive }, { key: 'ours', y: o.ours }] })),
}));
if (ONLY_BROWSER) { browserChart(); console.log('완료: move/bench/browser.svg'); process.exit(0); }

// ---------------------------------------------------------------- 1. diff 시간
const ALGOS = { common: diffCommon, ours: diff, naive: diffNaive };
const SIZES = [1000, 2000, 5000, 10000, 20000, 50000];
const timing = [];
for (const n of SIZES) {
  const keys = Array.from({ length: n }, (_, i) => i);
  for (const [op, next] of [['shuffle', shuffle(keys)], ['reverse', keys.slice().reverse()]]) {
    const a = list(keys), b = list(next);
    const row = { n, op };
    for (const [name, f] of Object.entries(ALGOS)) {
      const reps = n >= 20000 ? 5 : 9;
      f(a, b); // 워밍업
      const t = [];
      let moves = 0;
      for (let r = 0; r < reps; r++) { const t0 = performance.now(); const ps = f(a, b); t.push(performance.now() - t0); moves = moveCount(ps); }
      row[name] = +med(t).toFixed(2);
      row[`${name}Moves`] = moves;
    }
    timing.push(row);
    console.log(`${n} ${op}  흔한 LIS ${row.common}ms · 우리 ${row.ours}ms · 앞에서부터 ${row.naive}ms  (이동 ${row.commonMoves}/${row.oursMoves}/${row.naiveMoves})`);
  }
}

// ---------------------------------------------------------------- 5. 단계별 diff 지연 (실제 앱 같은 줄: 요소 5개 · 클래스 · 스타일 · 클릭 핸들러)
const appRow = (it) => h('li', { key: it.id, class: 'row' },
  h('span', { class: 'sw', style: { background: `hsl(${it.id % 360} 60% 50%)` } }),
  h('span', { class: 'id' }, `#${it.id}`),
  h('span', { class: 'label' }, it.label),
  h('input', { placeholder: '메모', value: '' }),
  h('button', { onClick: () => {} }, '삭제'));
const appList = (items) => h('ul', { class: 'list' }, items.map(appRow));
const STAGES = { v0: diffCommon, v1: diffV1, v2: diff };
const SCENARIOS = ['바뀐 것 없음', '한 줄 글자 변경', '맨 아래 → 맨 위', '섞기'];
const stages = [];
for (const n of [1000, 10000]) {
  const items = Array.from({ length: n }, (_, i) => ({ id: i, label: `항목 ${i}` }));
  const nexts = [items, items.map((it, i) => (i === n >> 1 ? { ...it, label: '바뀜' } : it)), [items.at(-1), ...items.slice(0, -1)], shuffle(items)];
  SCENARIOS.forEach((name, si) => {
    const row = { n, scenario: name };
    const t = { v0: [], v1: [], v2: [] };
    for (let r = 0; r < 30; r++) {
      // 매번 새 VNode (실제 다시 그리기와 같게), 세 단계를 돌아가며 먼저 실행
      const order = Object.keys(STAGES); for (let k = 0; k < r % 3; k++) order.push(order.shift());
      for (const st of order) { const a = appList(items), b = appList(nexts[si]); const t0 = performance.now(); STAGES[st](a, b); if (r >= 5) t[st].push(performance.now() - t0); }
    }
    for (const st of Object.keys(STAGES)) row[st] = +med(t[st]).toFixed(3);
    stages.push(row);
    console.log(`${n} ${name}  처음 ${row.v0}ms · 1단계 ${row.v1}ms · 지금 ${row.v2}ms  (${(row.v0 / row.v2).toFixed(1)}배)`);
  });
}

// ---------------------------------------------------------------- 2. 이동 횟수
const moveSizes = [10, 100, 1000, 10000, 100000];
const moves = moveSizes.map((n) => {
  const keys = Array.from({ length: n }, (_, i) => i);
  const last = [n - 1, ...keys.slice(0, -1)];
  const r = { n, lastNaive: naiveMoves(keys, last), lastOurs: minMoves(keys, last) };
  if (n <= 10000) r.lastOursDiff = moveCount(diff(list(keys), list(last))); // 실제 diff 로 교차 확인
  return r;
});

// ---------------------------------------------------------------- 3. 손해 없음
const TRIALS = 10000;
const edits = {
  한줄옮기기: (a) => { const b = a.slice(); const [x] = b.splice(Math.floor(rand() * b.length), 1); b.splice(Math.floor(rand() * (b.length + 1)), 0, x); return b; },
  묶음옮기기: (a) => { const b = a.slice(); const s = Math.floor(rand() * b.length); const k = 1 + Math.floor(rand() * Math.max(1, b.length / 4)); const blk = b.splice(s, k); b.splice(Math.floor(rand() * (b.length + 1)), 0, ...blk); return b; },
  몇쌍바꾸기: (a) => { const b = a.slice(); for (let t = 1 + Math.floor(rand() * 4); t > 0; t--) { const i = Math.floor(rand() * b.length), j = Math.floor(rand() * b.length); [b[i], b[j]] = [b[j], b[i]]; } return b; },
  일부섞기: (a) => { const b = a.slice(); const p = rand(); for (let i = b.length - 1; i > 0; i--) if (rand() < p) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; },
  구간뒤집기: (a) => { const b = a.slice(); const i = Math.floor(rand() * b.length), j = Math.floor(rand() * b.length); const [s, e] = i < j ? [i, j] : [j, i]; return [...b.slice(0, s), ...b.slice(s, e + 1).reverse(), ...b.slice(e + 1)]; },
  추가삭제섞기: (a) => { let b = a.filter(() => rand() > 0.15); b = b.flatMap((k) => (rand() < 0.1 ? [k, 100000 + k] : [k])); return edits.일부섞기(b); },
};
const names = Object.keys(edits);
const diffs = [];
let equalMin = 0, oursMoreThanNaive = 0, totalNaive = 0, totalOurs = 0;
for (let t = 0; t < TRIALS; t++) {
  const n = 2 + Math.floor(rand() * 299);
  const keys = Array.from({ length: n }, (_, i) => i);
  const next = edits[names[t % names.length]](keys);
  const a = list(keys), b = list(next);
  const ours = moveCount(diff(a, b));
  const naive = moveCount(diffNaive(a, b));
  if (ours === minMoves(keys, next)) equalMin++;
  if (ours > naive) oursMoreThanNaive++;
  totalNaive += naive; totalOurs += ours;
  diffs.push(naive - ours);
}
const BINS = [
  ['우리가 더 많이\n옮김', (d) => d < 0, C.common],
  ['같음\n(0)', (d) => d === 0, C.naive],
  ['1 ~ 9번\n적게', (d) => d >= 1 && d <= 9, C.ours],
  ['10 ~ 49번\n적게', (d) => d >= 10 && d <= 49, C.ours],
  ['50 ~ 99번\n적게', (d) => d >= 50 && d <= 99, C.ours],
  ['100번 이상\n적게', (d) => d >= 100, C.ours],
];
const noLoss = { trials: TRIALS, equalMin, oursMoreThanNaive, totalNaive, totalOurs, bins: BINS.map(([label, f]) => ({ label: label.replace('\n', ' '), count: diffs.filter(f).length })) };
console.log('손해 없음', noLoss);

// ---------------------------------------------------------------- 4. 브라우저 (move/ 페이지에서 잰 값 — browser.json)

writeFileSync(new URL('results.json', dir), JSON.stringify({ when: new Date().toISOString(), node: process.version, timing, moves, noLoss, browser, stages }, null, 2));

// ---------------------------------------------------------------- 그래프
const pick = (op, key) => timing.filter((r) => r.op === op).map((r) => ({ x: r.n, y: r[key] }));
const big = timing.filter((r) => r.n === 20000);
const rev = big.find((r) => r.op === 'reverse'), shf = big.find((r) => r.op === 'shuffle');
out('complexity.svg', renderLogLog({
  title: '같은 LIS 라도 — 목록이 커지면 흔한 구현은 제곱으로 느려진다',
  subtitle: `diff 계산 시간 · 로그-로그 축 · 2만 줄 뒤집기: 흔한 LIS ${fmt(rev.common)}ms → 우리 ${fmt(rev.ours)}ms (${Math.round(rev.common / rev.ours)}배)`,
  xLabel: '줄 수', yLabel: 'diff 계산 시간 (ms)', xTicks: SIZES, yUnit: '',
  series: [
    { label: '흔한 LIS · O(n²)', color: C.common, points: pick('reverse', 'common'), endLabel: `${Math.round(timing.at(-1).common).toLocaleString('en-US')}ms` },
    { color: C.common, dashed: true, points: pick('shuffle', 'common') },
    { label: '우리 LIS · O(n log n)', color: C.ours, points: pick('reverse', 'ours'), endLabel: `${Math.round(timing.at(-1).ours).toLocaleString('en-US')}ms` },
    { color: C.ours, dashed: true, points: pick('shuffle', 'ours') },
  ],
  legendExtra: [['실선 뒤집기', C.soft], ['점선 섞기', C.soft, true]],
}));
out('moves.svg', renderLogLog({
  title: '맨 아래 줄 하나를 맨 위로 — DOM 이동 횟수',
  subtitle: '앞에서부터 옮기는 방식은 n − 1번, LIS 는 줄 수와 상관없이 1번',
  xLabel: '줄 수', yLabel: 'DOM 이동 횟수', xTicks: moveSizes,
  series: [
    { label: '앞에서부터 (React 의 lastPlacedIndex)', color: C.common, points: moves.map((m) => ({ x: m.n, y: m.lastNaive })), endLabel: `${moves.at(-1).lastNaive.toLocaleString('en-US')}번` },
    { label: '우리 LIS', color: C.ours, points: moves.map((m) => ({ x: m.n, y: m.lastOurs })), endLabel: '1번' },
  ],
}));
out('noloss.svg', renderHistogram({
  title: `무작위 재배치 ${TRIALS.toLocaleString('en-US')}번 — 우리가 더 많이 옮긴 경우 ${oursMoreThanNaive}번`,
  subtitle: `(앞에서부터 이동 − 우리 이동) 의 분포 · 2 ~ 300줄 · 6가지 조작 · 우리 이동 = 이론상 최소 ${equalMin.toLocaleString('en-US')}/${TRIALS.toLocaleString('en-US')}`,
  yLabel: '횟수', bins: BINS.map(([label, f, color], i) => ({ label: label.replace('\n', ' '), count: noLoss.bins[i].count, color })),
  note: `전체 이동 합계: 앞에서부터 ${totalNaive.toLocaleString('en-US')}번 · 우리 ${totalOurs.toLocaleString('en-US')}번 (${Math.round((1 - totalOurs / totalNaive) * 100)}% 적음)`,
}));
browserChart();

const s1k = stages.filter((r) => r.n === 1000);
out('stages.svg', renderBars({
  title: 'diff 지연 — 1,000줄 목록, 단계별',
  subtitle: 'diff 계산 시간 (ms, Node, 25회 중앙값) · 한 줄 = 요소 5개 · 클래스 · 스타일 · 클릭 핸들러 · 낮을수록 빠름',
  yLabel: 'diff 시간 (ms)',
  legendItems: [['처음', C.v0], ['1단계: 목록 재배치', C.v1], ['지금: 할당 제거', C.v2]],
  groups: s1k.map((r) => ({ label: r.scenario, sub: `${(r.v0 / r.v2).toFixed(1)}배`, bars: [{ key: 'v0', y: r.v0 }, { key: 'v1', y: r.v1 }, { key: 'v2', y: r.v2 }] })),
}));
console.log('완료: move/bench/results.json, complexity.svg, moves.svg, noloss.svg, browser.svg, stages.svg');
