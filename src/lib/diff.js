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
 *
 * 한 번의 diff 호출에 필요한 상태(경로 스택 · 포커스 key)는 호출마다 만드는 문맥(ctx)에 담는다.
 * 모듈 전역 변수를 쓰지 않으므로 diff 안에서 diff 를 다시 불러도 서로 섞이지 않는다.
 */

import { TEXT } from './vdom.js';
import { warn } from './warn.js';
import { longestIncreasingSubsequence } from './lis.js';
import { FenwickSum } from './fenwick.js';

export { longestIncreasingSubsequence }; // 예전처럼 diff.js 에서도 가져올 수 있게

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
 * @param {number[]} [path]   이 두 노드의 경로 (보통 [])
 * @param {Array} [patches]  결과를 쌓을 배열
 * @param {object} [options]
 * @param {Set} [options.keep] 옮기는 횟수가 같은 여러 방법 중, 이 key 의 줄은 옮기지 않는 쪽을 고른다 (focusedKeys 참고)
 * @param {boolean} [options.liveHandlers] 이벤트 핸들러가 함수 → 다른 함수로만 바뀐 건 패치하지 않는다.
 *   이벤트가 일어날 때 최신 VNode 에서 핸들러를 찾아 부르는 화면(컴포넌트가 관리하는 DOM)에서만 켠다 (vdom.js setEvent)
 * @returns {Array<object>} patches
 */
export function diff(oldVNode, newVNode, path = [], patches = [], options) {
  const ctx = newContext(path, options);
  return diffNode(ctx, oldVNode, newVNode, path.length, patches);
}

/**
 * 한 번의 diff 동안 쓰는 상태.
 *  stack        : 루트에서 지금 노드까지의 childNodes 인덱스. 노드마다 경로 배열을 새로 만들지 않고 이 배열 하나를 덮어쓴다.
 *  keep         : 되도록 옮기지 않을 key (포커스가 있는 줄)
 *  liveHandlers : 핸들러 함수가 바뀐 건 패치하지 않음
 */
function newContext(path, options) {
  return { stack: path.slice(), keep: options?.keep ?? null, liveHandlers: !!options?.liveHandlers };
}

/** 패치를 만들 때만 그 순간의 경로를 잘라 낸다 */
const pathTo = (ctx, depth) => ctx.stack.slice(0, depth);

function diffNode(ctx, oldVNode, newVNode, depth, patches) {
  // 같은 객체 참조면 하위 트리가 동일함이 보장된다. (useMemo · memo 로 VNode 를 재사용하면 비교 자체를 건너뜀)
  if (oldVNode === newVNode) return patches;

  if (oldVNode == null || newVNode == null || !isSameNode(oldVNode, newVNode)) {
    patches.push({ type: PatchType.REPLACE, path: pathTo(ctx, depth), node: newVNode ?? null, oldNode: oldVNode ?? null });
    return patches;
  }

  if (newVNode.type === TEXT) {
    if (oldVNode.text !== newVNode.text) {
      patches.push({ type: PatchType.TEXT, path: pathTo(ctx, depth), text: newVNode.text, oldText: oldVNode.text });
    }
    return patches;
  }

  const changes = compareProps(oldVNode.props, newVNode.props, ctx.liveHandlers);
  if (changes.length) patches.push({ type: PatchType.PROPS, path: pathTo(ctx, depth), changes });

  childrenAt(ctx, oldVNode.children, newVNode.children, depth, patches);
  return patches;
}

/** 같은 노드로 간주(=재사용)할 수 있는가: 타입과 key 가 모두 같아야 한다. */
export function isSameNode(a, b) {
  return a.type === b.type && (a.key ?? null) === (b.key ?? null);
}

const NO_CHANGES = Object.freeze([]);
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * props 비교 (공개 API) — 반환: [{ name, value, oldValue }] (value === undefined 이면 삭제)
 *  항상 새 배열을 돌려준다 (호출한 쪽이 결과를 고쳐도 안전).
 */
