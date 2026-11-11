/**
 * FunctionComponent + Hooks
 * ------------------------------------------------------------------
 * 핵심 질문: "함수는 매번 새로 실행되는데, 상태는 어떻게 유지할까?"
 *
 * 답: 상태를 함수 "바깥" — 컴포넌트 인스턴스의 hooks 배열 — 에 저장한다.
 *     렌더링 직전에 '현재 렌더링 중인 컴포넌트' 를 전역(currentComponent)에 등록하고
 *     hookIndex 를 0 으로 초기화한다. 함수 안에서 useState() 가 호출될 때마다
 *     hooks[hookIndex++] 슬롯을 꺼내 쓰므로, 호출 "순서" 가 곧 상태의 식별자가 된다.
 *     → 그래서 Hook 은 조건문/반복문 안에서 호출하면 안 된다. (순서가 바뀌면 슬롯이 어긋남)
 *
 * 렌더링 파이프라인
 *   setState → (microtask 로 batching) → update()
 *     → render(): 루트 함수 실행 + 자식 컴포넌트 펼치기 → 새 VNode 트리
 *     → diff(이전 VNode, 새 VNode) → patches
 *     → applyPatches(): 바뀐 부분만 실제 DOM 반영
 *     → useLayoutEffect 실행 (DOM 반영 직후, 브라우저가 그리기 전 · 동기)
 *     → (브라우저가 화면을 그림)
 *     → useEffect 실행 (그린 뒤 · 비동기)
 *
 * 제약 (과제 요구사항)
 *   - Hook 은 루트 컴포넌트에서만 사용 가능. 자식 컴포넌트에서 호출하면 에러를 던진다.
 *   - 자식 컴포넌트는 props 만 받는 순수 함수 (Lifting State Up)
 *   - 예외: useContext 는 상태를 만들지 않고 값을 "읽기만" 하므로 자식에서도 쓸 수 있다.
 */

import { TEXT, createElement, createText, normalizeChildren, focusedKeys } from './vdom.js';
import { diff } from './diff.js';
import { applyPatches } from './patch.js';
import { warn } from './warn.js';

let currentComponent = null; // 지금 렌더링 중인 루트 컴포넌트
let childDepth = 0; // 자식 컴포넌트를 렌더링 중이면 > 0
const contextStack = []; // [context, value] — 렌더 중인 위치를 감싼 Provider 들

const scheduleMicrotask =
  typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn);

/**
 * 브라우저가 화면을 그린 "뒤"에 실행한다. (useEffect 용)
 *  requestAnimationFrame 은 다음 그리기 직전에 불리므로, 그 안에서 setTimeout 을 걸면 그리기 이후가 된다.
 *  탭이 숨겨져 rAF 가 멈추면 effect 가 영영 안 불리므로 100ms 안전장치를 함께 건다.
 *  rAF 가 없는 환경(Node 테스트)에서는 다음 작업(macrotask)으로 미룬다.
 */
function afterPaint(fn) {
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0);
    return;
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 100);
}

