// 컴포넌트 트리 → 일반 VDOM
//
// h(TodoItem, props)는 { type: TodoItem, props, children }을 만들기만 하고 실행하지 않는다.
// expand가 type이 함수인 노드를 실행해, 태그 이름만 남은 트리(Phase 1의 VNode)로 바꾼다.
// 그래서 render·diff·patch는 컴포넌트를 전혀 몰라도 된다.
//
// 언제 컴포넌트를 실행할지를 expand를 부르는 쪽(FunctionComponent)이 정할 수 있게
// h() 안에서 바로 실행하지 않고 단계를 나눴다.

import { render } from './vdom.js';
import { diff, patch } from './diff.js';
import { runRender, HOOK_ORDER_RULE } from './hooks.js';

// options.onComponent: 함수 컴포넌트를 실행하기 직전 { type: 'expand:component', name, props }를 받는 콜백.
// 학습 페이지가 "어느 컴포넌트가 어떤 props로 펼쳐지는지" 기록할 때만 쓴다 (없으면 동작 변화 없음).
export function expand(vnode, options = {}) {
  // 루트 함수가 null·false를 돌려준 경우도 같은 에러로 알린다
  const isEmpty = vnode === null || vnode === undefined || typeof vnode === 'boolean';
  const result = isEmpty ? null : expandNode(vnode, options);
  if (result === null) {
    throw new Error('루트 컴포넌트가 아무것도 돌려주지 않았습니다. 화면에 그릴 요소가 하나는 있어야 합니다.');
  }
  return result;
}

// 펼친 결과가 비었으면(null) 부모의 자식 목록에서 빠진다
function expandNode(vnode, options) {
  if (typeof vnode === 'string') return vnode;

  if (typeof vnode.type === 'function') {
    const component = vnode.type;
    // 자식 컴포넌트는 props만 받는 순수 함수다. 태그 안에 쓴 자식은 props.children으로 넘긴다.
    const props = { ...vnode.props, children: vnode.children };
    options.onComponent?.({ type: 'expand:component', name: component.name || '익명', props });
    const output = component(props);
    const normalized = normalizeOutput(output, component);
    // 컴포넌트가 또 컴포넌트를 돌려줘도 태그가 나올 때까지 계속 펼친다
    return normalized === null ? null : expandNode(normalized, options);
  }

  return {
    type: vnode.type,
    props: vnode.props,
    children: vnode.children.map((child) => expandNode(child, options)).filter((child) => child !== null),
  };
}

// h()의 자식 규칙과 맞춘다: null·true·false는 비움, 숫자는 문자열
function normalizeOutput(output, component) {
  const name = component.name || '익명 컴포넌트';
  if (output === undefined) {
    throw new Error(`${name}가 undefined를 돌려줬습니다. return을 빠뜨리지 않았는지 확인하세요.`);
  }
  if (Array.isArray(output)) {
    throw new Error(`${name}가 배열을 돌려줬습니다. 여러 요소는 하나의 태그로 감싸서 돌려주세요.`);
  }
  if (output === null || typeof output === 'boolean') return null;
  if (typeof output === 'number') return String(output);
  return output;
}

// 상태를 가진 루트 컴포넌트 하나를 container에 그리고, setState가 오면 다시 그린다.
//
//   mount   : hookIndex = 0 → fn 실행 → expand → render → prevVNode 저장 → effect 실행
//   update  : hookIndex = 0 → fn 다시 실행 → expand → diff(prevVNode, next) → patch → prevVNode 교체 → effect 실행
//   unmount : 모든 cleanup 호출 → 화면 비우기
//
// hooks 배열은 인스턴스에 있으므로 fn이 몇 번을 다시 실행돼도 상태가 유지된다.
//
// options
//   batching : true(기본) — setState를 모아 한 번만 다시 그린다. false면 setState마다 즉시 그린다 (비교용)
//   onRender : 렌더가 화면에 반영될 때마다 { type, renderCount, batchSize, patches }를 받는 콜백.
//              렌더 횟수를 useState에 넣으면 그 setState가 또 렌더를 일으키므로, 화면 밖에서 표시할 때 쓴다.
//   trace    : 엔진 안에서 일어난 일을 (event, component)로 알리는 콜백. 학습 페이지가 한 단계씩 재생하려고 쓴다.
//              event는 { type, ...필드 } (render:start, hook:state, state:set, update:schedule, diff:done 등).

