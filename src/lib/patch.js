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
  const finder = new PathFinder(root);
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    // 같은 부모에 MOVE · INSERT 가 여러 개 이어지면 한꺼번에 처리한다 (섞기 · 뒤집기)
    if (p.type === PatchType.MOVE || p.type === PatchType.INSERT) {
      let j = i + 1;
      while (j < patches.length && (patches[j].type === PatchType.MOVE || patches[j].type === PatchType.INSERT) && samePath(patches[j].path, p.path)) j++;
      if (j - i >= RUN_MIN) {
        applyRun(finder.find(p.path), patches, i, j, onApply);
        finder.changedChildrenOf(p.path.length);
        i = j - 1;
        continue;
      }
    }
    const node = applyAt(finder, p);
    if (p.path.length === 0 && p.type === PatchType.REPLACE) {
      root = node;
      finder.reset(node);
    }
    onApply?.(p, node);
  }
  return root;
}

/**
 * 경로 → DOM 노드 찾기 (앞 패치의 경로를 기억해 공통 앞부분은 다시 내려가지 않는다)
 *  패치는 깊이 우선 순서로 만들어지므로 이어진 패치끼리 경로 앞부분이 겹치는 경우가 많다.
 *  nodes[d] = 경로의 앞 d 칸을 따라간 노드. 구조가 바뀐 깊이부터 아래는 다시 찾는다.
 */
class PathFinder {
  constructor(root) {
    this.reset(root);
  }

  reset(root) {
    this.path = [];
    this.nodes = [root];
    this.valid = 0; // nodes[0 .. valid] 가 믿을 수 있는 노드
  }

  find(path) {
    let d = 0;
    const limit = Math.min(path.length, this.valid, this.path.length);
    while (d < limit && this.path[d] === path[d]) d++;
    let node = this.nodes[d];
    for (let k = d; k < path.length; k++) {
      node = node?.childNodes[path[k]];
      if (!node) throw new Error(`patch: 경로 [${path.join(', ')}] 에 해당하는 DOM 노드가 없습니다.`);
      this.nodes[k + 1] = node;
    }
    this.path = path;
    this.valid = path.length;
    return node;
  }

  /** depth 깊이의 노드의 자식 목록이 바뀜 → 그 아래로 기억한 노드는 버린다 */
  changedChildrenOf(depth) {
    if (this.valid > depth) this.valid = depth;
  }
}

/** 패치 하나 적용 (경로 찾기는 PathFinder 로) */
function applyAt(finder, p) {
  switch (p.type) {
    case PatchType.INSERT:
    case PatchType.REMOVE:
    case PatchType.MOVE: {
      const parent = finder.find(p.path);
      const node = applyToParent(parent, p);
      finder.changedChildrenOf(p.path.length);
      return node;
    }
    case PatchType.REPLACE: {
      const node = applyToTarget(finder.find(p.path), p);
      finder.changedChildrenOf(p.path.length - 1); // 대상 자리에 다른 노드가 들어갔다
      return node;
    }
    default:
      return applyToTarget(finder.find(p.path), p);
  }
}

const RUN_MIN = 8;
const samePath = (a, b) => a === b || (a.length === b.length && a.every((v, k) => v === b[k]));

/**
 * 같은 부모에 이어진 MOVE · INSERT 묶음 적용.
 *  parent.childNodes[i] 는 DOM 이 바뀔 때마다 브라우저 내부 캐시가 무효가 되어, 무작위 위치를 찾을 때마다 앞에서부터 세게 된다
 *  (섞기처럼 이동이 많으면 이동 수 × 형제 수). 형제 목록을 JS 배열로 한 번만 만들어 두고 배열에서 찾는다.
 *  패치의 인덱스 의미는 하나씩 적용할 때와 같다 (MOVE 의 to 는 뺀 뒤 기준).
 */
function applyRun(parent, patches, i, j, onApply) {
  const kids = Array.from(parent.childNodes);
  for (let k = i; k < j; k++) {
    const p = patches[k];
    let node;
    if (p.type === PatchType.MOVE) {
      node = kids[p.from];
      kids.splice(p.from, 1);
      const ref = kids[p.to] ?? null;
      kids.splice(p.to, 0, node);
      moveNode(parent, node, ref);
    } else {
      node = createElement(p.node, childNamespace(parent));
      parent.insertBefore(node, kids[p.index] ?? null);
      kids.splice(p.index, 0, node);
    }
    onApply?.(p, node);
  }
}

/**
 * 이미 붙어 있는 노드를 같은 부모 안에서 옮긴다.
 *  insertBefore 로 옮기면 노드를 한 번 떼었다 붙이므로, 그 안에서 입력 중이던 칸의 포커스 · 커서 · 선택 영역이 풀린다.
 *  moveBefore (Chrome 133+) 가 있으면 그걸 쓴다 — 떼지 않고 옮겨서 포커스 · 애니메이션 · iframe 상태가 그대로다.
 *  없거나 (다른 브라우저 · jsdom) 쓸 수 없는 상황(부모가 문서에 안 붙음 등)이면 insertBefore 로 한다.
 */
export function moveNode(parent, node, ref) {
  if (typeof parent.moveBefore === 'function' && parent.isConnected) {
    try {
      parent.moveBefore(node, ref);
      return;
    } catch {
      // 아래 insertBefore 로
    }
  }
  parent.insertBefore(node, ref);
}