const MAX_NESTED_UPDATES = 50;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class FunctionComponent {
  /**
   * @param {(props) => VNode} fn  루트 함수형 컴포넌트
   * @param {object} props
   * @param {object} [options]
   * @param {(info) => void} [options.onCommit]   커밋(DOM 반영 + layout effect) 직후 — 디버깅/시각화용
   * @param {(info) => void} [options.onEffects]  useEffect 들이 실행된 직후
   * @param {(error) => void} [options.onError]   업데이트 중 에러 (없으면 throw)
   */
  constructor(fn, props = {}, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('FunctionComponent: 함수형 컴포넌트가 필요합니다.');
    this.fn = fn;
    this.props = props;
    this.hooks = []; // 상태 저장소: 렌더링이 끝나도 사라지지 않는다
    this.hookIndex = 0;
    this.container = null;
    this.dom = null; // 루트 DOM 노드
    this.vnode = null; // 마지막으로 커밋된 VNode 트리
    this.isMounted = false;
    this.isUnmounted = false;
    this.isRendering = false;
    this.updateScheduled = false;
    this.renderEffects = { layout: [], passive: [] }; // 이번 렌더에서 예약된 effect
    this.pendingPassive = []; // 커밋은 끝났지만 아직 실행 안 된 useEffect
    this.passiveScheduled = false;
    this.updateReasons = []; // 이번 렌더를 일으킨 setState 들 { index, kind }
    this.renderCount = 0;
    this.nestedUpdates = 0;
    this.memoCache = new Map(); // memo 컴포넌트 결과: Map<memo 함수, Map<key, { props, children, result, gen }>>
    this.renderGen = 0; // 렌더마다 1씩 — 이번 렌더에 쓰이지 않은 memo 결과를 버릴 때 쓴다
    this.onCommit = options.onCommit ?? null;
    this.onEffects = options.onEffects ?? null;
    this.onError = options.onError ?? null;
  }

  /** 함수를 실행해 VNode 트리를 만든다. (DOM 은 건드리지 않음 — 순수한 계산 단계) */
  render() {
    const prevComponent = currentComponent;
    currentComponent = this;
    this.hookIndex = 0;
    this.renderGen++;
    this.isRendering = true;
    this.renderEffects = { layout: [], passive: [] };
    const expectedHooks = this.hooks.length;
    try {
      const out = resolve(this.fn(this.props));
      if (this.isMounted && this.hookIndex !== expectedHooks) {
        throw new Error(
          `렌더링마다 Hook 호출 개수가 달라졌습니다 (${expectedHooks} → ${this.hookIndex}). ` +
            'Hook 을 조건문/반복문 안에서 호출하지 마세요.'
        );
      }
      this.renderCount++;
      this.sweepMemo();
      return normalizeRoot(out);
    } finally {
      this.isRendering = false;
      currentComponent = prevComponent;
      contextStack.length = 0;
    }
  }

  /** 이번 렌더에서 다시 쓰이지 않은 memo 결과를 버린다 (사라진 줄의 결과가 쌓이지 않게) */
  sweepMemo() {
    for (const [fn, byKey] of this.memoCache) {
      for (const [key, entry] of byKey) if (entry.gen !== this.renderGen) byKey.delete(key);
      if (byKey.size === 0) this.memoCache.delete(fn);
    }
  }

  /** 최초 렌더링: VNode → 실제 DOM 생성 → 컨테이너에 부착 → effect 실행 */
  mount(container) {
    if (this.isMounted) throw new Error('이미 마운트된 컴포넌트입니다.');
    this.container = container;
    const t0 = now();
    const vnode = this.render();
    const t1 = now();
    const dom = createElement(vnode);
    if (dom.nodeType === 1) dom.__mrOwner = this; // 이벤트 때 최신 VNode 에서 핸들러를 찾도록 (vdom.js liveHandler)
    container.replaceChildren(dom);
    const t2 = now();
    this.vnode = vnode;
    this.dom = dom;
    this.isMounted = true;
    this.commit({ type: 'mount', patches: [], start: t0, timings: { render: t1 - t0, diff: 0, patch: t2 - t1 } });
    return this;
  }

  /** 상태 변경 후 다시 렌더링: 새 VNode → diff → 변경분만 patch → effect 실행 */
  update() {
    this.updateScheduled = false;
    if (!this.isMounted || this.isUnmounted) return [];
    this.flushPassiveEffects(); // 아직 안 돈 useEffect 가 있으면 먼저 처리 (React 와 동일)
    const reasons = this.updateReasons;
    this.updateReasons = [];
    const t0 = now();
    const next = this.render();
    const t1 = now();
    // 입력 중인 줄이 있으면 diff 가 그 줄을 되도록 옮기지 않게 알려 준다 (moveBefore 가 없는 브라우저의 포커스 보존)
    const keep = typeof document !== 'undefined' && this.dom ? focusedKeys(this.dom) : null;
    const patches = diff(this.vnode, next, [], [], { keep, liveHandlers: true });
    const t2 = now();
    try {
      this.dom = applyPatches(this.dom, patches);
    } catch (error) {
      // 패치가 중간에 실패하면 DOM 일부만 바뀐 채로 VNode 와 어긋난다 → 새 트리로 통째로 다시 그려 맞춘다
      warn(`patch 적용 중 오류가 나서 화면을 새로 그렸습니다: ${error.message}`);
      const fresh = createElement(next);
      if (this.container) this.container.replaceChildren(fresh);
      else this.dom?.replaceWith?.(fresh);
      this.dom = fresh;
    }
    if (this.dom?.nodeType === 1) this.dom.__mrOwner = this; // 루트가 교체됐을 수 있다
    const t3 = now();
    this.vnode = next;
    this.commit({ type: 'update', patches, reasons, start: t0, timings: { render: t1 - t0, diff: t2 - t1, patch: t3 - t2 } });
    return patches;
  }

  /**
   * setState 가 호출하는 스케줄러 — Batching
   * 같은 이벤트 핸들러(동기 코드) 안의 여러 setState 는 하나의 microtask 로 모여 1번만 렌더링된다.
   */
  scheduleUpdate(reason) {
    if (this.isUnmounted) return;
    if (reason) this.updateReasons.push(reason);
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    scheduleMicrotask(() => {
      if (!this.updateScheduled) return;
      this.safely(() => this.update());
    });
  }

  safely(fn) {
    try {
      fn();
    } catch (error) {
      // 렌더 중 에러(Hook 규칙 위반 등): 화면은 마지막으로 성공한 상태 그대로 두고 알린다
      this.updateScheduled = false;
      if (this.onError) this.onError(error);
      else throw error;
    }
  }

  /** 예약된 업데이트와 effect 를 즉시 실행 (테스트 / flushSync 용) */
  flush() {
    const patches = this.updateScheduled ? this.update() : [];
    this.flushPassiveEffects();
    return patches;
  }

  commit(info) {
    // 1) useLayoutEffect: DOM 반영 직후, 브라우저가 그리기 전에 동기 실행
    const t0 = now();
    const layoutList = this.renderEffects.layout;
    runEffects(layoutList);
    const layout = now() - t0;
    // 2) useEffect: 화면을 그린 뒤 실행하도록 예약
    this.pendingPassive.push(...this.renderEffects.passive);
    this.renderEffects = { layout: [], passive: [] };
    if (this.pendingPassive.length && !this.passiveScheduled) {
      this.passiveScheduled = true;
      afterPaint(() => this.safely(() => this.flushPassiveEffects()));
    }
    if (layoutList.length) this.checkNested();
    const timings = { ...info.timings, layout };
    const duration = now() - info.start;
    this.onCommit?.({ ...info, timings, duration, renderCount: this.renderCount, component: this });
  }

  /** 대기 중인 useEffect 실행: 모든 cleanup 을 먼저, 그다음 모든 effect (React 와 같은 순서) */
  flushPassiveEffects() {
    this.passiveScheduled = false;
    if (!this.pendingPassive.length || this.isUnmounted) {
      this.pendingPassive = [];
      return;
    }
    const list = this.pendingPassive;
    this.pendingPassive = [];
    const t0 = now();
    runEffects(list);
    this.checkNested();
    this.onEffects?.({ count: list.length, duration: now() - t0, renderCount: this.renderCount, component: this });
  }

  /**
   * effect 안에서 setState → 다시 렌더 → effect → setState ... 무한 루프 방지
   * effect 를 실행한 직후에만 호출한다. effect 가 또 업데이트를 예약했으면 +1, 아니면 연쇄가 끝난 것이므로 0.
   */
  checkNested() {
    if (!this.updateScheduled) {
      this.nestedUpdates = 0;
      return;
    }
    if (++this.nestedUpdates > MAX_NESTED_UPDATES) {
      this.updateScheduled = false;
      this.nestedUpdates = 0;
      const error = new Error('업데이트가 너무 많이 중첩되었습니다. useEffect 의 의존성 배열을 확인하세요.');
      if (this.onError) this.onError(error);
      else throw error;
    }
  }

  /** 언마운트: 모든 effect cleanup 실행, DOM 제거 */
  unmount() {
    if (!this.isMounted || this.isUnmounted) return;
    // 아직 실행 안 된 useEffect 가 있으면 먼저 실행해야 그 cleanup 도 짝을 맞춰 호출된다 (React 와 동일)
    if (this.pendingPassive.length) {
      const list = this.pendingPassive;
      this.pendingPassive = [];
      runEffects(list);
    }
    this.isUnmounted = true;
    this.updateScheduled = false;
    for (const hook of this.hooks) {
      if ((hook.kind === 'useEffect' || hook.kind === 'useLayoutEffect') && typeof hook.cleanup === 'function') hook.cleanup();
    }
    this.dom?.remove();
  }
}