// 한 틱(브라우저가 다른 일을 하기 전) 안에서 예약 렌더가 이만큼 이어지면 무한 루프로 본다.
// 예약 렌더는 마이크로태스크라 끝없이 이어지면 브라우저가 화면을 그리지도 못하고 멈추기 때문이다.
const MAX_CHAINED_UPDATES = 50;

export class FunctionComponent {
  constructor(fn, container, { batching = true, onRender, trace } = {}) {
    this.fn = fn;
    this.container = container;
    this.hooks = []; // useState 등이 호출 순서대로 칸을 차지하는 사물함
    this.hookIndex = 0; // 이번 렌더에서 다음에 열 사물함 번호
    this.prevVNode = null; // 마지막으로 화면에 반영한 VDOM (다음 diff의 기준)
    this.pendingEffects = []; // 이번 렌더에서 실행하기로 한 effect (patch 뒤에 실행)
    this.isUpdateScheduled = false;
    this.isMounted = false;
    this.isBatching = batching;
    this.onRender = onRender;
    this.trace = trace;
    this.renderCount = 0; // 화면에 반영된 렌더 수 (mount 포함)
    this.pendingSetStateCount = 0; // 다음 렌더에 합쳐질 setState 호출 수
    this.lastBatchSize = 0; // 직전 렌더에 합쳐진 setState 호출 수
    this.expectedHookCount = null; // 직전 렌더의 Hook 개수 (첫 렌더 전에는 null)
    this.chainedUpdateCount = 0; // 이번 틱에 이어진 예약 렌더 수
    // mount할 때마다 1씩 늘어나는 세대 번호. 예약된 update와 setState가 "어느 mount 때 것인지" 구분해서,
    // unmount 후 같은 인스턴스를 다시 mount했을 때 옛 작업이 새 트리에 적용되지 않게 한다.
    this.mountGeneration = 0;
  }

  mount() {
    if (this.isMounted) {
      throw new Error('이미 mount된 컴포넌트입니다. 처음부터 다시 그리려면 unmount() 후 mount()하세요.');
    }
    this.mountGeneration++; // 이번 렌더에서 만드는 사물함이 새 세대 번호를 갖도록 렌더 전에 올린다
    // mount는 항상 빈 사물함에서 시작한다. 이전 mount 시도가 렌더 도중 실패했다면 옛 세대의 사물함이 남아 있어,
    // 재사용하면 그 setState가 세대가 달라 무시되기 때문이다.
    this.hooks = [];
    this.expectedHookCount = null;
    const vnode = this.renderVNode('mount');
    this.container.replaceChildren(render(vnode));
    this.emitTrace({ type: 'commit:done', kind: 'mount' });
    this.prevVNode = vnode;
    this.isMounted = true;
    this.recordRender('mount', []);
    this.runEffects(); // DOM이 붙은 뒤라 effect에서 실제 요소를 읽을 수 있다
    return this;
  }

  update() {
    this.isUpdateScheduled = false;
    // unmount 뒤에 늦게 도착한 예약(타이머 안의 setState 등)은 무시한다
    if (!this.isMounted) return [];
    this.emitTrace({ type: 'update:start' });
    const nextVNode = this.renderVNode('update');
    const patches = diff(this.prevVNode, nextVNode);
    this.emitTrace({ type: 'diff:done', patches });
    patch(this.container, patches);
    this.prevVNode = nextVNode;
    this.emitTrace({ type: 'commit:done', kind: 'update' });
    this.recordRender('update', patches);
    this.runEffects();
    return patches;
  }

  emitTrace(event) {
    this.trace?.(event, this);
  }

  recordRender(type, patches) {
    this.renderCount++;
    this.lastBatchSize = this.pendingSetStateCount;
    this.pendingSetStateCount = 0;
    this.onRender?.({ type, renderCount: this.renderCount, batchSize: this.lastBatchSize, patches });
  }

  unmount() {
    if (!this.isMounted) return;
    this.isMounted = false;
    this.emitTrace({ type: 'unmount' });
    // 타이머·구독처럼 effect가 열어 둔 것을 닫는다 (선언 순서대로)
    this.hooks.forEach((hook, index) => {
      if (typeof hook.cleanup !== 'function') return;
      this.emitTrace({ type: 'effect:cleanup', index });
      hook.cleanup();
    });
    this.container.replaceChildren();
    this.hooks = [];
    this.prevVNode = null;
    this.pendingEffects = [];
    this.pendingSetStateCount = 0;
    this.expectedHookCount = null;
    // 이미 큐에 들어간 마이크로태스크는 꺼낼 수 없으므로 표시만 지운다.
    // 그 작업은 실행될 때 세대 번호가 달라 무시된다 (runScheduledUpdate).
    this.isUpdateScheduled = false;
  }

