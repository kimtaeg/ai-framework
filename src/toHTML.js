// VNode → 보기 좋게 들여쓴 HTML 문자열 (textarea에 다시 넣는 용도)
// 텍스트가 섞인 요소는 한 줄로 써서, 다시 파싱했을 때 텍스트가 바뀌지 않게 한다.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);
const INDENT = '  ';

export function toHTML(vnode, depth = 0) {
  const pad = INDENT.repeat(depth);
  if (typeof vnode === 'string' || VOID_TAGS.has(vnode.type)) {
    return pad + toInlineHTML(vnode);
  }

  const hasText = vnode.children.some((c) => typeof c === 'string');
  if (hasText || vnode.children.length === 0) {
    return pad + toInlineHTML(vnode);
  }

  const inner = vnode.children.map((c) => toHTML(c, depth + 1)).join('\n');
  return `${pad}${openTag(vnode)}\n${inner}\n${pad}</${vnode.type}>`;
}

function toInlineHTML(vnode) {
  if (typeof vnode === 'string') return escapeText(vnode);
  if (VOID_TAGS.has(vnode.type)) return openTag(vnode);
  return `${openTag(vnode)}${vnode.children.map(toInlineHTML).join('')}</${vnode.type}>`;
}

function openTag(vnode) {
  const attrs = Object.entries(vnode.props)
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key, value]) => (value === '' || value === true ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`))
    .join('');
  return `<${vnode.type}${attrs}>`;
}

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
