// 두 VNode 트리를 비교해 "실제 DOM에서 무엇을 바꿔야 하는지" patch 목록을 만든다.
// 이 함수는 DOM을 전혀 건드리지 않는다(순수 계산). 실제 반영은 patch.js의 applyPatches가 한다.
//
// patch 모양 — 경로(path)는 모두 "이전 트리" 기준의 자식 인덱스 배열이다. [] = 루트, [1, 0] = 루트의 1번 자식의 0번 자식
//   { type: 'CREATE',       parentPath, index, vnode }   index = 새 자식 목록에서 들어갈 위치
//   { type: 'REMOVE',       path }
//   { type: 'REPLACE',      path, vnode }
//   { type: 'UPDATE_PROPS', path, set: { 이름: 새값 }, remove: [이름] }
//   { type: 'UPDATE_TEXT',  path, text }
//   { type: 'MOVE',         parentPath, from, index, key }  from = 이전 위치, index = 새 위치
//
// 왜 이전 트리 기준인가: applyPatches가 DOM을 바꾸기 전에 모든 경로를 실제 노드로 먼저 찾아 두기 때문이다.
// 그러면 삭제·이동으로 인덱스가 밀려도 이미 찾아 둔 노드 참조는 그대로라 순서와 상관없이 정확히 적용된다.

import { styleToString } from './props.js';

export const CREATE = 'CREATE';
export const REMOVE = 'REMOVE';
export const REPLACE = 'REPLACE';
export const UPDATE_PROPS = 'UPDATE_PROPS';
export const UPDATE_TEXT = 'UPDATE_TEXT';
export const MOVE = 'MOVE';

export function diff(oldVNode, newVNode) {
  const patches = [];
  const context = { patches, warnedKeys: new Set() };

  // 루트가 없던 곳에 생기거나(처음 그리기) 사라지는 경우. CREATE의 parentPath가 null이면 "컨테이너 자체"다.
  if (oldVNode == null && newVNode == null) return patches;
  if (oldVNode == null) {
    patches.push({ type: CREATE, parentPath: null, index: 0, vnode: newVNode });
    return patches;
  }
  if (newVNode == null) {
    patches.push({ type: REMOVE, path: [] });
    return patches;
  }

  walk(oldVNode, newVNode, [], context);
  return patches;
}

const isText = (vnode) => typeof vnode === 'string';

function walk(oldVNode, newVNode, path, context) {
  if (oldVNode === newVNode) return; // 같은 객체면 아래도 전부 같다

  // 5) UPDATE_TEXT — 둘 다 텍스트인데 내용이 다르면 노드는 그대로 두고 글자만 바꾼다
  if (isText(oldVNode) && isText(newVNode)) {
    if (oldVNode !== newVNode) context.patches.push({ type: UPDATE_TEXT, path, text: newVNode });
    return;
  }

  // 3) REPLACE — 텍스트 ↔ 요소, 태그가 다름, key가 다름 → 통째로 교체.
  //    태그가 다르면 자식 구조도 다를 가능성이 커서, 아래를 비교하지 않고 새로 만드는 편이 싸고 단순하다 (React와 같은 가정).
  if (isText(oldVNode) || isText(newVNode) || oldVNode.type !== newVNode.type || oldVNode.key !== newVNode.key) {
    context.patches.push({ type: REPLACE, path, vnode: newVNode });
    return;
  }

  // 4) UPDATE_PROPS — 같은 태그면 노드를 살리고 바뀐 속성만 고친다
  const { set, remove } = diffProps(oldVNode.props, newVNode.props);
  if (Object.keys(set).length > 0 || remove.length > 0) {
    context.patches.push({ type: UPDATE_PROPS, path, set, remove });
  }

  diffChildren(oldVNode.children, newVNode.children, path, context);
}

function isSameProp(a, b) {
  if (Object.is(a, b)) return true;
  // style은 렌더마다 새 객체가 만들어지기 쉬우므로 "내용"이 같으면 같은 것으로 본다
  if (a && b && typeof a === 'object' && typeof b === 'object') return styleToString(a) === styleToString(b);
  return false;
}

function diffProps(oldProps, newProps) {
  const set = {};
  const remove = [];
  for (const [name, value] of Object.entries(newProps)) {
    if (!isSameProp(oldProps[name], value)) set[name] = value;
  }
  for (const name of Object.keys(oldProps)) {
    if (!(name in newProps)) remove.push(name);
  }
  return { set, remove };
}

