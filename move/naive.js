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
  const live = oldCh.filter((c) => newKeys.has(c.key));

  // 2. 앞에서부터 배치
  let lastPlaced = -1;
  let prev = null;
  let decisions = 0; // 이 방식이 "옮겨야 한다" 고 판단한 횟수
  newCh.forEach((c) => {
    const oi = oldIndex.get(c.key);
    if (oi === undefined) {
      const at = prev ? live.indexOf(prev) + 1 : 0;
      const marker = { inserted: c };
      live.splice(at, 0, marker);
      patches.push({ type: PatchType.INSERT, path: [], index: at, node: c });
      prev = marker;
      return;
    }
    const o = oldCh[oi];
    if (oi < lastPlaced) {
      decisions++;
      const from = live.indexOf(o);
      live.splice(from, 1);
      const to = prev ? live.indexOf(prev) + 1 : 0;
      live.splice(to, 0, o);
      if (from !== to) patches.push({ type: PatchType.MOVE, path: [], from, to, key: c.key });
    } else {
      lastPlaced = oi;
    }
    prev = o;
  });

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
