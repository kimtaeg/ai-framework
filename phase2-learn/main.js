// 학습 페이지 재생기: 장을 고르고 실행해 얻은 steps를 한 단계씩 3단 화면에 그린다.
// 화면은 steps(사건 + 그 순간의 스냅샷)만 보고 그리므로, 엔진을 다시 돌리지 않고 앞뒤로 오갈 수 있다.

import { SCENARIOS, getScenario, getDefaultOptions, runScenario } from './scenarios.js';
import { describeStep } from './explain.js';

const $ = (id) => document.getElementById(id);

const PATCH_TAG_CLASS = { CREATE: 'create', REMOVE: 'remove', REPLACE: 'replace', TEXT: 'text', PROPS: 'props' };
// 사물함 번호(index)를 가진 사건: 이 사건의 단계에서는 해당 사물함을 테두리로 강조한다
const SLOT_EVENTS = new Set(['hook:state', 'hook:memo', 'hook:effect', 'state:set', 'effect:run', 'effect:cleanup']);
// 화살표 키를 그대로 써야 하는 입력 요소. 여기에 포커스가 있으면 단계 이동을 하지 않는다
const TYPING_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

const state = {
  scenarioId: SCENARIOS[0].id,
  options: getDefaultOptions(SCENARIOS[0]),
  steps: [],
  stepIndex: 0,
  isTruncated: false,
  runId: 0, // 실행할 때마다 올린다. 늦게 끝난 이전 실행의 결과는 버린다
};

// 기록 대상 앱을 실제로 돌릴 곳. 화면에는 보이지 않고, 보여 주는 것은 각 단계의 스냅샷이다
const sandbox = document.createElement('div');

// ── 작은 DOM 도우미 ─────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== undefined) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
}

// i번째 단계까지 거슬러 올라가며 type 사건을 찾는다. stopTypes를 만나면 그 이전은 보지 않는다
function findBack(i, types, stopTypes = []) {
  for (let k = i; k >= 0; k--) {
    const { type } = state.steps[k].event;
    if (types.includes(type)) return state.steps[k];
    if (stopTypes.includes(type)) return null;
  }
  return null;
}

// ── 왼쪽: 장 목록과 실험 조절 ───────────────────────

function renderChapters() {
  $('chapters').replaceChildren(
    ...SCENARIOS.map((scenario) =>
      el('li', {},
        el('button', {
          type: 'button',
          class: scenario.id === state.scenarioId ? 'chapter is-active' : 'chapter',
          'aria-current': scenario.id === state.scenarioId ? 'step' : false,
          onclick: () => selectScenario(scenario.id),
        }, scenario.title))
    )
  );
}

function renderControls() {
  const scenario = getScenario(state.scenarioId);
  const controls = scenario.controls.map((control) => {
    if (control.kind === 'toggle') {
      return el('label', { class: 'control control--toggle' },
        el('input', {
          type: 'checkbox',
          checked: state.options[control.id],
          onchange: (event) => { state.options[control.id] = event.currentTarget.checked; },
        }),
        control.label);
    }
    const select = el('select', {
      onchange: (event) => { state.options[control.id] = control.options[event.currentTarget.selectedIndex].value; },
    }, control.options.map((option) => el('option', {}, option.label)));
    select.selectedIndex = control.options.findIndex((option) => option.value === state.options[control.id]);
    return el('label', { class: 'control' }, control.label, select);
  });
  $('controls').replaceChildren(...(controls.length ? controls : [el('p', { class: 'hint' }, '이 장은 조절할 것이 없습니다.')]));
}

// ── 가운데: 설명 · 코드 · 화면 ───────────────────────

function renderCenter(step, description) {
  const scenario = getScenario(state.scenarioId);
  $('chapter-title').textContent = scenario.title;
  $('chapter-summary').textContent = scenario.summary;

  const isError = step?.event.type === 'error';
  $('explain').className = isError ? 'explain is-error' : 'explain';
  $('explain-step').textContent = step ? `${step.index + 1}단계` : '';
  $('explain-source').textContent = description?.source ?? '';
  $('explain-text').textContent = description?.text ?? '실행 중…';

  $('code').replaceChildren(
    ...scenario.code.map((line) =>
      el('span', { class: line.mark && line.mark === description?.mark ? 'code__line is-current' : 'code__line' }, line.text || ' '))
  );

  // 스냅샷 HTML은 예제 앱이 render한 결과를 직렬화한 것이다 (사용자 입력이 아님)
  $('screen').innerHTML = step?.snapshot.html ?? '';

  const notice = $('notice');
  notice.hidden = !state.isTruncated;
  notice.textContent = state.isTruncated ? '기록이 너무 길어 300단계에서 멈췄습니다. 그 뒤의 일은 보이지 않아요.' : '';
}

