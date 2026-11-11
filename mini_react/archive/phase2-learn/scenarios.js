// 4개 장의 예제와 "실행 대본". 대본은 실제 엔진(src/)을 trace를 켠 채로 돌리고,
// 기록기(recorder)가 사건마다 스냅샷을 찍어 steps를 만든다. 화면은 이 steps만 보고 그린다.

import { h, render } from '../src/vdom.js';
import { expand, FunctionComponent } from '../src/component.js';
import { useState, useEffect, useMemo } from '../src/hooks.js';
import { createRecorder } from './recorder.js';

// 예약된 update(마이크로태스크)와 그 effect까지 끝나길 기다린다 (브라우저에서도 쓰므로 여기에 둔다)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ITEM_TEXTS = ['빨래', '청소', '장보기'];

// 트리를 화면에 그릴 수 있는 일반 객체로 바꾼다: 컴포넌트는 'ƒ 이름', 함수 props(핸들러)는 뺀다
function describeTree(vnode) {
  if (typeof vnode === 'string') return vnode;
  const type = typeof vnode.type === 'function' ? `ƒ ${vnode.type.name || '익명'}` : vnode.type;
  const props = Object.fromEntries(Object.entries(vnode.props).filter(([, value]) => typeof value !== 'function'));
  return { type, props, children: vnode.children.map(describeTree) };
}

// ── 1장: 컴포넌트와 expand ─────────────────────────────

function Card({ title, children }) {
  return h('section', { class: 'card' }, h('h3', null, title), h('ul', null, children));
}

function Item({ text }) {
  return h('li', null, text);
}

async function runExpand({ recorder, container, options }) {
  const items = ITEM_TEXTS.slice(0, options.itemCount).map((text) => h(Item, { text }));
  const tree = h(Card, { title: '할 일' }, ...items);
  recorder.note({ type: 'scenario:h', tree: describeTree(tree) });

  if (options.skipExpand) {
    container.replaceChildren(render(tree)); // 펼치지 않은 트리 → 엔진이 에러를 던진다
    return;
  }
  const vdom = expand(tree, { onComponent: recorder.trace });
  container.replaceChildren(render(vdom));
  recorder.note({ type: 'scenario:vdom', vdom: describeTree(vdom) });
}

// ── 2장: Hooks 사물함과 호출 순서 ───────────────────────

function createHooksApp(options) {
  return function App() {
    const [name] = useState('정글');
    const [count] = useState(0);
    const label = useMemo(() => `${name} ${count}`, [name, count]);
    // 실험: 두 번째 렌더부터 조건부로 Hook이 하나 더 불린다 → 사물함 개수가 어긋난다
    if (options.conditionalHook && count > 0) useState('끼어듦');
    return h('p', null, label);
  };
}

async function runHooks({ recorder, container, options, setComponent }) {
  // 렌더 에러를 이 흐름에서 잡으려고 batching을 끄고 setter를 직접 부른다
  // (예약된 update는 마이크로태스크라 그 안의 에러는 try/catch로 잡을 수 없다)
  const component = new FunctionComponent(createHooksApp(options), container, { trace: recorder.trace, batching: false });
  setComponent(component);
  component.mount();
  recorder.note({ type: 'scenario:click', label: '숫자 올리기' });
  component.hooks[1].setState(1);
}

// ── 3장: setState → 화면 ───────────────────────────────

function createCounter(options) {
  return function Counter() {
    const [count, setCount] = useState(0);
    const handleClick = () => {
      for (let i = 0; i < options.setStateCount; i++) {
        if (options.updateStyle === 'value') setCount(count + 1);
        else setCount((c) => c + 1);
      }
    };
    return h('button', { onClick: handleClick }, `클릭 ${count}`);
  };
}

async function runSetState({ recorder, container, options, setComponent }) {
  const component = new FunctionComponent(createCounter(options), container, {
    trace: recorder.trace,
    batching: options.batching,
  });
  setComponent(component);
  component.mount();
  recorder.note({ type: 'scenario:click', label: '버튼' });
  container.querySelector('button').click();
  await flush();
}

