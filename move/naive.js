/**
 * 비교용 — "앞에서부터" 방식 key diff (React 의 lastPlacedIndex 방식). 이 페이지에서만 쓴다.
 *  새 순서대로 보면서, 그 노드의 옛 위치가 "지금까지 제자리에 둔 노드의 옛 위치 최댓값" 보다 앞이면 옮긴다.
 *  우리 라이브러리(src/lib/diff.js)의 LIS 방식과 같은 형식의 패치를 만들어 같은 applyPatches 로 적용한다.
 *  루트 아래 한 단계 목록(ul > li, 모두 key 있음)만 다룬다. 각 줄 안쪽은 우리 diff 로 비교한다 (두 방식이 같다).
 */
import { diff, PatchType } from '../src/lib/index.js';

export function diffNaive(oldV, newV) {
  const patches = [];
  const oldCh = oldV.children;
  const newCh = newV.children;
  const oldIndex = new Map(oldCh.map((c, i) => [c.key, i]));
  const newKeys = new Set(newCh.map((c) => c.key));

  // 1. 삭제 (뒤에서부터) — 우리 방식과 같다
  for (let i = oldCh.length - 1; i >= 0; i--) {
    if (!newKeys.has(oldCh[i].key)) patches.push({ type: PatchType.REMOVE, path: [], index: i, node: oldCh[i] });
  }
  // 삭제 뒤 자리
  const livePos = new Int32Array(oldCh.length).fill(-1);
  let L = 0;
  oldCh.forEach((c, i) => { if (newKeys.has(c.key)) livePos[i] = L++; });

  // 2. 앞에서부터: 옛 위치가 "지금까지 제자리에 둔 줄의 옛 위치 최댓값" 보다 앞이면 옮긴다
  const n = newCh.length;
  const moving = new Uint8Array(n); // 옮기거나 새로 넣는 줄
  const base = new Int32Array(n); // 왼쪽에서 가장 가까운 제자리 줄의 자리 (없으면 -1) — 그 바로 뒤에 붙는다
  let lastPlaced = -1, prevStable = -1, decisions = 0;
  for (let i = 0; i < n; i++) {
    const oi = oldIndex.get(newCh[i].key);
    if (oi !== undefined && oi >= lastPlaced) { lastPlaced = oi; prevStable = livePos[oi]; continue; }
    if (oi !== undefined) decisions++;
    moving[i] = 1;
    base[i] = prevStable;
  }
  // 위치 계산은 우리 diff 와 같은 좌표 + Fenwick 트리 (O(n log n)) — 비교가 공정하도록 같은 기법을 쓴다
  //  좌표 순서: 자리 b 마다 [원래 자리 b] 다음에 [b 뒤에 붙는 줄들(i 오름차순)], b = -1 은 맨 앞
  const count = new Int32Array(L + 1); // count[b + 1]
  for (let i = 0; i < n; i++) if (moving[i]) count[base[i] + 1]++;
  const start = new Int32Array(L + 1);
  const rankOrig = new Int32Array(L);
  let r = 0;
  for (let b = -1; b < L; b++) {
    if (b >= 0) rankOrig[b] = r++;
    start[b + 1] = r;
    r += count[b + 1];
  }
  const rankNew = new Int32Array(n);
  for (let i = 0; i < n; i++) if (moving[i]) rankNew[i] = start[base[i] + 1]++;
  const tree = new Int32Array(r + 1);
  const add = (k, v) => { for (k++; k <= r; k += k & -k) tree[k] += v; };
  const countBefore = (k) => { let s = 0; for (; k > 0; k -= k & -k) s += tree[k]; return s; };
  for (let p = 0; p < L; p++) add(rankOrig[p], 1);
  for (let i = 0; i < n; i++) {
    if (!moving[i]) continue;
    const c = newCh[i];
    const oi = oldIndex.get(c.key);
    if (oi !== undefined) {
      const ro = rankOrig[livePos[oi]];
      const from = countBefore(ro);
      add(ro, -1);
      const to = countBefore(rankNew[i]);
      add(rankNew[i], 1);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: [], from, to, key: c.key });
    } else {
      const index = countBefore(rankNew[i]);
      add(rankNew[i], 1);
      patches.push({ type: PatchType.INSERT, path: [], index, node: c });
    }
  }

  // 3. 각 줄 안쪽 비교
  newCh.forEach((c, i) => {
    const oi = oldIndex.get(c.key);
    if (oi !== undefined) diff(oldCh[oi], c, [i], patches);
  });
  patches.decisions = decisions;
  return patches;
}

/** 순서만 보고 이동 횟수 세기 (DOM 없이 — 규모별 그래프용) */
export function naiveMoves(oldKeys, newKeys) {
  const oldIndex = new Map(oldKeys.map((k, i) => [k, i]));
  let lastPlaced = -1, moves = 0;
  for (const k of newKeys) {
    const i = oldIndex.get(k);
    if (i === undefined) continue;
    if (i < lastPlaced) moves++;
    else lastPlaced = i;
  }
  return moves;
}
