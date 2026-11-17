/**
 * 이전 / 새 Virtual DOM 트리를 나란히 그리고, 패치가 닿은 노드에 표시를 한다.
 *
 * 패치 → 표시 규칙
 *   새 트리: INSERT / REPLACE 의 새 노드(객체 그대로), TEXT · PROPS 의 path(새 트리 기준 위치),
 *            MOVE 는 부모 path + key 로 찾는다.
 *   이전 트리: REMOVE 된 노드, REPLACE 로 버려진 노드 (객체 그대로)
 *
 * diff 는 자식 재귀를 "위치가 확정된 뒤의 새 인덱스" 로 하므로 TEXT · PROPS 의 path 는 새 트리의 위치와 같다.
 */
import { TEXT } from '../src/lib/vdom.js';
const pk = (path) => path.join('.');
const key = (path) => path.join('.');

export function computeMarks(patches) {
  const newObj = new Map(); // vnode → 'INSERT' | 'REPLACE'
  const oldObj = new Map(); // vnode → 'REMOVE' | 'REPLACE'
  const atPath = new Map(); // 'a.b' → 'TEXT' | 'PROPS'
  const moved = new Set(); // '부모path|key'
  for (const p of patches) {
    switch (p.type) {
      case 'INSERT': newObj.set(p.node, 'INSERT'); break;
      case 'REPLACE':
        if (p.node) newObj.set(p.node, 'REPLACE');
        if (p.oldNode) oldObj.set(p.oldNode, 'REPLACE');
        break;
      case 'REMOVE': oldObj.set(p.node, 'REMOVE'); break;
      case 'TEXT': atPath.set(pk(p.path), 'TEXT'); break;
      case 'PROPS': atPath.set(pk(p.path), atPath.get(pk(p.path)) === 'TEXT' ? 'TEXT' : 'PROPS'); break;
      case 'MOVE': moved.add(`${pk(p.path)}|${p.key}`); break;
      default: break;
    }
  }
  return { newObj, oldObj, atPath, moved };
}

/** 새 트리에서 노드의 표시 종류 */
export function markOfNew(v, path, marks) {
  if (marks.newObj.has(v)) return marks.newObj.get(v);
  const parent = pk(path.slice(0, -1));
  if (v.key != null && marks.moved.has(`${parent}|${v.key}`)) return 'MOVE';
  return marks.atPath.get(pk(path)) ?? null;
}

export function markOfOld(v, marks) {
  return marks.oldObj.get(v) ?? null;
}

function vtLabel(v) {
  if (v.type === TEXT) {
    const t = v.text.replace(/\s+/g, ' ');
    return `"${t.length > 22 ? t.slice(0, 22) + '…' : t}"`;
  }
  const attrs = Object.entries(v.props)
    .filter(([k]) => k !== 'key')
    .slice(0, 2)
    .map(([k, val]) => `${k}="${String(val).length > 12 ? String(val).slice(0, 12) + '…' : val}"`)
    .join(' ');
  return `<${v.type}${v.key != null ? ` key=${v.key}` : ''}${attrs ? ' ' + attrs : ''}>`;
}

/**
 * @param {object} root  VNode
 * @param {(v, path) => string|null} markFn
 * @param {boolean} [inherit] 표시된 노드의 자식도 같은 색으로 (새로 생긴/사라진 하위 트리)
 */
export function renderTree(root, markFn) {
  const walk = (v, path, inherited) => {
    const li = document.createElement('li');
    const own = markFn(v, path);
    const mark = own ?? inherited;
    const span = document.createElement('span');
    span.className = 'vt-node' + (v.type === TEXT ? ' vt-text' : '') + (mark ? ` vt-${mark}` : '');
    span.textContent = vtLabel(v);
    if (own) {
      const tag = document.createElement('em');
      tag.className = `vt-tag ${own}`;
      tag.textContent = own;
      span.append(tag);
    }
    li.append(span);
    if (v.children?.length) {
      const ul = document.createElement('ul');
      // 새로 생긴/사라진/교체된 하위 트리는 자식도 같은 색 (TEXT·PROPS·MOVE 는 그 노드만)
      const pass = own === 'INSERT' || own === 'REMOVE' || own === 'REPLACE' ? own : inherited === 'INSERT' || inherited === 'REMOVE' || inherited === 'REPLACE' ? inherited : null;
      v.children.forEach((c, i) => ul.append(walk(c, path.concat(i), pass)));
      li.append(ul);
    }
    return li;
  };
  const ul = document.createElement('ul');
  ul.className = 'vt';
  // 루트(컨테이너 div)는 보여주지 않고 자식부터
  root.children.forEach((c, i) => ul.append(walk(c, [i], null)));
  return ul;
}
