// 두 VNode를 비교해 patch 목록을 만들고(diff), 실제 DOM에 반영한다(patch).
//
// patch 모양: { type, path, ... }
//   path: 루트에서 자식 인덱스를 따라간 경로. [] = 루트, [2, 0] = 루트의 2번째 자식의 0번째 자식
//
// 자식 비교는 인덱스 기준이다. (key 기반 비교는 나중 단계)
//   - 공통 길이까지는 같은 인덱스끼리 재귀 비교
//   - 새 쪽이 길면 뒤에 CREATE, 옛 쪽이 길면 뒤에서부터 REMOVE
//   → 앞쪽 인덱스는 바뀌지 않으므로 path를 순서대로 적용해도 어긋나지 않는다.

import { render, isSvgContext } from './vdom.js';
import { updateProps } from './props.js';

export const CREATE = 'CREATE';
export const REMOVE = 'REMOVE';
export const REPLACE = 'REPLACE';
export const TEXT = 'TEXT';
export const PROPS = 'PROPS';

export function diff(oldVNode, newVNode) {
  const patches = [];
  walk(oldVNode, newVNode, [], patches);
  return patches;
}

function walk(oldVNode, newVNode, path, patches) {
  if (oldVNode === undefined) {
    patches.push({ type: CREATE, path, vnode: newVNode });
    return;
  }
  if (newVNode === undefined) {
    patches.push({ type: REMOVE, path, vnode: oldVNode });
    return;
  }

  const isOldText = typeof oldVNode === 'string';
  const isNewText = typeof newVNode === 'string';
  if (isOldText && isNewText) {
    if (oldVNode !== newVNode) patches.push({ type: TEXT, path, from: oldVNode, to: newVNode });
    return;
  }
  if (isOldText || isNewText || oldVNode.type !== newVNode.type) {
    patches.push({ type: REPLACE, path, from: oldVNode, vnode: newVNode });
    return;
  }

  const changes = diffProps(oldVNode.props, newVNode.props);
  if (changes.length > 0) {
    patches.push({ type: PROPS, path, oldProps: oldVNode.props, newProps: newVNode.props, changes });
  }

  const oldChildren = oldVNode.children;
  const newChildren = newVNode.children;
  const common = Math.min(oldChildren.length, newChildren.length);
  for (let i = 0; i < common; i++) {
    walk(oldChildren[i], newChildren[i], [...path, i], patches);
  }
  for (let i = common; i < newChildren.length; i++) {
    walk(undefined, newChildren[i], [...path, i], patches);
  }
  for (let i = oldChildren.length - 1; i >= common; i--) {
    walk(oldChildren[i], undefined, [...path, i], patches);
  }
}

// [{ key, from, to }] — from이 undefined면 추가, to가 undefined면 삭제
function diffProps(oldProps, newProps) {
  const changes = [];
  for (const [key, value] of Object.entries(newProps)) {
    if (oldProps[key] !== value) changes.push({ key, from: oldProps[key], to: value });
  }
  for (const [key, value] of Object.entries(oldProps)) {
    if (!(key in newProps)) changes.push({ key, from: value, to: undefined });
  }
  return changes;
}

// container의 첫 자식이 루트 VNode에 해당하는 DOM이어야 한다
export function patch(container, patches) {
  for (const p of patches) applyPatch(container, p);
}

// 실제 DOM이 patch 밖에서 바뀌어 VNode와 어긋났으면 경로를 따라갈 수 없다 → 명확한 에러로 알린다
function nodeAt(container, path) {
  let node = container.firstChild;
  for (const i of path) {
    node = node?.childNodes[i];
  }
  if (!node) throw new Error(`실제 DOM에서 경로 [${path.join(', ')}]의 노드를 찾을 수 없습니다.`);
  return node;
}

function applyPatch(container, p) {
  switch (p.type) {
    case CREATE: {
      const parent = p.path.length === 0 ? container : nodeAt(container, p.path.slice(0, -1));
      const index = p.path.length === 0 ? 0 : p.path[p.path.length - 1];
      parent.insertBefore(render(p.vnode, isSvgContext(parent)), parent.childNodes[index] ?? null);
      break;
    }
    case REMOVE:
      nodeAt(container, p.path).remove();
      break;
    case REPLACE: {
      const node = nodeAt(container, p.path);
      node.replaceWith(render(p.vnode, isSvgContext(node.parentNode)));
      break;
    }
    case TEXT:
      nodeAt(container, p.path).nodeValue = p.to;
      break;
    case PROPS:
      updateProps(nodeAt(container, p.path), p.oldProps, p.newProps);
      break;
    default:
      throw new Error(`알 수 없는 patch 종류: ${p.type}`);
  }
}