export function diffProps(oldProps = {}, newProps = {}) {
  const changes = compareProps(oldProps, newProps, false);
  return changes === NO_CHANGES ? [] : changes;
}

/**
 * diff 안에서 쓰는 props 비교.
 *  - 바뀐 게 없으면 얼려 둔 빈 배열 하나를 돌려준다 (노드마다 배열을 만들지 않음)
 *  - liveHandlers 이면 이벤트 핸들러가 함수 → 다른 함수로만 바뀐 건 건너뛴다 (onClick: () => … 처럼 매번 새로 만드는 핸들러).
 *    이벤트가 일어나면 최신 VNode 에서 핸들러를 찾아 부르므로 DOM 에 새 함수를 넣어 둘 필요가 없다.
 */
function compareProps(oldProps, newProps, liveHandlers) {
  // 자기 속성만 비교한다 — createElement 도 Object.entries 로 자기 속성만 그리므로 처음 그릴 때와 규칙이 같다.
  // (for..in 은 물려받은 속성까지 돌아서, Object.create(기본값) 처럼 만든 props 의 기본값 변화가 패치로 나갔다)
  // Object.keys 는 V8 이 같은 모양의 객체마다 캐시해 두어 싸다. 비용이 컸던 건 결과 배열이었으므로 그것만 만들지 않는다.
  let changes = null;
  const nk = Object.keys(newProps);
  for (let i = 0; i < nk.length; i++) {
    const name = nk[i];
    const a = hasOwn.call(oldProps, name) ? oldProps[name] : undefined; // 물려받은 옛 값은 없는 것으로
    const b = newProps[name];
    if (Object.is(a, b)) continue;
    if (liveHandlers && typeof a === 'function' && typeof b === 'function' && name.length > 2 && name[0] === 'o' && name[1] === 'n') continue;
    if (name === 'style' && isPlainObject(a) && isPlainObject(b) && shallowEqual(a, b)) continue;
    (changes ??= []).push({ name, value: b, oldValue: a });
  }
  const ok = Object.keys(oldProps);
  for (let i = 0; i < ok.length; i++) {
    const name = ok[i];
    if (!hasOwn.call(newProps, name)) (changes ??= []).push({ name, value: undefined, oldValue: oldProps[name] });
  }
  return changes ?? NO_CHANGES;
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
export function diffChildren(oldCh, newCh, parentPath, patches, options) {
  childrenAt(newContext(parentPath, options), oldCh, newCh, parentPath.length, patches);
}

function childrenAt(ctx, oldCh, newCh, depth, patches) {
  if (oldCh.length === 0 && newCh.length === 0) return;
  const { stack } = ctx;

  // ---- 빠른 길: key 가 하나도 없고 개수가 같으면 → i 번째끼리 짝, 삭제·이동·삽입 없음 ----
  if (oldCh.length === newCh.length && allUnkeyed(oldCh) && allUnkeyed(newCh)) {
    for (let i = 0; i < newCh.length; i++) {
      stack[depth] = i;
      diffNode(ctx, oldCh[i], newCh[i], depth + 1, patches);
    }
    return;
  }

  // ---- 빠른 길 2: 개수가 같고 거의 모든 줄이 같은 자리에 같은 key → 어긋난 몇 자리만 처리 ----
  if (oldCh.length === newCh.length && diffMostlyInPlace(ctx, oldCh, newCh, depth, patches)) return;
  const parentPath = pathTo(ctx, depth); // 이 단계의 REMOVE · MOVE · INSERT 가 함께 쓰는 경로

  // ---- 1. 매칭 ----  (노드 대신 old 인덱스로 다뤄 Map · Set 을 줄인다)
  const oldLen = oldCh.length;
  const newLen = newCh.length;
  const keyed = new Map(); // key → old 인덱스
  const unkeyed = []; // key 없는 old 인덱스
  for (let i = 0; i < oldLen; i++) {
    const c = oldCh[i];
    if (c.key != null) {
      if (!keyed.has(c.key)) keyed.set(c.key, i);
      // 중복 key: 첫 노드만 매칭 대상, 나머지는 자연스럽게 삭제됨
      else warn(`형제 사이에 같은 key "${c.key}" 가 여러 개 있습니다. key 는 형제 안에서 고유해야 합니다.`);
    } else unkeyed.push(i);
  }
  const used = new Uint8Array(oldLen);
  const matchIdx = new Int32Array(newLen).fill(-1); // 새 인덱스 → 짝이 된 old 인덱스 (없으면 -1)
  let u = 0;
  for (let i = 0; i < newLen; i++) {
    const c = newCh[i];
    let m = -1;
    if (c.key != null) {
      const o = keyed.get(c.key);
      if (o !== undefined && !used[o]) m = o;
    } else if (u < unkeyed.length) {
      m = unkeyed[u++];
    }
    if (m >= 0) {
      used[m] = 1;
      matchIdx[i] = m;
    }
  }

  // ---- 2. 삭제 (뒤에서부터) ----
  for (let i = oldLen - 1; i >= 0; i--) {
    if (!used[i]) patches.push({ type: PatchType.REMOVE, path: parentPath, index: i, node: oldCh[i] });
  }

  // ---- 3. 이동 / 삽입 ----
  place(ctx, oldCh, newCh, used, matchIdx, parentPath, patches);

  // ---- 4. 재귀 diff (이제 DOM 순서 == newCh 순서) ----
  for (let i = 0; i < newLen; i++) {
    const m = matchIdx[i];
    if (m >= 0) {
      stack[depth] = i;
      diffNode(ctx, oldCh[m], newCh[i], depth + 1, patches);
    }
  }
}

/** keep 에 든 줄에 가중치 1 을 준 배열 (해당 줄이 없으면 null → 보통 LIS). p 번째 원소의 old 인덱스는 oldIndexOf(p). */
function keepWeights(ctx, oldCh, len, oldIndexOf) {
  if (!ctx.keep) return null;
  let w = null;
  for (let p = 0; p < len; p++) {
    const key = oldCh[oldIndexOf(p)].key;
    if (key != null && ctx.keep.has(key)) (w ??= new Uint8Array(len))[p] = 1;
  }
  return w;
}

/**
 * 빠른 길 2 — 개수가 같고, key 가 다른 자리가 MAX_MISPLACED 개 이하이며, 그 자리들끼리 key 만 서로 바뀐 경우.
 *  (중복 key 는 h() 가 리스트를 만들 때 경고한다 — vdom.js checkListKeys)
 */
const MAX_MISPLACED = 8;
function diffMostlyInPlace(ctx, oldCh, newCh, depth, patches) {
  const n = oldCh.length;
  const mis = [];
  for (let i = 0; i < n; i++) {
    const a = oldCh[i].key ?? null;
    const b = newCh[i].key ?? null;
    if (a === b) continue;
    if (a === null || b === null || mis.length === MAX_MISPLACED) return false;
    mis.push(i);
  }
  const k = mis.length;
  const matchOf = newCh.length ? oldCh.slice() : [];
  let parentPath = null; // 이 단계의 MOVE 가 함께 쓰는 경로 (MOVE 가 있을 때만 만든다)
  if (k > 0) {
    const taken = new Uint8Array(k);
    const seq = new Int32Array(n);
    for (let i = 0; i < n; i++) seq[i] = i;
    for (let x = 0; x < k; x++) {
      const key = oldCh[mis[x]].key;
      let found = -1;
      for (let y = 0; y < k; y++) if (newCh[mis[y]].key === key) { found = y; break; }
      if (found === -1 || taken[found]) return false;
      taken[found] = 1;
      seq[mis[x]] = mis[found];
      matchOf[mis[found]] = oldCh[mis[x]];
    }
    const stable = new Uint8Array(n);
    for (const p of longestIncreasingSubsequence(seq, keepWeights(ctx, oldCh, n, (p) => p))) stable[seq[p]] = 1;
    const live = oldCh.slice();
    for (let i = n - 1; i >= 0; i--) {
      if (stable[i]) continue;
      const m = matchOf[i];
      const from = live.indexOf(m);
      live.splice(from, 1);
      const to = i + 1 < n ? live.indexOf(matchOf[i + 1]) : live.length;
      live.splice(to, 0, m);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: (parentPath ??= pathTo(ctx, depth)), from, to, key: m.key });
    }
  }
  for (let i = 0; i < n; i++) {
    ctx.stack[depth] = i;
    diffNode(ctx, matchOf[i], newCh[i], depth + 1, patches);
  }
  return true;
}

