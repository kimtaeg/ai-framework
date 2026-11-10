// 테스트 영역의 HTML 편집기(textarea)용: HTML 문자열 ↔ VNode

import { domToVNode } from '../core/vdom.js';

// 닫는 태그가 없는 요소
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INDENT = '  ';

// HTML 문자열 → 루트 VNode 하나. 브라우저 파서(<template>)로 읽고 domToVNode로 바꾼다.
export function parseHTML(source) {
  if (source.trim() === '') throw new Error('입력이 비어 있습니다. 루트 요소 하나를 입력하세요.');

  const template = document.createElement('template');
  template.innerHTML = source;
  const roots = [...template.content.childNodes].map(domToVNode).filter((vnode) => vnode !== null);

  if (roots.length === 0) throw new Error('요소가 없습니다. 루트 요소 하나를 입력하세요.');
  if (roots.length > 1) throw new Error(`루트 요소는 하나여야 합니다. (지금 ${roots.length}개)`);
  if (typeof roots[0] === 'string') throw new Error('루트는 텍스트가 아니라 요소여야 합니다.');
  return roots[0];
}

// VNode → 보기 좋게 들여쓴 HTML. 텍스트가 섞인 요소는 한 줄로 써서, 다시 읽어도 공백이 바뀌지 않게 한다.
export function toHTML(vnode, depth = 0) {
  const pad = INDENT.repeat(depth);
  if (typeof vnode === 'string' || VOID_TAGS.has(vnode.type)) return pad + toInlineHTML(vnode);

  const hasText = vnode.children.some((child) => typeof child === 'string');
  if (hasText || vnode.children.length === 0) return pad + toInlineHTML(vnode);

  const inner = vnode.children.map((child) => toHTML(child, depth + 1)).join('\n');
  return `${pad}${openTag(vnode)}\n${inner}\n${pad}</${vnode.type}>`;
}

function toInlineHTML(vnode) {
  if (typeof vnode === 'string') return escapeText(vnode);
  if (VOID_TAGS.has(vnode.type)) return openTag(vnode);
  return `${openTag(vnode)}${vnode.children.map(toInlineHTML).join('')}</${vnode.type}>`;
}

function openTag(vnode) {
  const attrs = Object.entries(vnode.props)
    .filter(([, value]) => typeof value !== 'function' && value !== false && value !== null && value !== undefined)
    .map(([name, value]) => (value === '' || value === true ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`))
    .join('');
  return `<${vnode.type}${attrs}>`;
}

const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