function runEffects(list) {
  for (const { slot } of list) {
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.cleanup = null;
  }
  for (const { slot, effect } of list) {
    const cleanup = effect();
    slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }
}

/** 편의 함수: mount(App, container) */
export function mount(fn, container, props, options) {
  return new FunctionComponent(fn, props, options).mount(container);
}

// ------------------------------------------------------------------
// 컴포넌트 트리 펼치기 (resolve)
// ------------------------------------------------------------------

/**
 * VNode 트리에 섞여 있는 자식 컴포넌트(type 이 함수)를 호출해 순수 엘리먼트/텍스트 트리로 만든다.
 * 자식 컴포넌트는 인스턴스도 상태도 없이 "props → VNode" 순수 함수로만 실행된다.
 */
export function resolve(node) {
  if (node == null || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return normalizeChildren(node).flatMap((n) => toArray(resolve(n)));
  if (typeof node !== 'object') return createText(node);
  if (node.type === TEXT) return node;

  // VNode 는 불변이고 자식 컴포넌트는 순수 함수이므로, 같은 VNode 객체의 펼친 결과는 항상 같다.
  // → 캐시해 두면 useMemo 로 재사용된 VNode 는 같은 참조가 되어 diff 가 통째로 건너뛴다.
  // 단, Provider 안쪽은 Context 값에 따라 결과가 달라질 수 있으므로 캐시하지 않는다.
  if (contextStack.length > 0) return resolveUncached(node);
  const cached = resolveCache.get(node);
  if (cached !== undefined) return cached;
  const result = resolveUncached(node);
  resolveCache.set(node, result);
  return result;
}

const resolveCache = new WeakMap();

function resolveUncached(node) {
  if (typeof node.type === 'function') {
    // Context.Provider: 값을 스택에 올려 두고 자식을 펼친다 (DOM 에는 아무것도 만들지 않음)
    const ctx = node.type.__context;
    if (ctx) {
      contextStack.push([ctx, node.props.value]);
      try {
        return resolve(node.children);
      } finally {
        contextStack.pop();
      }
    }
    // memo 컴포넌트: 같은 key 의 props · children 이 지난 렌더와 같으면 지난 결과 객체를 그대로 쓴다
    // → 결과가 같은 객체라 diff 가 그 줄 전체를 비교 없이 건너뛴다 (diffNode 의 oldVNode === newVNode)
    const memo = node.type.__memo;
    const comp = currentComponent;
    if (memo && comp && node.key != null) {
      let byKey = comp.memoCache.get(node.type);
      if (!byKey) comp.memoCache.set(node.type, (byKey = new Map()));
      const hit = byKey.get(node.key);
      if (hit && sameChildren(hit.children, node.children) && memo.areEqual(hit.props, node.props)) {
        hit.gen = comp.renderGen;
        return hit.result;
      }
      const result = callChild(node);
      byKey.set(node.key, { props: node.props, children: node.children, result, gen: comp.renderGen });
      return result;
    }
    return callChild(node);
  }

  const children = [];
  let same = true;
  for (const c of node.children) {
    const r = resolve(c);
    if (r !== c) same = false;
    children.push(...toArray(r));
  }
  // 바뀐 것이 없으면 원래 객체를 그대로 반환 (참조 동일성 유지)
  return same ? node : { ...node, children };
}

/** 자식 컴포넌트를 순수 함수로 실행하고 펼친다 (Hook 금지 구역) */
function callChild(node) {
  childDepth++;
  let out;
  try {
    out = node.type({ ...node.props, children: node.children });
  } finally {
    childDepth--;
  }
  const resolved = resolve(out);
  // 컴포넌트에 준 key 를 결과 엘리먼트에 물려준다 (리스트 재정렬 시 MOVE 로 인식)
  if (resolved && !Array.isArray(resolved) && node.key != null && resolved.key == null) {
    return { ...resolved, key: node.key };
  }
  return resolved;
}

function sameChildren(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** props 를 얕게 비교 (memo 기본 비교) */
export function shallowEqualProps(a, b) {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/**
 * memo(Component, areEqual?) — props 가 같으면 다시 실행하지 않는 자식 컴포넌트.
 *  리스트에서 key 를 줘야 동작한다 (key 로 지난 결과를 찾는다). Context Provider 안쪽에서도 동작하지만
 *  memo 컴포넌트가 useContext 로 읽는 값이 바뀌면 다시 그려지지 않으므로, 그런 컴포넌트는 memo 로 감싸지 않는다.
 *  props 에 매번 새 함수(onClick: () => …)를 넘기면 항상 달라 보이므로 useCallback 과 함께 쓴다.
 */
export function memo(fn, areEqual = shallowEqualProps) {
  const wrapped = (props) => fn(props);
  wrapped.__memo = { fn, areEqual };
  Object.defineProperty(wrapped, 'name', { value: `memo(${fn.name || '익명'})` });
  return wrapped;
}

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function normalizeRoot(out) {
  if (out == null) return createText('');
  if (Array.isArray(out)) {
    if (out.length === 1) return out[0];
    if (out.length === 0) return createText('');
    throw new Error('루트 컴포넌트는 하나의 루트 엘리먼트를 반환해야 합니다.');
  }
  return out;
}

// ------------------------------------------------------------------
// Hooks
// ------------------------------------------------------------------

function getHookSlot(kind) {
  if (!currentComponent) {
    throw new Error(`${kind} 는 함수형 컴포넌트가 렌더링되는 중에만 호출할 수 있습니다.`);
  }
  if (childDepth > 0) {
    throw new Error(
      `${kind} 는 최상위(루트) 컴포넌트에서만 사용할 수 있습니다. ` +
        '자식 컴포넌트는 상태 없이 props 만 사용하는 순수 함수여야 합니다. (Lifting State Up)'
    );
  }
  const comp = currentComponent;
  const index = comp.hookIndex++;
  const hook = comp.hooks[index];
  if (hook && hook.kind !== kind) {
    throw new Error(`Hook 호출 순서가 바뀌었습니다: ${index}번째 Hook 이 ${hook.kind} → ${kind}`);
  }
  return { comp, index, hook };
}

export function depsChanged(prev, next) {
  if (next === undefined || prev === undefined) return true; // 의존성 배열 없음 → 매번
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (!Object.is(prev[i], next[i])) return true;
  return false;
}

/**
 * useState(initial)
 *  - hooks[i] 에 { value } 를 저장해 렌더 간 값을 유지
 *  - initial 이 함수면 최초 1회만 호출 (lazy initialization)
 *  - setState(value | prev => next)
 *      1) 값 갱신  2) 같은 값이면 무시(bail-out)  3) 리렌더 예약(batching)
 *  - setState 함수는 렌더가 반복돼도 같은 참조를 유지한다.
 */
export function useState(initial) {
  const { comp, index, hook } = getHookSlot('useState');
  if (hook) return [hook.value, hook.setState];

  const slot = {
    kind: 'useState',
    value: typeof initial === 'function' ? initial() : initial,
    setState: null,
  };
  slot.setState = (action) => {
    if (comp.isUnmounted) {
      warn('언마운트된 컴포넌트에서 setState 가 호출되었습니다. 타이머나 구독을 effect cleanup 에서 정리했는지 확인하세요.');
      return;
    }
    const next = typeof action === 'function' ? action(slot.value) : action;
    if (Object.is(next, slot.value)) return;
    slot.value = next;
    comp.scheduleUpdate({ index, kind: 'useState' });
  };
  comp.hooks[index] = slot;
  return [slot.value, slot.setState];
}

/** useReducer(reducer, initialArg, init?) — useState 의 일반화 */
export function useReducer(reducer, initialArg, init) {
  const { comp, index, hook } = getHookSlot('useReducer');
  if (hook) {
    hook.reducer = reducer;
    return [hook.value, hook.dispatch];
  }
  const slot = { kind: 'useReducer', value: init ? init(initialArg) : initialArg, reducer, dispatch: null };
  slot.dispatch = (action) => {
    if (comp.isUnmounted) return;
    const next = slot.reducer(slot.value, action);
    if (Object.is(next, slot.value)) return;
    slot.value = next;
    comp.scheduleUpdate({ index, kind: 'useReducer', action: action?.type });
  };
  comp.hooks[index] = slot;
  return [slot.value, slot.dispatch];
}

function effectHook(kind, phase, effect, deps) {
  const { comp, index, hook } = getHookSlot(kind);
  const slot = hook ?? (comp.hooks[index] = { kind, deps: undefined, cleanup: null, ran: false });
  if (!slot.ran || depsChanged(slot.deps, deps)) {
    slot.deps = deps;
    slot.ran = true;
    comp.renderEffects[phase].push({ slot, effect });
  }
}

/**
 * useEffect(effect, deps)
 *  - 렌더 중에는 실행하지 않고 "예약" 만 한다. 브라우저가 화면을 그린 뒤 실행된다.
 *  - deps 가 바뀐 경우에만 실행. 실행 전 이전 effect 의 cleanup 을 먼저 호출.
 *  - deps 생략 → 매 렌더 실행, [] → 마운트 시 1회 (cleanup 은 언마운트 시)
 */
export function useEffect(effect, deps) {
  effectHook('useEffect', 'passive', effect, deps);
}

/**
 * useLayoutEffect(effect, deps)
 *  - useEffect 와 같지만, DOM 반영 직후 "그리기 전에" 동기로 실행된다.
 *  - 요소 크기를 재서 위치를 정하는 등, 사용자에게 중간 상태가 보이면 안 될 때만 쓴다.
 */
export function useLayoutEffect(effect, deps) {
  effectHook('useLayoutEffect', 'layout', effect, deps);
}

/**
 * useMemo(factory, deps)
 *  - deps 가 같으면 이전 계산 결과를 그대로 반환 (비싼 계산 / 참조 동일성 유지)
 *  - VNode 를 memo 하면 diff 가 같은 참조를 만나 하위 트리 비교 자체를 건너뛴다.
 */
export function useMemo(factory, deps) {
  const { comp, index, hook } = getHookSlot('useMemo');
  if (hook && !depsChanged(hook.deps, deps)) return hook.value;
  const value = factory();
  comp.hooks[index] = { kind: 'useMemo', value, deps };
  return value;
}

/** useCallback(fn, deps) = useMemo(() => fn, deps) */
export function useCallback(fn, deps) {
  const { comp, index, hook } = getHookSlot('useCallback');
  if (hook && !depsChanged(hook.deps, deps)) return hook.value;
  comp.hooks[index] = { kind: 'useCallback', value: fn, deps };
  return fn;
}

/** useRef(initial) — 렌더 간 유지되지만 바뀌어도 리렌더를 일으키지 않는 상자 */
export function useRef(initial) {
  const { comp, index, hook } = getHookSlot('useRef');
  if (hook) return hook.value;
  const value = { current: initial };
  comp.hooks[index] = { kind: 'useRef', value };
  return value;
}

// ------------------------------------------------------------------
// Context
// ------------------------------------------------------------------

/**
 * createContext(defaultValue)
 *   const Theme = createContext('light');
 *   h(Theme.Provider, { value: 'dark' }, h(Page))      // 감싼 범위 안에서는 'dark'
 *   function Button() { const theme = useContext(Theme); ... }
 */
export function createContext(defaultValue) {
  const ctx = { defaultValue, Provider: null };
  function Provider() {
    throw new Error('Provider 는 resolve 단계에서 처리됩니다.');
  }
  Provider.__context = ctx;
  ctx.Provider = Provider;
  return ctx;
}

/**
 * useContext(ctx): 가장 가까운 Provider 의 value, 없으면 기본값.
 * hooks 배열에 슬롯을 만들지 않는 "읽기" 이므로 자식 컴포넌트에서도 사용할 수 있다.
 */
export function useContext(ctx) {
  if (!currentComponent) throw new Error('useContext 는 렌더링 중에만 호출할 수 있습니다.');
  for (let i = contextStack.length - 1; i >= 0; i--) {
    if (contextStack[i][0] === ctx) return contextStack[i][1];
  }
  return ctx.defaultValue;
}
