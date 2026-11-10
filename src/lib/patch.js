/**
 * Patch
 * ------------------------------------------------------------------
 * diff() 가 만든 patches 를 실제 DOM 에 순서대로 적용한다.
 * 바뀐 노드에만 DOM API 를 호출하므로 Reflow / Repaint 범위가 최소화된다.
 *
 * path 해석: root 에서 시작해 childNodes[i] 를 따라 내려간다. (path [] = root 자신)
 */

import { createElement, childNamespace, setProp } from './vdom.js';
import { PatchType } from './diff.js';

export function resolvePath(root, path) {
  let node = root;
  for (const i of path) {
    node = node?.childNodes[i];
    if (!node) throw new Error(`patch: 경로 [${path.join(', ')}] 에 해당하는 DOM 노드가 없습니다.`);
  }
  return node;
}

/**
 * @param {Node} root   diff 의 루트 VNode 에 대응하는 실제 DOM 노드
 * @param {Array} patches
 * @param {object} [options]
 * @param {(patch, node) => void} [options.onApply] 적용 직후 콜백 (하이라이트 등 시각화용)
 * @returns {Node|null} 루트가 교체되었을 수 있으므로 새 루트를 반환
 */
export function applyPatches(root, patches, options = {}) {
  const { onApply } = options;
  for (const p of patches) {
    const node = applyPatch(root, p);
    if (p.path.length === 0 && p.type === PatchType.REPLACE) root = node;
    onApply?.(p, node);
  }
  return root;
}

export function applyPatch(root, p) {
  switch (p.type) {
    case PatchType.REPLACE: {
      const target = resolvePath(root, p.path);
      if (p.node == null) {
        target.remove();
        return null;
      }
      const el = createElement(p.node, childNamespace(target.parentNode));
      if (target.parentNode) target.parentNode.replaceChild(el, target);
      return el;
    }
    case PatchType.TEXT: {
      const target = resolvePath(root, p.path);
      target.nodeValue = p.text;
      return target;
    }
    case PatchType.PROPS: {
      const target = resolvePath(root, p.path);
      for (const { name, value, oldValue } of p.changes) setProp(target, name, value, oldValue);
      return target;
    }
    case PatchType.INSERT: {
      const parent = resolvePath(root, p.path);
      const el = createElement(p.node, childNamespace(parent));
      parent.insertBefore(el, parent.childNodes[p.index] ?? null);
      return el;
    }
    case PatchType.REMOVE: {
      const parent = resolvePath(root, p.path);
      const child = parent.childNodes[p.index];
      if (child) parent.removeChild(child);
      return parent;
    }
    case PatchType.MOVE: {
      const parent = resolvePath(root, p.path);
      const child = parent.childNodes[p.from];
      // insertBefore 는 이미 붙어 있는 노드를 알아서 떼어 옮긴다 → removeChild 를 따로 부르지 않는다 (DOM 호출 2번 → 1번).
      // p.to 는 "뺀 뒤" 의 인덱스이므로, 뒤로 옮길 때(from < to)는 빼기 전 기준으로 한 칸 뒤의 노드 앞에 넣는다.
      const ref = parent.childNodes[p.from < p.to ? p.to + 1 : p.to] ?? null;
      if (ref !== child) parent.insertBefore(child, ref);
      return child;
    }
    default:
      throw new Error(`patch: 알 수 없는 패치 타입 ${p.type}`);
  }
}
