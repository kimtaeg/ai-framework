import { FunctionComponent } from '../src/lib/component.js';
import { summarizePatches } from '../src/lib/diff.js';
import { countNodes } from '../src/lib/vdom.js';
import { CartApp, FormApp, KanbanApp, ListApp, StopwatchApp, EffectTimingApp, ContextApp } from './apps.js';
import { flags, EXPERIMENTS, clearLeakedTimers } from './experiments.js';
import { createElement } from '../src/lib/vdom.js';
import { devConfig, resetWarnings } from '../src/lib/warn.js';

const APPS = {
  cart: CartApp, form: FormApp, kanban: KanbanApp, list: ListApp, stopwatch: StopwatchApp,
  effect: EffectTimingApp, context: ContextApp,
};

// ============================================================ 개발 모드 경고 → 화면에 토스트로
devConfig.warnings = true;
devConfig.onWarn = (message) => {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = `⚠ miniReact 경고: ${message}`;
  box.append(t);
  setTimeout(() => t.remove(), 7000);
};
const registry = {}; // id → { comp, observer }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ============================================================ 마운트 + 인스펙터
function mountExample(id) {
  const root = document.getElementById(`app-${id}`);
  const stat = document.getElementById(`stat-${id}`);
  const observer = new MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  let lastStructural = null;

  const onCommit = ({ type, patches, duration, renderCount, component }) => {
    const mutations = observer.takeRecords().length;
    // 매 렌더마다 새로 만들어지는 이벤트 핸들러 교체는 DOM 변경이 아니므로 따로 센다
    const real = patches.filter((p) => !(p.type === 'PROPS' && p.changes.every((c) => typeof c.value === 'function' || typeof c.oldValue === 'function')));
    const chips = Object.entries(summarizePatches(real))
      .filter(([, n]) => n)
      .map(([t, n]) => `<span class="badge ${t}">${t} ${n}</span>`)
      .join(' ');
    // 텍스트 말고 구조/속성이 바뀐 마지막 커밋을 기억 (스톱워치처럼 매우 자주 렌더링되면 위 칸이 금방 덮이기 때문)
    if (type === 'mount') lastStructural = null;
    else if (real.some((p) => p.type !== 'TEXT')) lastStructural = { renderCount, chips };
    stat.innerHTML =
      `<span>렌더 <b>${renderCount}</b>회</span>` +
      `<span>${type === 'mount' ? '최초 마운트' : chips || '<span class="muted">DOM 변경 없음</span>'}</span>` +
      `<span>DOM 변경 <b>${mutations}</b>건 / 전체 노드 ${countNodes(component.vnode).toLocaleString()}개</span>` +
      `<span class="muted">${duration.toFixed(1)}ms</span>` +
      (lastStructural ? `<span class="last">최근 구조 변경 <span class="muted">(렌더 #${lastStructural.renderCount})</span> ${lastStructural.chips}</span>` : '');
    if (type === 'update') {
      stat.classList.remove('pulse');
      void stat.offsetWidth;
      stat.classList.add('pulse');
    }
  };

  const showError = (error) => {
    console.error(error);
    stat.innerHTML = `<span class="err">⚠ 렌더링 에러: ${esc(error.message)}</span>`;
  };

  const comp = new FunctionComponent(APPS[id], {}, { onCommit, onError: showError });
  try {
    comp.mount(root);
  } catch (error) {
    // 한 예제가 실패해도 나머지 예제는 계속 마운트되도록, 에러를 그 예제 칸에만 표시
    const box = document.createElement('pre');
    box.className = 'ex-error';
    box.textContent = `렌더링 에러: ${error.message}`;
    root.replaceChildren(box);
    showError(error);
  }
  registry[id] = { comp, observer };
}

function remount(id) {
  const entry = registry[id];
  if (entry) {
    entry.observer.disconnect();
    entry.comp.unmount();
  }
  if (id === 'stopwatch' && !flags.stopwatchNoCleanup) clearLeakedTimers();
  document.getElementById(`app-${id}`).replaceChildren();
  mountExample(id);
}

// ============================================================ 실험실 (망가뜨리기 / 복구)
function activeOf(app) {
  return EXPERIMENTS.find((e) => e.app === app && flags[e.id]) ?? null;
}

function toggle(exp) {
  const on = !flags[exp.id];
  for (const e of EXPERIMENTS) if (e.app === exp.app) flags[e.id] = false; // 한 앱에 실험 하나만
  flags[exp.id] = on;
  resetWarnings(); // 같은 경고도 다시 볼 수 있도록
  remount(exp.app);
  renderLab(exp.app);
  renderSummary();
}

function restoreAll() {
  const apps = new Set(EXPERIMENTS.filter((e) => flags[e.id]).map((e) => e.app));
  for (const e of EXPERIMENTS) flags[e.id] = false;
  for (const app of apps) {
    remount(app);
    renderLab(app);
  }
  renderSummary();
}

