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

import { TEXT } from './vdom.js';
import { warn } from './warn.js';

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
// 이번 diff 동안 "되도록 옮기지 않았으면 하는" key (포커스가 있는 줄 등). 최상위 diff 호출의 options.keep 으로 받는다.
let keepKeys = null;

/**
 * @param {object} [options]
 * @param {Set} [options.keep] 옮기는 횟수가 같은 여러 방법 중, 이 key 의 줄은 옮기지 않는 쪽을 고른다 (focusedKeys 참고)
 */
export function diff(oldVNode, newVNode, path = [], patches = [], options) {
  if (options?.keep) {
    const prev = keepKeys;
    keepKeys = options.keep;
    try {
      return diffNode(oldVNode, newVNode, path, patches);
    } finally {
      keepKeys = prev;
    }
  }
  return diffNode(oldVNode, newVNode, path, patches);
}

function diffNode(oldVNode, newVNode, path, patches) {
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

  // ---- 빠른 길 2: 개수가 같고 거의 모든 줄이 같은 자리에 같은 key → 어긋난 몇 자리만 처리 ----
  // (두 줄 바꾸기, 바뀐 게 없는 다시 그리기 같은 흔한 경우. Map · Set · 좌표 계산 없이 끝낸다)
  if (oldCh.length === newCh.length && diffMostlyInPlace(oldCh, newCh, parentPath, patches)) return;

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
  // 뒤에서부터 지우면 앞쪽 인덱스는 밀리지 않으므로, 패치 인덱스는 원래 인덱스 그대로다.
  for (let i = oldLen - 1; i >= 0; i--) {
    if (!used[i]) patches.push({ type: PatchType.REMOVE, path: parentPath, index: i, node: oldCh[i] });
  }

  // ---- 3. 이동 / 삽입 ----
  place(oldCh, newCh, used, matchIdx, parentPath, patches);

  // ---- 4. 재귀 diff (이제 DOM 순서 == newCh 순서) ----
  for (let i = 0; i < newLen; i++) {
    const m = matchIdx[i];
    if (m >= 0) diff(oldCh[m], newCh[i], parentPath.concat(i), patches);
  }
}

/**
 * keepKeys 에 든 줄에 가중치 1 을 준 배열 (해당 줄이 없으면 null → 보통 LIS).
 *  p 번째 원소의 old 인덱스는 oldIndexOf(p).
 */
function keepWeights(oldCh, len, oldIndexOf) {
  if (!keepKeys) return null;
  let w = null;
  for (let p = 0; p < len; p++) {
    const key = oldCh[oldIndexOf(p)].key;
    if (key != null && keepKeys.has(key)) (w ??= new Uint8Array(len))[p] = 1;
  }
  return w;
}

/**
 * 최장 증가 부분 수열의 "인덱스" 들을 반환. O(n log n), 이미 증가하는 부분은 O(1) 씩.
 * 예) [2, 0, 1, 3] → [1, 2, 3]  (값 0,1,3)
 *  - 엄격하게 증가하는 수열만 센다 (같은 값은 이어지지 않음).
 *  - 비교할 수 없는 값(undefined · null · NaN)은 건너뛴다. 예전에는 이런 값이 섞이면 결과가 짧아졌다
 *    ([1, undefined, 2, 3] → 길이 2). diff 는 이런 값을 넘기지 않지만 밖에서 쓰는 경우를 위해 막아 둔다.
 *  - 배열 · 타입 배열 모두 받는다.
 */
export function longestIncreasingSubsequence(arr, weights) {
  const n = arr.length;
  if (n === 0) return [];
  if (weights) return weightedLIS(arr, weights);
  const prev = new Int32Array(n); // prev[i] = i 앞에 오는 원소의 인덱스 (+1, 0 이면 없음)
  const tails = new Int32Array(n); // tails[len] = 길이 len+1 인 증가 수열의 마지막 원소 인덱스
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v == null || v !== v) continue; // undefined · null · NaN
    // 빠른 길: 지금까지 가장 긴 수열의 끝보다 크면 이분 탐색 없이 뒤에 붙인다 (이미 정렬된 구간이 많은 diff 에서 흔함)
    if (len === 0 || arr[tails[len - 1]] < v) {
      prev[i] = len > 0 ? tails[len - 1] + 1 : 0;
      tails[len++] = i;
      continue;
    }
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] + 1 : 0;
    tails[lo] = i;
  }
  // 뒤에서부터 채워 reverse 없이 만든다
  const result = new Array(len);
  for (let k = len - 1, i = tails[len - 1]; k >= 0; k--) {
    result[k] = i;
    i = prev[i] - 1;
  }
  return result;
}