export function applyPatch(root, p) {
  if (p.type === PatchType.INSERT || p.type === PatchType.REMOVE || p.type === PatchType.MOVE) return applyToParent(resolvePath(root, p.path), p);
  return applyToTarget(resolvePath(root, p.path), p);
}

/** 대상 노드 자신을 바꾸는 패치: REPLACE · TEXT · PROPS */
function applyToTarget(target, p) {
  switch (p.type) {
    case PatchType.REPLACE: {
      if (p.node == null) {
        target.remove();
        return null;
      }
      const el = createElement(p.node, childNamespace(target.parentNode));
      if (target.parentNode) target.parentNode.replaceChild(el, target);
      return el;
    }
    case PatchType.TEXT:
      target.nodeValue = p.text;
      return target;
    case PatchType.PROPS:
      for (const { name, value, oldValue } of p.changes) setProp(target, name, value, oldValue);
      return target;
    default:
      throw new Error(`patch: 알 수 없는 패치 타입 ${p.type}`);
  }
}

/** 부모의 자식 목록을 바꾸는 패치: INSERT · REMOVE · MOVE */
function applyToParent(parent, p) {
  switch (p.type) {
    case PatchType.INSERT: {
      const el = createElement(p.node, childNamespace(parent));
      parent.insertBefore(el, parent.childNodes[p.index] ?? null);
      return el;
    }
    case PatchType.REMOVE: {
      const child = parent.childNodes[p.index];
      if (child) parent.removeChild(child);
      return parent;
    }
    case PatchType.MOVE: {
      const child = parent.childNodes[p.from];
      // p.to 는 "뺀 뒤" 의 인덱스이므로, 뒤로 옮길 때(from < to)는 빼기 전 기준으로 한 칸 뒤의 노드 앞에 넣는다.
      const ref = parent.childNodes[p.from < p.to ? p.to + 1 : p.to] ?? null;
      if (ref !== child) moveNode(parent, child, ref); // removeChild 없이 한 번 (DOM 호출 2번 → 1번)
      return child;
    }
    default:
      throw new Error(`patch: 알 수 없는 패치 타입 ${p.type}`);
  }
}

/**
 * 패치를 실제 DOM 이 아니라 VNode 트리에 적용한다 → 새 VNode 트리 (원래 트리는 바꾸지 않음).
 *  델타 히스토리(history.js)가 저장해 둔 패치만으로 과거 · 미래의 VNode 를 다시 만들 때 쓴다.
 *  바뀌는 경로의 노드만 복사하고 나머지 하위 트리는 원래 트리와 공유한다 (copy-on-write).
 *  패치 의미는 applyPatches 와 같다: 앞에서부터 순서대로, path 는 루트에서의 자식 인덱스.
 */
export function applyPatchesToVNode(root, patches) {
  if (!patches.length) return root;
  const fresh = new WeakSet(); // 이번 호출에서 새로 복사한 노드 (다시 복사하지 않음)
  const own = (n) => {
    if (fresh.has(n)) return n;
    const c = { ...n, children: n.children.slice() };
    fresh.add(c);
    return c;
  };
  for (const p of patches) {
    if (p.type === PatchType.REPLACE && p.path.length === 0) {
      root = p.node ?? null; // 루트 교체 (교체된 노드는 원본이 아니므로 복사 대상이 아니다)
      continue;
    }
    const structural = p.type === PatchType.INSERT || p.type === PatchType.REMOVE || p.type === PatchType.MOVE;
    if (!structural && p.path.length === 0) {
      // 루트 자신의 글자 · 속성
      if (p.type === PatchType.TEXT) root = { ...root, text: p.text };
      else if (p.type === PatchType.PROPS) root = withProps(own(root), p.changes);
      else throw new Error(`applyPatchesToVNode: 알 수 없는 패치 타입 ${p.type}`);
      continue;
    }
    root = own(root);
    // 대상(또는 대상의 부모)까지 내려가며 복사
    const depth = structural ? p.path.length : p.path.length - 1; // INSERT · REMOVE · MOVE 의 path 는 부모
    let node = root;
    for (let d = 0; d < depth; d++) {
      const i = p.path[d];
      node.children[i] = own(node.children[i]);
      node = node.children[i];
    }
    switch (p.type) {
      case PatchType.INSERT:
        node.children.splice(p.index, 0, p.node);
        break;
      case PatchType.REMOVE:
        node.children.splice(p.index, 1);
        break;
      case PatchType.MOVE: {
        const [moved] = node.children.splice(p.from, 1);
        node.children.splice(p.to, 0, moved);
        break;
      }
      case PatchType.REPLACE: {
        const i = p.path[p.path.length - 1];
        if (p.node == null) node.children.splice(i, 1);
        else node.children[i] = p.node;
        break;
      }
      case PatchType.TEXT: {
        const i = p.path[p.path.length - 1];
        node.children[i] = { ...node.children[i], text: p.text };
        break;
      }
      case PatchType.PROPS: {
        const i = p.path[p.path.length - 1];
        node.children[i] = withProps(own(node.children[i]), p.changes);
        break;
      }
      default:
        throw new Error(`applyPatchesToVNode: 알 수 없는 패치 타입 ${p.type}`);
    }
  }
  return root;
}

function withProps(node, changes) {
  const props = { ...node.props };
  for (const { name, value } of changes) {
    if (value === undefined) delete props[name];
    else props[name] = value;
  }
  node.props = props;
  return node;
}
