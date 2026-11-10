// 함수형 컴포넌트를 펼치는 expand()와, 상태를 가진 루트 컴포넌트 하나를 그리고 다시 그리는 FunctionComponent.
//
// 컴포넌트 = "props(와 state)를 받아 VNode를 돌려주는 함수".
//   h(StatCard, { label: '방문자', value: 120 })는 실행하지 않고 { type: StatCard ƒ, ... }로 적어 두기만 하고,
//   expand()가 함수를 끝까지 실행해 태그만 남은 VNode로 펼친다. 그래서 diff·patch(src/core)는 컴포넌트를 전혀 몰라도 된다.

import { createElement } from './vdom.js';
import { diff } from './diff.js';
import { applyPatches } from './patch.js';
import { runRender, HOOK_ORDER_RULE } from './hooks.js';
import { scheduleUpdate, cancelUpdate } from './scheduler.js';

// ── expand: 컴포넌트 트리 → 태그만 남은 VNode ─────────────────

export function expand(vnode) {
  const isEmpty = vnode === null || vnode === undefined || typeof vnode === 'boolean';
  const result = isEmpty ? null : expandNode(vnode);
  if (result === null) throw new Error('루트 컴포넌트가 아무것도 돌려주지 않았습니다. 화면에 그릴 요소가 하나는 있어야 합니다.');
  return result;
}

// 펼친 결과가 비었으면(null) 부모의 자식 목록에서 빠진다
function expandNode(vnode) {
  if (typeof vnode === 'string') return vnode;

  if (typeof vnode.type === 'function') {
    const component = vnode.type;
    // 자식 컴포넌트는 props만 받는 순수 함수. 태그 안에 쓴 자식은 props.children으로 넘긴다
    const output = component({ ...vnode.props, children: vnode.children });
    const normalized = normalizeOutput(output, component);
    if (normalized === null) return null;
    const expanded = expandNode(normalized); // 컴포넌트가 또 컴포넌트를 돌려줘도 태그가 나올 때까지
    // h(Row, { key: id })처럼 컴포넌트에 준 key를 펼친 결과로 옮긴다 → 리스트 diff가 항목을 key로 알아본다
    if (vnode.key !== null && typeof expanded !== 'string' && expanded.key === null) return { ...expanded, key: vnode.key };
    return expanded;
  }

  return { ...vnode, children: vnode.children.map(expandNode).filter((child) => child !== null) };
}

function normalizeOutput(output, component) {
  const name = component.name || '익명 컴포넌트';
  if (output === undefined) throw new Error(`${name}가 undefined를 돌려줬습니다. return을 빠뜨리지 않았는지 확인하세요.`);
  if (Array.isArray(output)) throw new Error(`${name}가 배열을 돌려줬습니다. 여러 요소는 하나의 태그로 감싸 주세요.`);
  if (output === null || typeof output === 'boolean') return null;
  if (typeof output === 'number') return String(output);
  return output;
}

// ── FunctionComponent ───────────────────────────────────

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// options
//   batching   : true(기본) — 같은 틱의 setState를 모아 update 1번 / false — setState마다 바로 update (비교용)
//   renderMode : 'diff'(기본) — 바뀐 곳만 patch / 'full' — diff 없이 통째로 다시 그리기 (비교용)
//   onRender   : 렌더가 화면에 반영될 때마다 { type, renderCount, patches, counts, durationMs, batchSize, mode }
//   onPatch    : 바뀐 DOM 노드마다 (node, patch) — 하이라이트용. full 모드에서는 루트 노드 하나
export class FunctionComponent {
  constructor(fn, container, { batching = true, renderMode = 'diff', onRender, onPatch } = {}) {
    this.fn = fn; // 루트 컴포넌트 함수 (App)
    this.container = container; // 그릴 곳 (container.firstChild = 루트 DOM)
    this.hooks = []; // 사물함: Hook이 호출 순서대로 한 칸씩 차지한다. 인스턴스에 있으므로 렌더 사이에 남는다
    this.hookIndex = 0; // 이번 렌더에서 다음에 열 사물함 번호. 렌더마다 0으로 되돌린다
    this.vnode = null; // 마지막으로 화면에 반영한 VNode = 다음 diff의 기준
    this.pendingEffects = []; // 이번 렌더에서 실행하기로 한 effect (patch 뒤에 실행)
    this.isMounted = false;
    this.batching = batching;
    this.renderMode = renderMode;
    this.onRender = onRender;
    this.onPatch = onPatch;
    this.renderCount = 0;
    this.pendingSetStateCount = 0; // 다음 렌더에 합쳐질 setState 수
    this.lastBatchSize = 0;
    this.expectedHookCount = null; // 직전 렌더의 Hook 개수 (첫 렌더 전에는 null)
    this.mountGeneration = 0; // mount마다 1 증가. 옛 setState가 새로 mount된 트리를 건드리지 않게 구분한다
  }