/**
 * 가중치가 있는 LIS — 가장 긴 증가 수열들 중에서 가중치 합이 가장 큰 것. O(n log n).
 *  길이가 먼저이므로 옮기는 횟수(남은 줄 − LIS 길이)는 늘지 않는다. 같은 길이일 때만 가중치가 큰 줄을 남긴다.
 *  값을 순위로 바꾼 뒤, "내 값보다 작은 값으로 끝나는 가장 좋은 (길이, 가중치)" 를 Fenwick 트리(앞부분 최댓값)로 찾는다.
 */
function weightedLIS(arr, weights) {
  const n = arr.length;
  const ok = [];
  for (let i = 0; i < n; i++) { const v = arr[i]; if (v != null && v === v) ok.push(i); }
  if (ok.length === 0) return [];
  const vals = [...new Set(ok.map((i) => arr[i]))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rankOf = new Map(vals.map((v, r) => [v, r + 1]));
  const m = vals.length;
  const tLen = new Int32Array(m + 1), tW = new Float64Array(m + 1), tI = new Int32Array(m + 1).fill(-1);
  const better = (l1, w1, l2, w2) => l1 > l2 || (l1 === l2 && w1 > w2);
  const prev = new Int32Array(n).fill(-1);
  let bestLen = 0, bestW = -1, bestI = -1;
  for (const i of ok) {
    const r = rankOf.get(arr[i]);
    // 순위 < r 중 가장 좋은 끝점
    let ql = 0, qw = 0, qi = -1;
    for (let k = r - 1; k > 0; k -= k & -k) if (better(tLen[k], tW[k], ql, qw)) { ql = tLen[k]; qw = tW[k]; qi = tI[k]; }
    const len = ql + 1, w = qw + (weights[i] || 0);
    prev[i] = qi;
    if (better(len, w, bestLen, bestW)) { bestLen = len; bestW = w; bestI = i; }
    for (let k = r; k <= m; k += k & -k) if (better(len, w, tLen[k], tW[k])) { tLen[k] = len; tW[k] = w; tI[k] = i; }
  }
  const result = new Array(bestLen);
  for (let k = bestLen - 1, i = bestI; k >= 0; k--, i = prev[i]) result[k] = i;
  return result;
}

/**
 * 빠른 길 2 — 개수가 같고, key 가 다른 자리가 MAX_MISPLACED 개 이하이며, 그 자리들끼리 key 만 서로 바뀐 경우.
 *  같은 자리에 같은 key 가 있는 줄은 key 로 찾아도 그 자리의 노드와 짝이 되므로, 어긋난 몇 자리만 짝을 찾으면 된다.
 *  LIS 는 일반 과정과 같은 수열로 구하므로 MOVE 패치도 일반 과정과 똑같다 (중복 key 가 없을 때).
 *  하나라도 조건이 안 맞으면 false 를 돌려주고 일반 과정으로 간다.
 *  비용: key 비교 n 번 + LIS(n log n) + 옮기는 줄 수 × n.  (예전 일반 과정은 Map · Set · 배열을 n 크기로 여러 개 만들었다)
 */
const MAX_MISPLACED = 8;
function diffMostlyInPlace(oldCh, newCh, parentPath, patches) {
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
  const matchOf = newCh.length ? oldCh.slice() : []; // 새 인덱스 i 와 짝이 되는 old 노드 (어긋나지 않은 자리는 그대로)
  if (k > 0) {
    // 어긋난 자리끼리 key 가 1:1 로 짝지어지는가
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
    // 이동: 일반 과정과 같은 규칙 (뒤에서부터, LIS 가 아닌 노드를 오른쪽 이웃 앞으로). 옮기는 줄은 많아야 k 개.
    const stable = new Uint8Array(n);
    const weights = keepWeights(oldCh, n, (p) => p);
    for (const p of longestIncreasingSubsequence(seq, weights)) stable[seq[p]] = 1; // 새 인덱스 기준
    const live = oldCh.slice();
    for (let i = n - 1; i >= 0; i--) {
      if (stable[i]) continue;
      const m = matchOf[i];
      const from = live.indexOf(m);
      live.splice(from, 1);
      const to = i + 1 < n ? live.indexOf(matchOf[i + 1]) : live.length;
      live.splice(to, 0, m);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: parentPath, from, to, key: m.key });
    }
  }
  for (let i = 0; i < n; i++) diff(matchOf[i], newCh[i], parentPath.concat(i), patches);
  return true;
}