// 자식 목록 비교.
// - key가 있는 자식은 key로 짝을 찾는다 → 순서가 바뀌어도 같은 항목으로 알아본다 (MOVE)
// - key가 없는 자식은 key 없는 것끼리 순서대로 짝짓는다 → key가 하나도 없으면 결국 "인덱스 기반"과 같다
function diffChildren(oldChildren, newChildren, parentPath, context) {
  const oldKeyed = new Map(); // key → 이전 인덱스
  const oldUnkeyed = []; // key 없는 이전 자식의 인덱스 (순서대로)
  oldChildren.forEach((child, index) => {
    const key = getUsableKey(child, oldKeyed, context);
    if (key === null) oldUnkeyed.push(index);
    else oldKeyed.set(key, index);
  });

  // 새 자식마다 짝이 될 이전 인덱스를 정한다 (없으면 -1 → 새로 생김)
  const usedNewKeys = new Map();
  let nextUnkeyed = 0;
  const matches = newChildren.map((child) => {
    const key = getUsableKey(child, usedNewKeys, context);
    if (key === null) return nextUnkeyed < oldUnkeyed.length ? oldUnkeyed[nextUnkeyed++] : -1;
    usedNewKeys.set(key, true);
    return oldKeyed.has(key) ? oldKeyed.get(key) : -1;
  });

  // 2) REMOVE — 새 목록에서 짝을 못 찾은 이전 자식
  const matchedOld = new Set(matches.filter((index) => index !== -1));
  oldChildren.forEach((_, index) => {
    if (!matchedOld.has(index)) context.patches.push({ type: REMOVE, path: [...parentPath, index] });
  });

  // MOVE 판단: "그대로 둘 수 있는 항목"을 최대한 많이 고르고, 나머지만 옮긴다.
  // 새 순서로 늘어놓았을 때 이전 위치가 증가하는 항목들은 서로의 상대 순서가 그대로이므로 움직일 필요가 없다.
  // 그런 항목을 가장 많이 고르는 것이 "최장 증가 부분 수열(LIS)"이다 (Vue 3·Inferno와 같은 방식).
  //   예) a b c d → d a b c : 이전 위치 [3, 0, 1, 2] → LIS = [0, 1, 2](a b c) → d 하나만 MOVE
  const stableIndices = findStableIndices(matches);
  newChildren.forEach((child, index) => {
    const oldIndex = matches[index];
    if (oldIndex === -1) {
      // 1) CREATE — 짝이 없는 새 자식
      context.patches.push({ type: CREATE, parentPath, index, vnode: child });
      return;
    }
    if (!stableIndices.has(index)) {
      context.patches.push({ type: MOVE, parentPath, from: oldIndex, index, key: child.key ?? null });
    }
    // 짝을 찾은 자식은 안쪽을 다시 비교한다. 경로는 이전 트리의 위치(oldIndex)
    walk(oldChildren[oldIndex], child, [...parentPath, oldIndex], context);
  });
}

// oldIndices[i] = 새 목록 i번째 자식의 이전 위치 (-1은 새로 생긴 것).
// 이전 위치가 증가하는 가장 긴 부분 수열을 찾아, 그 자식들의 "새 위치" 집합을 돌려준다.
// 방법: 길이별로 "그 길이의 수열을 끝낼 수 있는 가장 작은 이전 위치"(tails)만 기억하면서 한 번 훑는다 (O(n log n)).
function findStableIndices(oldIndices) {
  const tails = []; // tails[k] = 길이 k+1인 증가 수열의 마지막 자식(새 위치)
  const previous = new Array(oldIndices.length).fill(-1); // 수열을 거꾸로 따라가기 위한 바로 앞 자식
  oldIndices.forEach((value, i) => {
    if (value === -1) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (oldIndices[tails[mid]] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  });

  const stable = new Set();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i]) stable.add(i);
  return stable;
}

// key를 쓸 수 있으면 key, 아니면 null. 같은 목록에서 이미 쓴 key가 또 나오면(중복) 경고하고 key 없는 것처럼 다룬다.
function getUsableKey(child, seen, context) {
  if (isText(child) || child.key === null || child.key === undefined) return null;
  if (seen.has(child.key)) {
    if (!context.warnedKeys.has(child.key)) {
      context.warnedKeys.add(child.key);
      console.warn(`[mini-react] 같은 목록에 key "${child.key}"가 중복됐습니다. 뒤에 나온 항목은 key 없이 순서로 비교합니다.`);
    }
    return null;
  }
  return child.key;
}