  // Batching: setState가 여러 번 불려도 바로 그리지 않고 예약만 한다.
  // 이미 예약돼 있으면 다시 예약하지 않으므로, 지금 실행 중인 코드(이벤트 핸들러 등)가 끝난 직후
  // 마이크로태스크에서 update가 한 번만 일어난다. 그때는 모든 setState가 사물함에 반영된 뒤다.
  scheduleUpdate() {
    if (!this.isMounted) return;
    this.pendingSetStateCount++;
    this.emitTrace({ type: 'update:schedule', alreadyScheduled: this.isBatching && this.isUpdateScheduled });

    if (!this.isBatching) {
      this.update(); // 비교용: setState마다 즉시 렌더
      return;
    }
    if (this.isUpdateScheduled) return;
    this.isUpdateScheduled = true;
    const generation = this.mountGeneration;
    queueMicrotask(() => this.runScheduledUpdate(generation));
  }

  // deps 없는 useEffect 안에서 setState하면 렌더 → effect → setState → 렌더…가 마이크로태스크로 끝없이 이어진다.
  // 다음 매크로태스크(setTimeout)가 오기 전까지 이어진 렌더 수를 세어, 너무 많으면 멈추고 원인을 알린다.
  runScheduledUpdate(generation) {
    // 예약한 뒤 unmount → mount가 일어났다면 이전 세대의 작업이므로 새 트리에 적용하지 않는다.
    // isUpdateScheduled는 새 세대의 것일 수 있으니 건드리지 않는다.
    if (generation !== this.mountGeneration) return;

    this.chainedUpdateCount++;
    if (this.chainedUpdateCount === 1) {
      setTimeout(() => {
        this.chainedUpdateCount = 0;
      }, 0);
    }
    if (this.chainedUpdateCount > MAX_CHAINED_UPDATES) {
      this.isUpdateScheduled = false;
      this.pendingSetStateCount = 0;
      throw new Error(
        `렌더가 쉬지 않고 ${MAX_CHAINED_UPDATES}번 넘게 이어져 멈췄습니다. ` +
          'deps 없는 useEffect 안에서 setState하고 있지 않은지 확인하세요.'
      );
    }
    this.update();
  }

  renderVNode(kind) {
    // 매 렌더 첫 번째 Hook이 0번 사물함을 열도록 되돌린다. 호출 순서가 곧 사물함 번호다.
    this.hookIndex = 0;
    this.pendingEffects = []; // 이전 렌더가 실패해 남은 예약은 버린다
    // 되돌린 뒤에 알린다: 기록된 "렌더 시작" 순간의 hookIndex가 0이어야 설명과 맞는다
    this.emitTrace({ type: 'render:start', kind });
    const expandTree = (tree) => expand(tree, { onComponent: (event) => this.emitTrace(event) });
    const vnode = runRender(this, () => this.fn({}), expandTree);

    // Hook이 이전 렌더보다 적어졌으면 뒤쪽 사물함이 엉뚱한 값을 갖게 된다 (많아진 경우는 takeHookSlot이 바로 잡는다)
    if (this.expectedHookCount !== null && this.hookIndex !== this.expectedHookCount) {
      throw new Error(
        `Hook 개수가 이전 렌더(${this.expectedHookCount}개)와 다릅니다(이번 ${this.hookIndex}개). ` +
          HOOK_ORDER_RULE
      );
    }
    this.expectedHookCount = this.hookIndex;
    return vnode;
  }

  // 다시 실행할 effect들의 옛 cleanup을 먼저 전부 호출한 뒤, 새 effect를 실행한다.
  // 정리와 실행이 섞이지 않게 두 번에 나눠 돈다 (A 정리 → B 정리 → A 실행 → B 실행).
  runEffects() {
    const effects = this.pendingEffects;
    this.pendingEffects = [];

    for (const { hook, index } of effects) {
      if (typeof hook.cleanup === 'function') {
        this.emitTrace({ type: 'effect:cleanup', index });
        hook.cleanup();
      }
      hook.cleanup = undefined;
    }
    for (const { hook, effect, deps, index } of effects) {
      hook.deps = deps;
      this.emitTrace({ type: 'effect:run', index });
      const cleanup = effect();
      // 함수를 돌려주면 다음 실행 직전이나 unmount 때 부를 cleanup으로 저장한다
      hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }
}
