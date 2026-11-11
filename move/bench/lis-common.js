/**
 * 비교용 — 최적화 전 우리 diff (커밋 0cc8727 의 src/lib/diff.js 를 그대로 옮김).
 * LIS 로 이동 횟수는 최소지만, 옮길 위치를 indexOf · splice 로 찾아 O(n²) 이다. "흔한 LIS 구현" 의 기준으로 쓴다.
 */
/**
 * Diff 알고리즘
 * ------------------------------------------------------------------
 * 두 VNode 트리를 비교해 "실제 DOM 에 적용할 최소 변경 목록(patches)" 을 만든다.
 * 일반적인 트리 편집 거리는 O(n^3) 이지만, React 와 같은 휴리스틱으로 O(n) 에 가깝게 비교한다.
 *   1) 같은 레벨(형제)끼리만 비교한다. (레벨을 넘나드는 이동은 고려하지 않음)
 *   2) 타입(태그)이 다르면 하위 트리 전체를 교체한다.
 *   3) 형제 리스트는 key 로 같은 노드를 식별한다.
 *
 * 최소 변경을 위한 5가지 핵심 케이스
 *   ① INSERT  : 새 노드 추가            (old 없음, new 있음)
 *   ② REMOVE  : 기존 노드 삭제          (old 있음, new 없음)
 *   ③ REPLACE : 타입(태그)/key 변경     → 노드 통째 교체
 *   ④ TEXT    : 텍스트 노드 내용 변경
 *   ⑤ PROPS   : 같은 태그의 속성 변경 (추가/수정/삭제)
 *   + MOVE    : key 가 같은 노드의 위치 변경 (LIS 로 이동 횟수 최소화)
 *
 * patch 는 path(루트로부터의 childNodes 인덱스 배열)로 대상을 가리킨다.
 * patches 배열은 "앞에서부터 순서대로 적용" 했을 때 path 가 항상 유효하도록 생성된다.
 *   - 한 레벨에서: REMOVE(뒤에서부터) → MOVE/INSERT(구조 확정) → 각 자식 재귀 diff
 */

import { TEXT } from '../../src/lib/vdom.js';
import { warn } from '../../src/lib/warn.js';

export const PatchType = Object.freeze({
  INSERT: 'INSERT',
  REMOVE: 'REMOVE',
  REPLACE: 'REPLACE',
  TEXT: 'TEXT',
  PROPS: 'PROPS',
  MOVE: 'MOVE',
});

/**
 * @param {object|null} oldVNode
 * @param {object|null} newVNode
 * @returns {Array<object>} patches
 */
export function diff(oldVNode, newVNode, path = [], patches = []) {
  // 같은 객체 참조면 하위 트리가 동일함이 보장된다. (useMemo 로 VNode 를 재사용하면 비교 자체를 건너뜀)
  if (oldVNode === newVNode) return patches;

  if (oldVNode == null || newVNode == null || !isSameNode(oldVNode, newVNode)) {
    patches.push({ type: PatchType.REPLACE, path, node: newVNode ?? null, oldNode: oldVNode ?? null });
    return patches;
  }

  if (newVNode.type === TEXT) {
    if (oldVNode.text !== newVNode.text) {
      patches.push({ type: PatchType.TEXT, path, text: newVNode.text, oldText: oldVNode.text });
    }
    return patches;
  }

  const changes = diffProps(oldVNode.props, newVNode.props);
  if (changes.length) patches.push({ type: PatchType.PROPS, path, changes });

  diffChildren(oldVNode.children, newVNode.children, path, patches);
  return patches;
}

/** 같은 노드로 간주(=재사용)할 수 있는가: 타입과 key 가 모두 같아야 한다. */
export function isSameNode(a, b) {
  return a.type === b.type && (a.key ?? null) === (b.key ?? null);
}

/**
 * props 비교. 반환: [{ name, value, oldValue }] (value === undefined 이면 삭제)
 * 함수(이벤트 핸들러)는 매 렌더 새로 만들어지므로 참조가 바뀌면 교체 대상이 된다.
 */
export function diffProps(oldProps = {}, newProps = {}) {
  const changes = [];
  for (const name of Object.keys(newProps)) {
    const a = oldProps[name];
    const b = newProps[name];
    if (Object.is(a, b)) continue;
    if (name === 'style' && isPlainObject(a) && isPlainObject(b) && shallowEqual(a, b)) continue;
    changes.push({ name, value: b, oldValue: a });
  }
  for (const name of Object.keys(oldProps)) {
    if (!(name in newProps)) changes.push({ name, value: undefined, oldValue: oldProps[name] });
  }
  return changes;
}

/**
 * 형제 리스트 비교 (key 기반 재조정, Reconciliation)
 *  1. 매칭  : key 가 있으면 key 로, 없으면 key 없는 노드끼리 순서대로 짝짓는다.
 *  2. 삭제  : 짝이 없는 old 노드를 뒤에서부터 REMOVE (인덱스가 밀리지 않도록)
 *  3. 배치  : 뒤에서부터 각 새 노드를 "오른쪽 이웃 앞" 에 위치시킨다.
 *            LIS(최장 증가 부분 수열)에 속한 노드는 상대 순서가 이미 맞으므로 움직이지 않는다.
 *            → 이동(MOVE) 횟수가 최소가 된다. (Vue 3 / Inferno 와 같은 아이디어)
 *  4. 재귀  : 위치가 확정된 뒤, 짝지어진 노드끼리 diff
 */