// ── 4장: useEffect와 useMemo ───────────────────────────

const DEPS_CHOICES = {
  none: () => undefined,
  empty: () => [],
  count: (count) => [count],
};

function createEffectsApp(options) {
  return function App() {
    const [count, setCount] = useState(0);
    const [text, setText] = useState('a');
    const doubled = useMemo(() => count * 2, [count]);
    useEffect(() => {
      // 바깥세상 일 대신 아무것도 하지 않는 effect. 언제 실행·정리되는지만 본다
      return () => {};
    }, DEPS_CHOICES[options.deps](count));
    return h(
      'div',
      null,
      h('p', null, `count ${count} · doubled ${doubled} · text ${text}`),
      h('button', { 'data-change': 'count', onClick: () => setCount((c) => c + 1) }, 'count +1'),
      h('button', { 'data-change': 'text', onClick: () => setText((t) => `${t}a`) }, 'text 바꾸기')
    );
  };
}

async function runEffects({ recorder, container, options, setComponent }) {
  const component = new FunctionComponent(createEffectsApp(options), container, { trace: recorder.trace });
  setComponent(component);
  component.mount();
  recorder.note({ type: 'scenario:click', label: options.change === 'count' ? 'count +1' : 'text 바꾸기' });
  container.querySelector(`[data-change="${options.change}"]`).click();
  await flush();
  if (options.unmount) component.unmount();
}

// ── 장 목록 ────────────────────────────────────────────

const select = (id, label, options, defaultValue) => ({ id, label, kind: 'select', options, default: defaultValue });
const toggle = (id, label, defaultValue = false) => ({ id, label, kind: 'toggle', default: defaultValue });

