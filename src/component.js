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
import { runRender } from './hooks.js';

export function expand(vnode) {
  // 루트 함수가 null·false를 돌려준 경우도 같은 에러로 알린다
  const isEmpty = vnode === null || vnode === undefined || typeof vnode === 'boolean';
  const result = isEmpty ? null : expandNode(vnode);
  if (result === null) {
    throw new Error('루트 컴포넌트가 아무것도 돌려주지 않았습니다. 화면에 그릴 요소가 하나는 있어야 합니다.');
  }
  return result;
}

// 펼친 결과가 비었으면(null) 부모의 자식 목록에서 빠진다
function expandNode(vnode) {
  if (typeof vnode === 'string') return vnode;

  if (typeof vnode.type === 'function') {
    const component = vnode.type;
    // 자식 컴포넌트는 props만 받는 순수 함수다. 태그 안에 쓴 자식은 props.children으로 넘긴다.
    const output = component({ ...vnode.props, children: vnode.children });
    const normalized = normalizeOutput(output, component);
    // 컴포넌트가 또 컴포넌트를 돌려줘도 태그가 나올 때까지 계속 펼친다
    return normalized === null ? null : expandNode(normalized);
  }

  return {
    type: vnode.type,
    props: vnode.props,
    children: vnode.children.map(expandNode).filter((child) => child !== null),
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
//   mount  : hookIndex = 0 → fn 실행 → expand → render → prevVNode 저장
//   update : hookIndex = 0 → fn 다시 실행 → expand → diff(prevVNode, next) → patch → prevVNode 교체
//
// hooks 배열은 인스턴스에 있으므로 fn이 몇 번을 다시 실행돼도 상태가 유지된다.
export class FunctionComponent {
  constructor(fn, container) {
    this.fn = fn;
    this.container = container;
    this.hooks = []; // useState 등이 호출 순서대로 칸을 차지하는 사물함
    this.hookIndex = 0; // 이번 렌더에서 다음에 열 사물함 번호
    this.prevVNode = null; // 마지막으로 화면에 반영한 VDOM (다음 diff의 기준)
    this.isUpdateScheduled = false;
  }

  mount() {
    const vnode = this.renderVNode();
    this.container.replaceChildren(render(vnode));
    this.prevVNode = vnode;
    return this;
  }

  update() {
    this.isUpdateScheduled = false;
    const nextVNode = this.renderVNode();
    const patches = diff(this.prevVNode, nextVNode);
    patch(this.container, patches);
    this.prevVNode = nextVNode;
    return patches;
  }

  // setState가 여러 번 불려도 지금 실행 중인 코드(이벤트 핸들러 등)가 끝난 직후 한 번만 다시 그린다
  scheduleUpdate() {
    if (this.isUpdateScheduled) return;
    this.isUpdateScheduled = true;
    queueMicrotask(() => this.update());
  }

  renderVNode() {
    // 매 렌더 첫 번째 Hook이 0번 사물함을 열도록 되돌린다. 호출 순서가 곧 사물함 번호다.
    this.hookIndex = 0;
    return runRender(this, () => this.fn({}), expand);
  }
}