/**
 * 이동 / 삽입 패치 만들기 — O(n log n)
 *  모든 노드가 "언젠가 있게 될 자리" 를 미리 한 줄의 좌표로 세워 두고,
 *  "지금 몇 번째인가" = 내 좌표 앞에 지금 DOM 에 있는 노드 수 를 Fenwick 트리로 센다.
 *   - 움직이지 않는 노드와 아직 안 옮긴 노드: 삭제 뒤 원래 자리 p   → 좌표 (p, ∞)
 *   - 옮기거나 새로 넣는 새 인덱스 i 의 노드: 오른쪽에서 가장 가까운 안 움직이는 노드 s 바로 앞 → 좌표 (s 의 자리, i)
 */
function place(ctx, oldCh, newCh, used, matchIdx, parentPath, patches) {
  const oldLen = oldCh.length;
  const n = newCh.length;
  const livePos = new Int32Array(oldLen);
  const liveOld = new Int32Array(oldLen); // 삭제 뒤 자리 → old 인덱스
  let L = 0;
  for (let i = 0; i < oldLen; i++) if (used[i]) { liveOld[L] = i; livePos[i] = L++; }
  const seq = new Int32Array(L);
  for (let i = 0; i < n; i++) if (matchIdx[i] >= 0) seq[livePos[matchIdx[i]]] = i;
  const stablePos = new Uint8Array(L);
  for (const k of longestIncreasingSubsequence(seq, keepWeights(ctx, oldCh, L, (p) => liveOld[p]))) stablePos[k] = 1;

  const moving = new Uint8Array(n);
  const base = new Int32Array(n);
  const count = new Int32Array(L + 1);
  let nextStable = L;
  let movers = 0;
  for (let i = n - 1; i >= 0; i--) {
    const m = matchIdx[i];
    if (m >= 0 && stablePos[livePos[m]]) { nextStable = livePos[m]; continue; }
    moving[i] = 1;
    base[i] = nextStable;
    count[nextStable]++;
    movers++;
  }
  if (movers === 0) return;

  // 좌표 → 순위: 자리 b 마다 [b 앞에 붙는 노드들(i 오름차순)] 다음에 [원래 자리 b]
  const start = new Int32Array(L + 1);
  const rankOrig = new Int32Array(L);
  let r = 0;
  for (let b = 0; b <= L; b++) {
    start[b] = r;
    r += count[b];
    if (b < L) rankOrig[b] = r++;
  }
  const rankNew = new Int32Array(n);
  for (let i = 0; i < n; i++) if (moving[i]) rankNew[i] = start[base[i]]++;

  const fw = new FenwickSum(r); // 현재 DOM 에 있는 좌표를 1 로 표시
  for (let p = 0; p < L; p++) fw.add(rankOrig[p], 1);

  for (let i = n - 1; i >= 0; i--) {
    if (!moving[i]) continue;
    const m = matchIdx[i];
    if (m >= 0) {
      const ro = rankOrig[livePos[m]];
      const from = fw.countBefore(ro);
      fw.add(ro, -1);
      const to = fw.countBefore(rankNew[i]);
      fw.add(rankNew[i], 1);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: parentPath, from, to, key: oldCh[m].key });
    } else {
      const index = fw.countBefore(rankNew[i]);
      fw.add(rankNew[i], 1);
      patches.push({ type: PatchType.INSERT, path: parentPath, index, node: newCh[i] });
    }
  }
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