export const SCENARIOS = [
  {
    id: 'expand',
    title: '1장 · 컴포넌트와 expand',
    summary: 'h()는 컴포넌트를 실행하지 않고 적어 두기만 합니다. expand가 함수를 실행해 태그만 남은 VDOM으로 펼쳐요.',
    code: [
      { text: "const Item = ({ text }) => h('li', null, text);", mark: 'component:Item' },
      { text: 'const Card = ({ title, children }) =>', mark: 'component:Card' },
      { text: "  h('section', null, h('h3', null, title), h('ul', null, children));", mark: 'component:Card' },
      { text: '' },
      { text: "const tree = h(Card, { title: '할 일' }, h(Item, { text: '빨래' }), …);", mark: 'scenario:h' },
      { text: 'const vdom = expand(tree);  // 함수를 끝까지 실행', mark: 'scenario:vdom' },
      { text: 'render(vdom);' },
    ],
    panels: ['tree'],
    controls: [
      select('itemCount', 'Item 개수', [1, 2, 3].map((n) => ({ value: n, label: `${n}개` })), 2),
      toggle('skipExpand', 'expand 없이 render 해 보기'),
    ],
    run: runExpand,
  },
  {
    id: 'hooks',
    title: '2장 · Hooks 사물함과 호출 순서',
    summary: '상태는 함수 밖 사물함(hooks 배열)에 호출 순서대로 저장됩니다. 렌더마다 0번부터 같은 순서로 다시 열어요.',
    code: [
      { text: 'function App() {', mark: 'render:start' },
      { text: "  const [name] = useState('정글');   // 0번 사물함", mark: 'hook:state' },
      { text: '  const [count] = useState(0);       // 1번 사물함', mark: 'hook:state' },
      { text: '  const label = useMemo(() => `${name} ${count}`, [name, count]);  // 2번', mark: 'hook:memo' },
      { text: "  if (실험 && count > 0) useState('끼어듦');  // ← 이러면?", mark: 'error' },
      { text: "  return h('p', null, label);", mark: 'commit:done' },
      { text: '}' },
    ],
    panels: ['hooks'],
    controls: [toggle('conditionalHook', '두 번째 렌더에서 if 안의 Hook 켜기')],
    run: runHooks,
  },
  {
    id: 'setstate',
    title: '3장 · setState → 화면',
    summary: 'setState는 값만 바꾸고 다시 그리기를 예약합니다. 지금 코드가 끝난 뒤 한 번에 diff → patch 해요.',
    code: [
      { text: 'function Counter() {', mark: 'render:start' },
      { text: '  const [count, setCount] = useState(0);', mark: 'hook:state' },
      { text: '  onClick: () => {', mark: 'scenario:click' },
      { text: '    setCount(c => c + 1);   // × 횟수', mark: 'state:set' },
      { text: '  }', mark: 'update:schedule' },
      { text: '  return h(\'button\', { onClick }, `클릭 ${count}`);', mark: 'diff:done' },
      { text: '}', mark: 'commit:done' },
    ],
    panels: ['hooks', 'queue', 'patch'],
    controls: [
      select('setStateCount', '한 번 클릭에 setState', [1, 2, 3].map((n) => ({ value: n, label: `${n}번` })), 3),
      select('updateStyle', '업데이트 방식', [
        { value: 'function', label: 'setCount(c => c + 1)' },
        { value: 'value', label: 'setCount(count + 1)' },
      ], 'function'),
      toggle('batching', 'Batching', true),
    ],
    run: runSetState,
  },
  {
    id: 'effects',
    title: '4장 · useEffect와 useMemo',
    summary: 'useMemo는 렌더 도중 계산하고, useEffect는 화면 반영 뒤에 실행됩니다. deps가 그대로면 둘 다 건너뛰어요.',
    code: [
      // 사물함 번호까지 보고 강조한다: 0번(count)과 1번(text)을 구분해야 어느 상태가 바뀌는지 보인다
      { text: 'const [count, setCount] = useState(0);', marks: ['hook:state:0', 'state:set:0'] },
      { text: "const [text, setText] = useState('a');", marks: ['hook:state:1', 'state:set:1'] },
      { text: 'const doubled = useMemo(() => count * 2, [count]);', mark: 'hook:memo' },
      { text: 'useEffect(() => {', mark: 'effect:run' },
      { text: '  return () => { /* cleanup */ };', mark: 'effect:cleanup' },
      { text: '}, deps);', mark: 'hook:effect' },
    ],
    panels: ['hooks', 'effects'],
    controls: [
      select('deps', 'effect deps', [
        { value: 'none', label: '없음 (매 렌더)' },
        { value: 'empty', label: '[] (처음 한 번)' },
        { value: 'count', label: '[count]' },
      ], 'count'),
      select('change', '바꿀 상태', [
        { value: 'count', label: 'count' },
        { value: 'text', label: 'text' },
      ], 'count'),
      toggle('unmount', '끝나고 unmount'),
    ],
    run: runEffects,
  },
];

export function getScenario(id) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`없는 장입니다: ${id}`);
  return scenario;
}

export function getDefaultOptions(scenario) {
  return Object.fromEntries(scenario.controls.map((control) => [control.id, control.default]));
}

// 장 하나를 새 기록기로 실행한다. 성공·실패 모두 마지막에 컴포넌트를 내리되,
// 그 정리용 unmount는 학습 내용이 아니므로 기록에 남기지 않는다(trace를 먼저 끊는다).
export async function runScenario(id, options, container) {
  const scenario = getScenario(id);
  const recorder = createRecorder({ container });
  let component = null;
  let error = null;

  try {
    await scenario.run({
      recorder,
      container,
      options: { ...getDefaultOptions(scenario), ...options },
      setComponent: (c) => {
        component = c;
      },
    });
  } catch (caught) {
    error = caught;
    recorder.recordError(caught);
  } finally {
    recorder.stop();
    if (component) {
      component.trace = undefined;
      component.unmount();
    }
    container.replaceChildren();
  }

  return { steps: recorder.steps, isTruncated: recorder.isTruncated, error };
}
