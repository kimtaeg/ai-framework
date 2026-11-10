// 대시보드 탭: App을 mount하고, 렌더마다 RenderStats(App 밖)를 갱신한다.
//
// 흐름
//   클릭 → setState → (배칭) → App.update() → diff → patch(바뀐 노드 깜빡임) → onRender → RenderStats 갱신 → effect

import { h } from '../core/vdom.js';
import { FunctionComponent } from '../core/component.js';
import { summarizeMutations, flash, EMPTY_MUTATIONS } from '../utils/domStats.js';
import { createApp } from './App.js';
import { RenderStats } from './components/RenderStats.js';

const appRoot = document.getElementById('dashboard-app');
const statsRoot = document.getElementById('dashboard-stats');

// 앱 영역만 지켜본다 (RenderStats 영역의 변화는 세지 않음)
const observer = new MutationObserver(() => {});
observer.observe(appRoot, { childList: true, subtree: true, attributes: true, characterData: true });

const comparison = {
  diff: { renders: 0, totalMs: 0, totalMutations: 0 },
  full: { renders: 0, totalMs: 0, totalMutations: 0 },
};
const averages = (sum) => ({
  renders: sum.renders,
  avgMs: sum.renders ? sum.totalMs / sum.renders : 0,
  avgMutations: sum.renders ? sum.totalMutations / sum.renders : 0,
});

let lastInfo = null;
let lastMutations = EMPTY_MUTATIONS;
let app = null;

// 같은 동작(같은 매크로태스크) 안에서 몇 번 렌더됐는지 센다 → 배칭 on/off 비교용
let rendersThisTurn = 0;
let isTurnResetScheduled = false;
function countRenderInThisTurn() {
  rendersThisTurn++;
  if (isTurnResetScheduled) return;
  isTurnResetScheduled = true;
  setTimeout(() => {
    rendersThisTurn = 0;
    isTurnResetScheduled = false;
  }, 0);
}

// RenderStats는 Hook 없는 순수 컴포넌트. 같은 core(diff·patch)로 따로 그린다
const stats = new FunctionComponent(() => h(RenderStats, {
  info: lastInfo && { ...lastInfo, rendersThisTurn },
  mutations: lastMutations,
  comparison: { diff: averages(comparison.diff), full: averages(comparison.full) },
  renderMode: app?.renderMode ?? 'diff',
  batching: app?.batching ?? true,
  onRenderMode: handleRenderMode,
  onBatching: handleBatching,
}), statsRoot).mount();

function handleRenderMode(event) {
  app.setOptions({ renderMode: event.currentTarget.dataset.mode });
  stats.update();
}

function handleBatching(event) {
  app.setOptions({ batching: event.currentTarget.checked });
  stats.update();
}

// App의 렌더가 DOM에 반영될 때마다 (effect 실행 전)
function handleRender(info) {
  lastInfo = info;
  lastMutations = summarizeMutations(observer.takeRecords());
  if (info.type === 'update') {
    const sum = comparison[info.mode];
    sum.renders++;
    sum.totalMs += info.durationMs;
    sum.totalMutations += lastMutations.nodes; // 자식까지 센 값으로 비교
  }
  countRenderInThisTurn();
  stats.update();
}

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
app = new FunctionComponent(createApp({ initialDark: prefersDark }), appRoot, { onRender: handleRender, onPatch: (node) => flash(node) }).mount();
