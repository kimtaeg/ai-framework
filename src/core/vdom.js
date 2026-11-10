// Virtual DOM의 기본 단위(VNode)와 VNode ↔ 실제 DOM 변환.
//
// VNode 모양
//   요소:   { type: 'li', key: 'a' | null, props: { class: 'item', onClick: fn }, children: [VNode, ...] }
//   텍스트: 그냥 문자열 '빨래'
//
// key는 리스트에서 "같은 항목"을 알아보는 이름표다. props에 넣지 않고 따로 두어
// DOM 속성으로 그려지지 않게 한다. (HTML에서는 data-key="a"로 쓰고 domToVNode가 key로 읽는다)

import { setProp } from './props.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// 줄바꿈이 섞인 공백만 있는 텍스트는 HTML 들여쓰기라서 버린다 (JSX와 같은 규칙).
// 같은 줄의 공백(<b>a</b> <i>b</i>)은 화면에 보이는 내용이므로 남긴다.
const INDENT_WHITESPACE = /^[ \t\r\f]*\n[ \t\r\n\f]*$/;

// JSX 대신 쓰는 VNode 생성 함수: h('li', { key: 'a' }, '빨래')
export function h(type, props, ...children) {
  const { key = null, ...rest } = props ?? {};
  return {
    type,
    key: key === null ? null : String(key),
    props: rest,
    children: children
      .flat(Infinity)
      // cond && h(...) 처럼 쓰면 false가 섞이므로 그리지 않을 값은 버린다 (JSX와 같은 규칙)
      .filter((child) => child !== null && child !== undefined && typeof child !== 'boolean')
      .map((child) => (typeof child === 'number' ? String(child) : child)),
  };
}

// VNode → 실제 DOM 노드 (처음 그릴 때와 CREATE·REPLACE patch에서 쓴다)
export function createElement(vnode) {
  if (typeof vnode === 'string') return document.createTextNode(vnode);

  const el = document.createElement(vnode.type);
  // 자식을 먼저 붙이고 속성을 넣는다: <select value="b">는 <option>이 있어야 선택이 맞는다
  for (const child of vnode.children) el.appendChild(createElement(child));
  for (const [key, value] of Object.entries(vnode.props)) setProp(el, key, value);
  return el;
}

// 실제 DOM 노드 → VNode. 버릴 노드(주석, 들여쓰기 공백)는 null.
export function domToVNode(node) {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent;
    return text === '' || INDENT_WHITESPACE.test(text) ? null : text;
  }
  if (node.nodeType !== ELEMENT_NODE) return null; // 주석(8) 등은 화면을 만들지 않으므로 무시

  const props = {};
  for (const { name, value } of node.attributes) props[name] = value;

  const children = [];
  for (const child of node.childNodes) {
    const vchild = domToVNode(child);
    if (vchild !== null) children.push(vchild);
  }

  return {
    type: node.localName, // HTML은 소문자로 온다
    key: node.getAttribute('data-key'), // 없으면 null
    props,
    children,
  };
}