function renderLab(app) {
  const lab = document.getElementById(`lab-${app}`);
  const card = document.getElementById(`ex-${app}`);
  if (!lab || !EXPERIMENTS.some((e) => e.app === app)) return; // 실험이 없는 예제
  const active = activeOf(app);
  card.classList.toggle('broken', !!active);

  const bar = document.createElement('div');
  bar.className = 'lab-bar';
  bar.innerHTML = `<span class="lab-label">🧪 일부러 망가뜨리기</span>`;
  for (const exp of EXPERIMENTS.filter((e) => e.app === app)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = flags[exp.id] ? 'lab-btn on' : 'lab-btn';
    btn.textContent = flags[exp.id] ? `↩ 복구하기 (${exp.title})` : exp.title;
    btn.setAttribute('aria-pressed', String(!!flags[exp.id]));
    btn.addEventListener('click', () => toggle(exp));
    bar.append(btn);
  }
  if (!active) {
    const hint = document.createElement('span');
    hint.className = 'lab-hint muted';
    hint.textContent = '정상 상태 · 버튼을 누르면 이 앱만 망가진 코드로 다시 마운트됩니다';
    bar.append(hint);
    lab.replaceChildren(bar);
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'lab-panel';
  panel.innerHTML = `
    <div class="lab-status">
      <b>지금 망가진 상태: ${esc(active.title)}</b>
      <span class="lab-concept">${esc(active.concept)}</span>
      <a href="${active.theory}">이론 보기 →</a>
    </div>
    <div class="lab-code">
      <div><span class="tag ok">정상 코드</span><pre>${esc(active.before)}</pre></div>
      <div><span class="tag bad">망가진 코드</span><pre>${esc(active.after)}</pre></div>
    </div>
    <div class="lab-steps">
      <div><b>① 해보기</b><p>${esc(active.try)}</p></div>
      <div><b>② 예측하기</b><p>누르기 전에 어떻게 될지 먼저 말해보세요.</p></div>
    </div>
    <details class="lab-answer"><summary>③ 관찰할 것 (예측한 뒤에 열기)</summary><p>${esc(active.watch)}</p></details>
    <details class="lab-answer"><summary>④ 왜 그럴까?</summary><p>${esc(active.why)}</p></details>`;
  lab.replaceChildren(bar, panel);
}

function renderSummary() {
  const n = EXPERIMENTS.filter((e) => flags[e.id]).length;
  document.getElementById('lab-count').textContent = n ? `망가뜨린 예제 ${n}개` : '모두 정상';
  document.getElementById('lab-count').classList.toggle('on', n > 0);
  document.getElementById('lab-reset-all').disabled = n === 0;
}

// ============================================================ Virtual DOM vs 전체 다시 그리기
/**
 * 같은 변경("한 명 점수 +1")을 두 방식으로 해서 비교한다.
 *  A) miniReact: setState → diff → 바뀐 곳만 patch
 *  B) 전체 다시 그리기: 같은 VNode 로 DOM 전체를 새로 만들어 통째로 교체 (innerHTML 방식과 같은 효과)
 * 시간에는 offsetHeight 를 읽어 강제로 일으킨 레이아웃(Reflow) 계산까지 포함한다.
 */
function compareFull() {
  const { comp } = registry.list;
  const root = document.getElementById('app-list');
  const out = document.getElementById('cmp-out');
  if (!comp?.isMounted) return;
  const ROUNDS = 5;
  const count = (fn) => {
    const ob = new MutationObserver(() => {});
    ob.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const t0 = performance.now();
    fn();
    void root.offsetHeight; // 레이아웃 강제 계산
    const dt = performance.now() - t0;
    const records = ob.takeRecords();
    ob.disconnect();
    const created = records.reduce((n, r) => n + [...r.addedNodes].reduce((m, a) => m + 1 + (a.querySelectorAll ? a.querySelectorAll('*').length : 0), 0), 0);
    return { dt, mutations: records.length, created };
  };

  const a = [];
  const b = [];
  for (let i = 0; i < ROUNDS; i++) {
    a.push(count(() => {
      root.querySelector('.bump').click();
      comp.flush(); // 예약된 업데이트를 바로 실행해서 시간을 잴 수 있게
    }));
    b.push(count(() => {
      const fresh = createElement(comp.vnode);
      root.replaceChildren(fresh);
      comp.dom = fresh; // 이후 diff/patch 가 새 DOM 을 기준으로 하도록
    }));
  }
  const avg = (list, k) => list.reduce((s, x) => s + x[k], 0) / list.length;
  const ta = avg(a, 'dt');
  const tb = avg(b, 'dt');
  out.innerHTML = `
    <table>
      <tr><th>방식</th><th>DOM 변경</th><th>새로 만든 요소</th><th>평균 시간</th></tr>
      <tr class="win"><td>Virtual DOM diff + patch</td><td>${avg(a, 'mutations').toFixed(0)}건</td><td>${avg(a, 'created').toFixed(0)}개</td><td>${ta.toFixed(2)}ms</td></tr>
      <tr><td>전체 다시 그리기</td><td>${avg(b, 'mutations').toFixed(0)}건</td><td>${avg(b, 'created').toLocaleString()}개</td><td>${tb.toFixed(2)}ms</td></tr>
    </table>
    <p>${tb > ta ? `전체 다시 그리기가 약 <b>${(tb / Math.max(ta, 0.01)).toFixed(1)}배</b> 느렸습니다.` : '이번에는 차이가 거의 없었습니다. 다시 실행해 보세요.'}
    전체 다시 그리기는 표의 <b>스크롤 위치와 입력 포커스도 초기화</b>됩니다 (노드가 전부 새것이라서).</p>`;
}
document.getElementById('cmp-run')?.addEventListener('click', compareFull);

// ============================================================ 시작
for (const id of Object.keys(APPS)) {
  mountExample(id);
  renderLab(id);
}
document.getElementById('lab-reset-all').addEventListener('click', restoreAll);
renderSummary();

// 디버깅용: __examples.cart.hooks 처럼 각 예제의 Hook 저장소를 볼 수 있다
window.__examples = new Proxy({}, { get: (_, id) => registry[id]?.comp });
window.__experiments = { flags, toggle: (id) => toggle(EXPERIMENTS.find((e) => e.id === id)), restoreAll };