  mount() {
    if (this.isMounted) throw new Error('이미 mount된 컴포넌트입니다. 다시 그리려면 unmount() 후 mount()하세요.');
    this.mountGeneration++;
    this.hooks = []; // mount는 항상 빈 사물함에서 시작
    this.expectedHookCount = null;
    const startedAt = now();
    const vnode = this.renderVNode();
    this.container.replaceChildren(createElement(vnode));
    this.vnode = vnode;
    this.isMounted = true;
    this.recordRender('mount', null, null, startedAt);
    this.runEffects(); // DOM이 붙은 뒤라 effect에서 실제 요소를 읽을 수 있다
    return this;
  }

  // update: hookIndex를 0으로 → App 다시 실행 → 새 VNode → 이전 VNode와 diff → patch → effect
  update() {
    if (!this.isMounted) return; // unmount 뒤 늦게 온 예약은 무시
    const startedAt = now();
    const nextVNode = this.renderVNode();

    let patches = null;
    let counts = null;
    if (this.renderMode === 'full') {
      // 비교용 "전체 다시 그리기": innerHTML처럼 전부 지우고 전부 새로 만든다.
      // (innerHTML에 문자열을 넣으면 이벤트 핸들러가 사라지므로, 같은 일을 createElement로 한다)
      this.container.replaceChildren(createElement(nextVNode));
      this.onPatch?.(this.container.firstChild, { type: 'FULL' });
    } else {
      patches = diff(this.vnode, nextVNode);
      counts = applyPatches(this.container, patches, { onApply: this.onPatch });
    }
    this.vnode = nextVNode;
    this.recordRender('update', patches, counts, startedAt);
    this.runEffects();
  }

  // setState가 부른다: 다시 그려 달라고 예약 (배칭이 켜져 있으면 같은 틱의 요청은 하나로 합쳐진다)
  requestUpdate() {
    if (!this.isMounted) return;
    this.pendingSetStateCount++;
    scheduleUpdate(this);
  }

  unmount() {
    if (!this.isMounted) return;
    this.isMounted = false;
    cancelUpdate(this);
    // effect가 열어 둔 타이머·구독을 닫는다 (선언 순서대로)
    for (const slot of this.hooks) if (typeof slot.cleanup === 'function') slot.cleanup();
    this.container.replaceChildren();
    this.hooks = [];
    this.vnode = null;
    this.pendingEffects = [];
    this.pendingSetStateCount = 0;
    this.expectedHookCount = null;
  }

  // 화면의 토글(비교 모드, 배칭)에서 실행 중에 바꾼다
  setOptions({ batching = this.batching, renderMode = this.renderMode } = {}) {
    this.batching = batching;
    this.renderMode = renderMode;
  }

  renderVNode() {
    // 매 렌더 첫 Hook이 0번 사물함을 열도록 되돌린다. "호출 순서 = 사물함 번호"가 상태 유지의 핵심
    this.hookIndex = 0;
    this.pendingEffects = []; // 이전 렌더가 실패해 남은 예약은 버린다
    const vnode = runRender(this, () => this.fn({}), expand);
    // Hook이 줄어든 경우는 여기서 잡는다 (늘어난 경우는 takeHookSlot이 바로 잡는다)
    if (this.expectedHookCount !== null && this.hookIndex !== this.expectedHookCount) {
      throw new Error(`Hook 개수가 이전 렌더(${this.expectedHookCount}개)와 다릅니다(이번 ${this.hookIndex}개). ${HOOK_ORDER_RULE}`);
    }
    this.expectedHookCount = this.hookIndex;
    return vnode;
  }

  // 다시 실행할 effect의 옛 cleanup을 먼저 모두 부른 뒤 새 effect를 실행한다 (A정리 → B정리 → A → B)
  runEffects() {
    const effects = this.pendingEffects;
    this.pendingEffects = [];
    for (const { slot } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = undefined;
    }
    for (const { slot, effect, deps } of effects) {
      slot.deps = deps;
      const cleanup = effect();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  recordRender(type, patches, counts, startedAt) {
    this.renderCount++;
    this.lastBatchSize = this.pendingSetStateCount;
    this.pendingSetStateCount = 0;
    this.onRender?.({
      type,
      mode: this.renderMode,
      renderCount: this.renderCount,
      batchSize: this.lastBatchSize,
      patches,
      counts,
      durationMs: now() - startedAt, // App 실행 + 펼치기 + diff + DOM 반영 (effect 제외)
    });
  }
}