export function diffChildren(oldCh, newCh, parentPath, patches) {
  if (oldCh.length === 0 && newCh.length === 0) return;

  // ---- 빠른 길: key 가 하나도 없고 개수가 같으면 → i 번째끼리 짝, 삭제·이동·삽입 없음 ----
  // (아래 일반 과정을 거쳐도 결과가 정확히 같다. 다시 그릴 때 가장 흔한 경우라 Map·Set·LIS 를 만들지 않는다)
  if (oldCh.length === newCh.length && allUnkeyed(oldCh) && allUnkeyed(newCh)) {
    for (let i = 0; i < newCh.length; i++) diff(oldCh[i], newCh[i], parentPath.concat(i), patches);
    return;
  }

  // ---- 1. 매칭 ----
  const keyed = new Map();
  const unkeyed = [];
  for (const c of oldCh) {
    if (c.key != null) {
      if (!keyed.has(c.key)) keyed.set(c.key, c);
      // 중복 key: 첫 노드만 매칭 대상, 나머지는 자연스럽게 삭제됨
      else warn(`형제 사이에 같은 key "${c.key}" 가 여러 개 있습니다. key 는 형제 안에서 고유해야 합니다.`);
    } else unkeyed.push(c);
  }
  const used = new Set();
  const matchOf = new Array(newCh.length).fill(null);
  let u = 0;
  newCh.forEach((c, i) => {
    let m = null;
    if (c.key != null) {
      const o = keyed.get(c.key);
      if (o && !used.has(o)) m = o;
    } else if (u < unkeyed.length) {
      m = unkeyed[u++];
    }
    if (m) {
      used.add(m);
      matchOf[i] = m;
    }
  });

  // ---- 2. 삭제 (뒤에서부터) ----
  const live = oldCh.slice(); // 패치가 적용되는 동안의 실제 DOM 형제 순서를 시뮬레이션
  for (let i = live.length - 1; i >= 0; i--) {
    if (!used.has(live[i])) {
      patches.push({ type: PatchType.REMOVE, path: parentPath, index: i, node: live[i] });
      live.splice(i, 1);
    }
  }

  // ---- 3. 이동 / 삽입 ----
  const newIndexOf = new Map();
  matchOf.forEach((m, i) => m && newIndexOf.set(m, i));
  const seq = live.map((m) => newIndexOf.get(m)); // 남은 old 노드들이 가야 할 새 인덱스
  const stable = new Set(longestIncreasingSubsequence(seq).map((k) => live[k]));

  const placed = new Array(newCh.length); // 새 인덱스 i 에 놓인 live 항목
  // anchor(바로 오른쪽 이웃) 의 live 위치를 매번 indexOf 로 찾지 않고 기억해 둔다 (큰 목록에서 O(n²) → 대부분 O(n)).
  // 같은 VNode 객체가 live 에 두 번 들어 있으면 위치가 하나로 정해지지 않으므로, 그때만 원래대로 매번 찾는다.
  const unique = new Set(live).size === live.length;
  let anchorAt = live.length;
  for (let i = newCh.length - 1; i >= 0; i--) {
    const anchor = i + 1 < newCh.length ? placed[i + 1] : null;
    const at = anchor ? (unique ? anchorAt : live.indexOf(anchor)) : live.length; // anchor 의 지금 위치
    const m = matchOf[i];
    if (m && stable.has(m)) {
      placed[i] = m;
      // 움직이지 않는 노드는 anchor 보다 앞에 있다 → 뒤에서부터 찾으면 금방 나온다 (못 찾으면 처음부터)
      if (unique) {
        anchorAt = at > 0 ? live.lastIndexOf(m, at - 1) : -1;
        if (anchorAt === -1) anchorAt = live.indexOf(m);
      }
      continue;
    }
    if (m) {
      const from = live.indexOf(m);
      live.splice(from, 1);
      // m 을 빼면 그 뒤의 anchor 는 한 칸 앞으로 (중복 객체가 있으면 원래대로 다시 찾는다)
      const to = !anchor ? live.length : unique ? (from < at ? at - 1 : at) : live.indexOf(anchor);
      live.splice(to, 0, m);
      if (from !== to) {
        patches.push({ type: PatchType.MOVE, path: parentPath, from, to, key: m.key });
      }
      placed[i] = m;
      anchorAt = to;
    } else {
      const index = at;
      anchorAt = index;
      const marker = { inserted: newCh[i] };
      live.splice(index, 0, marker);
      patches.push({ type: PatchType.INSERT, path: parentPath, index, node: newCh[i] });
      placed[i] = marker;
    }
  }

  // ---- 4. 재귀 diff (이제 live 순서 == newCh 순서) ----
  for (let i = 0; i < newCh.length; i++) {
    const m = matchOf[i];
    if (m) diff(m, newCh[i], parentPath.concat(i), patches);
  }
}

/**
 * 최장 증가 부분 수열의 "인덱스" 들을 반환. O(n log n)
 * 예) [2, 0, 1, 3] → [1, 2, 3]  (값 0,1,3)
 */
export function longestIncreasingSubsequence(arr) {
  const n = arr.length;
  if (n === 0) return [];
  const prev = new Array(n).fill(-1);
  const tails = []; // tails[len] = 길이 len+1 인 증가 수열의 마지막 원소 인덱스
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[tails[mid]] < arr[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const result = [];
  for (let k = tails[tails.length - 1]; k !== -1; k = prev[k]) result.push(k);
  return result.reverse();
}

function allUnkeyed(list) {
  for (let i = 0; i < list.length; i++) if (list[i].key != null) return false;
  return true;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function shallowEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** 패치 목록 요약 (UI / 로그용) */
export function summarizePatches(patches) {
  const summary = { INSERT: 0, REMOVE: 0, REPLACE: 0, TEXT: 0, PROPS: 0, MOVE: 0 };
  for (const p of patches) summary[p.type]++;
  return summary;
}