/**
 * 이동 / 삽입 패치 만들기 — O(n log n)
 *  뒤에서부터 각 새 노드를 "오른쪽 이웃 앞" 에 둔다 (LIS 에 속한 노드는 그대로).
 *  예전에는 매번 배열에서 indexOf · splice 로 위치를 찾아 O(n²) 이었다 (2만 줄 섞기 593ms).
 *
 *  아이디어: 모든 노드가 "언젠가 있게 될 자리" 를 미리 한 줄로 세워 둘 수 있다.
 *   - 움직이지 않는 노드와 아직 안 옮긴 노드: 삭제 뒤 원래 자리 p   → 좌표 (p, ∞)
 *   - 옮기거나 새로 넣는 새 인덱스 i 의 노드: 오른쪽에서 가장 가까운 안 움직이는 노드 s 바로 앞
 *                                               → 좌표 (s 의 자리, i)   (s 가 없으면 맨 끝)
 *   같은 s 앞에 붙는 노드들은 i 가 작을수록 왼쪽이고, 모두 s 바로 앞에 붙는다.
 *  그러면 "지금 몇 번째인가" = 내 좌표보다 앞에 있는, 현재 DOM 에 있는 좌표의 개수 → Fenwick 트리로 O(log n).
 *  결과 패치는 예전 방식과 똑같다 (무작위 대조). 배열은 모두 타입 배열이라 Map · Set 을 새로 만들지 않는다.
 */
function place(oldCh, newCh, used, matchIdx, parentPath, patches) {
  const oldLen = oldCh.length;
  const n = newCh.length;
  // 삭제 뒤 자리
  const livePos = new Int32Array(oldLen);
  const liveOld = new Int32Array(oldLen); // 삭제 뒤 자리 → old 인덱스
  let L = 0;
  for (let i = 0; i < oldLen; i++) if (used[i]) { liveOld[L] = i; livePos[i] = L++; }
  // 삭제 뒤 자리 p 의 노드가 가야 할 새 인덱스 → LIS
  const seq = new Int32Array(L);
  for (let i = 0; i < n; i++) if (matchIdx[i] >= 0) seq[livePos[matchIdx[i]]] = i;
  const stablePos = new Uint8Array(L);
  for (const k of longestIncreasingSubsequence(seq, keepWeights(oldCh, L, (p) => liveOld[p]))) stablePos[k] = 1;

  // 새 인덱스마다: 움직이는가, 붙을 자리(base)는 어디인가
  const moving = new Uint8Array(n);
  const base = new Int32Array(n);
  const count = new Int32Array(L + 1); // 자리 b 앞에 붙는 노드 수
  let nextStable = L; // 오른쪽에서 가장 가까운 안 움직이는 노드의 자리 (없으면 맨 끝 = L)
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

  // Fenwick 트리: 현재 DOM 에 있는 좌표를 1 로 표시
  const tree = new Int32Array(r + 1);
  const add = (k, v) => { for (k++; k <= r; k += k & -k) tree[k] += v; };
  const countBefore = (k) => { let s = 0; for (; k > 0; k -= k & -k) s += tree[k]; return s; };
  for (let p = 0; p < L; p++) add(rankOrig[p], 1);

  for (let i = n - 1; i >= 0; i--) {
    if (!moving[i]) continue;
    const m = matchIdx[i];
    if (m >= 0) {
      const ro = rankOrig[livePos[m]];
      const from = countBefore(ro);
      add(ro, -1);
      const to = countBefore(rankNew[i]);
      add(rankNew[i], 1);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: parentPath, from, to, key: oldCh[m].key });
    } else {
      const index = countBefore(rankNew[i]);
      add(rankNew[i], 1);
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