// ── 오른쪽: 엔진 내부 패널 ───────────────────────────

function renderTreeNode(node) {
  if (typeof node === 'string') return el('li', {}, el('span', { class: 'tree__text' }, `"${node}"`));
  const isComponent = node.type.startsWith('ƒ');
  const props = Object.entries(node.props).filter(([key]) => key !== 'children');
  const label = `${node.type}${props.length ? ` ${props.map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')}` : ''}`;
  return el('li', {},
    el('span', { class: isComponent ? 'tree__fn' : 'tree__tag' }, label),
    node.children.length ? el('ul', {}, node.children.map(renderTreeNode)) : null);
}

function renderTreePanel(i) {
  const h = findBack(i, ['scenario:h']);
  const vdom = findBack(i, ['scenario:vdom']);
  return [
    el('div', { class: 'box' }, el('h4', {}, '펼치기 전: h()가 만든 트리'),
      h ? el('ul', { class: 'tree' }, renderTreeNode(h.event.tree)) : el('p', { class: 'box__empty' }, '아직 없음')),
    el('div', { class: vdom && vdom.index === i ? 'box is-changed-box' : 'box' }, el('h4', {}, '펼친 뒤: 태그만 남은 VDOM'),
      vdom ? el('ul', { class: 'tree' }, renderTreeNode(vdom.event.vdom)) : el('p', { class: 'box__empty' }, '아직 펼치지 않음')),
  ];
}

function renderHooksPanel(step, prevStep) {
  const { hooks, hookIndex } = step.snapshot;
  const currentSlot = SLOT_EVENTS.has(step.event.type) ? step.event.index : null;
  const slots = hooks.length
    ? el('ol', { class: 'slots' }, hooks.map((slot, n) => {
        const before = prevStep?.snapshot.hooks[n];
        const isChanged = !before || JSON.stringify(before.value) !== JSON.stringify(slot.value);
        const classes = ['slot', n === currentSlot && 'is-current', isChanged && prevStep && 'is-changed'].filter(Boolean).join(' ');
        const value = slot.kind === 'useEffect' ? `deps ${formatValue(slot.deps)}` : formatValue(slot.value);
        return el('li', { class: classes },
          el('span', { class: 'slot__no' }, n),
          el('span', { class: 'slot__kind' }, slot.kind),
          el('span', { class: 'slot__value' }, value));
      }))
    : el('p', { class: 'box__empty' }, '비어 있음');
  return [
    el('div', { class: 'box' }, el('h4', {}, '사물함 (hooks 배열)'), slots),
    el('div', { class: 'box' },
      el('p', { class: 'kv' }, el('span', {}, 'hookIndex (다음에 열 번호)'),
        el('code', {}, hookIndex === null || step.event.type === 'commit:done' || step.event.type.startsWith('effect') ? '— (렌더 밖)' : String(hookIndex)))),
  ];
}

function renderQueuePanel(step, prevStep) {
  const isScheduled = step.snapshot.isUpdateScheduled;
  const isChanged = prevStep && prevStep.snapshot.isUpdateScheduled !== isScheduled;
  const lastSchedule = findBack(step.index, ['update:schedule'], ['update:start']);
  return [
    el('div', { class: isChanged ? 'box is-changed-box' : 'box' }, el('h4', {}, '예약 큐 (queueMicrotask)'),
      el('p', { class: isScheduled ? 'kv' : 'box__empty' }, isScheduled ? 'update() ×1 예약됨' : '비어 있음'),
      lastSchedule?.event.alreadyScheduled ? el('p', { class: 'box__empty' }, '방금 setState는 이미 예약돼 있어 새로 예약하지 않음') : null),
  ];
}

function renderPatchPanel(step) {
  const diffStep = findBack(step.index, ['diff:done'], ['update:start', 'render:start']);
  const commitStep = findBack(step.index, ['commit:done'], ['update:start', 'render:start']);
  const patches = diffStep?.event.patches ?? null;
  const mutations = commitStep?.snapshot.mutations ?? null;
  return [
    el('div', { class: diffStep?.index === step.index ? 'box is-changed-box' : 'box' }, el('h4', {}, '이번 patch'),
      patches === null
        ? el('p', { class: 'box__empty' }, '아직 비교하지 않음')
        : patches.length === 0
          ? el('p', { class: 'box__empty' }, '바뀐 곳 없음')
          : el('ol', { class: 'list' }, patches.map((p) =>
              el('li', {}, el('span', { class: `tag tag--${PATCH_TAG_CLASS[p.type] ?? 'text'}` }, p.type), ` [${p.path.join(', ')}]`,
                p.type === 'TEXT' ? ` "${p.from}" → "${p.to}"` : '',
                p.type === 'PROPS' ? ` ${p.changes.map((c) => c.key).join(', ')}` : '')))),
    el('div', { class: commitStep?.index === step.index ? 'box is-changed-box' : 'box' },
      el('p', { class: 'kv' }, el('span', {}, '바뀐 실제 DOM 노드'), el('code', {}, mutations ? String(mutations.total) : '—'))),
  ];
}

function renderEffectsPanel(step) {
  const effectSlots = step.snapshot.hooks.map((slot, n) => ({ ...slot, n })).filter((slot) => slot.kind === 'useEffect');
  const log = state.steps.slice(0, step.index + 1).filter((s) => s.event.type === 'effect:run' || s.event.type === 'effect:cleanup' || s.event.type === 'unmount');
  return [
    el('div', { class: 'box' }, el('h4', {}, 'effect 사물함'),
      effectSlots.length
        ? el('ul', { class: 'list' }, effectSlots.map((slot) =>
            el('li', {}, `${slot.n}번 deps ${formatValue(slot.deps)} · cleanup ${slot.hasCleanup ? '있음' : '없음'}`)))
        : el('p', { class: 'box__empty' }, '아직 없음')),
    el('div', { class: log.at(-1)?.index === step.index ? 'box is-changed-box' : 'box' }, el('h4', {}, 'effect 실행 기록'),
      log.length
        ? el('ol', { class: 'list' }, log.map((s) =>
            el('li', {}, s.event.type === 'unmount' ? 'unmount' : `${s.event.type === 'effect:run' ? '실행' : '정리(cleanup)'} · ${s.event.index}번`)))
        : el('p', { class: 'box__empty' }, '아직 실행 안 됨')),
  ];
}

function renderEngine(step) {
  if (!step) {
    $('panels').replaceChildren(el('p', { class: 'box__empty' }, '실행하면 여기에 엔진 내부가 보입니다.'));
    return;
  }
  const prevStep = state.steps[step.index - 1] ?? null;
  const builders = {
    tree: () => renderTreePanel(step.index),
    hooks: () => renderHooksPanel(step, prevStep),
    queue: () => renderQueuePanel(step, prevStep),
    patch: () => renderPatchPanel(step),
    effects: () => renderEffectsPanel(step),
  };
  $('panels').replaceChildren(...getScenario(state.scenarioId).panels.flatMap((panel) => builders[panel]()));
}

// ── 단계 이동 ───────────────────────────────────────

function renderStep() {
  const step = state.steps[state.stepIndex] ?? null;
  const description = step ? describeStep(step) : null;
  renderCenter(step, description);
  renderEngine(step);

  const total = state.steps.length;
  $('btn-prev').disabled = state.stepIndex <= 0;
  $('btn-next').disabled = state.stepIndex >= total - 1;
  $('btn-restart').disabled = state.stepIndex <= 0;
  $('step-count').textContent = `${total ? state.stepIndex + 1 : 0} / ${total}`;
  $('progress-bar').style.width = total ? `${((state.stepIndex + 1) / total) * 100}%` : '0';
}

function goTo(index) {
  const clamped = Math.max(0, Math.min(index, state.steps.length - 1));
  if (clamped === state.stepIndex) return;
  state.stepIndex = clamped;
  renderStep();
}

async function run() {
  const runId = ++state.runId;
  $('btn-run').disabled = true;
  state.steps = [];
  state.stepIndex = 0;
  state.isTruncated = false;
  renderStep();

  const result = await runScenario(state.scenarioId, { ...state.options }, sandbox);
  if (runId !== state.runId) return; // 그 사이 다른 실행이 시작됨 → 이 결과는 버린다

  state.steps = result.steps;
  state.isTruncated = result.isTruncated;
  state.stepIndex = 0;
  $('btn-run').disabled = false;
  renderStep();
}

function selectScenario(id) {
  state.scenarioId = id;
  state.options = getDefaultOptions(getScenario(id));
  renderChapters();
  renderControls();
  run();
}

// ── 이벤트 ─────────────────────────────────────────

$('btn-run').addEventListener('click', run);
$('btn-prev').addEventListener('click', () => goTo(state.stepIndex - 1));
$('btn-next').addEventListener('click', () => goTo(state.stepIndex + 1));
$('btn-restart').addEventListener('click', () => goTo(0));

document.addEventListener('keydown', (event) => {
  if (TYPING_TAGS.has(document.activeElement?.tagName)) return; // select에서 ← →는 값 바꾸기용
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    goTo(state.stepIndex + 1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    goTo(state.stepIndex - 1);
  }
});

selectScenario(state.scenarioId);
