// VNode 모양
//   요소:   { type: 'div', props: { id: 'a' }, children: [VNode, ...] }
//   텍스트: 'hello' (그냥 문자열)

import { setProp } from './props.js';

export function h(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children
      .flat(Infinity)
      // JSX와 같은 규칙: null·undefined·true·false는 그리지 않는다 (cond && <x/>, cond || 'x')
      .filter((c) => c !== null && c !== undefined && typeof c !== 'boolean')
      .map((c) => (typeof c === 'number' ? String(c) : c)),
  };
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

// parent 안에 새로 만들 자식이 SVG 요소여야 하는지 (patch에서 부모 기준으로 판단할 때 사용)
export function isSvgContext(parent) {
  return parent?.namespaceURI === SVG_NS && parent.localName !== 'foreignObject';
}

// VNode → 실제 DOM 노드
// <svg> 안의 요소는 SVG 네임스페이스로 만들어야 화면에 그려진다 (foreignObject 안은 다시 HTML)
export function render(vnode, isSvg = false) {
  if (typeof vnode === 'string') {
    return document.createTextNode(vnode);
  }
  if (typeof vnode.type === 'function') {
    // createElement(함수)는 이상한 태그를 만들거나 에러가 나므로, 원인을 바로 알 수 있게 막는다
    throw new Error(`컴포넌트(${vnode.type.name || '익명'})는 expand()로 먼저 펼친 뒤 render하세요.`);
  }
  const isInSvg = isSvg || vnode.type === 'svg';
  const el = isInSvg ? document.createElementNS(SVG_NS, vnode.type) : document.createElement(vnode.type);
  for (const child of vnode.children) {
    el.appendChild(render(child, isInSvg && vnode.type !== 'foreignObject'));
  }
  // 자식 다음에 props를 넣는다: <select value>는 <option>이 있어야 반영된다
  for (const [key, value] of Object.entries(vnode.props)) {
    setProp(el, key, value);
  }
  return el;
}
