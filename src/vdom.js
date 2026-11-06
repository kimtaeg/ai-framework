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
      .filter((c) => c !== null && c !== undefined && c !== false)
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
  const inSvg = isSvg || vnode.type === 'svg';
  const el = inSvg ? document.createElementNS(SVG_NS, vnode.type) : document.createElement(vnode.type);
  for (const child of vnode.children) {
    el.appendChild(render(child, inSvg && vnode.type !== 'foreignObject'));
  }
  // 자식 다음에 props를 넣는다: <select value>는 <option>이 있어야 반영된다
  for (const [key, value] of Object.entries(vnode.props)) {
    setProp(el, key, value);
  }
  return el;
}
