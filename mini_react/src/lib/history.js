/**
 * 히스토리 두 가지
 *  - StateHistory : 기록마다 VNode 트리 전체를 저장하는 가장 단순한 구현. 동작 기준(정답)으로 남겨 두고,
 *                   테스트가 DeltaHistory 와 나란히 돌려 결과가 같은지 확인한다.
 *  - DeltaHistory : 실제로 쓰는 구현. 키프레임 + 델타, 분기(Undo Tree) 선택 가능. 아래 설명 참고.
 *  VNode 는 불변(immutable)으로 취급하므로 참조만 저장해도 안전하다.
 */
import { diff, PatchType } from './diff.js';
import { applyPatchesToVNode } from './patch.js';

export class StateHistory {
  constructor(initial, { limit = 100 } = {}) {
    this.entries = [{ vnode: initial, label: '초기 상태', time: Date.now() }];
    this.index = 0;
    this.limit = limit;
  }

  get current() {
    return this.entries[this.index].vnode;
  }

  get canBack() {
    return this.index > 0;
  }

  get canForward() {
    return this.index < this.entries.length - 1;
  }

  push(vnode, label = '') {
    this.entries.splice(this.index + 1);
    this.entries.push({ vnode, label, time: Date.now() });
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    return vnode;
  }

  back() {
    if (this.canBack) this.index--;
    return this.current;
  }

  forward() {
    if (this.canForward) this.index++;
    return this.current;
  }

  go(index) {
    if (index < 0 || index >= this.entries.length) throw new RangeError(`history index ${index} 범위 초과`);
    this.index = index;
    return this.current;
  }
}

/**
 * 패치 목록을 거꾸로 되돌리는 패치 목록. diff 를 다시 하지 않고 만든다.
 *  패치에는 옛 값(oldText · oldValue · oldNode · REMOVE 의 node)이 들어 있으므로 하나하나 뒤집을 수 있다.
 *  순서도 거꾸로: p1 … pk 를 적용한 뒤 inv(pk) … inv(p1) 을 적용하면 처음 상태로 돌아온다.
 */
export function invertPatches(patches) {
  const out = new Array(patches.length);
  for (let i = patches.length - 1, j = 0; i >= 0; i--, j++) out[j] = invertOne(patches[i]);
  return out;
}

function invertOne(p) {
  switch (p.type) {
    case PatchType.TEXT:
      return { type: PatchType.TEXT, path: p.path, text: p.oldText, oldText: p.text };
    case PatchType.PROPS:
      return { type: PatchType.PROPS, path: p.path, changes: p.changes.map((c) => ({ name: c.name, value: c.oldValue, oldValue: c.value })) };
    case PatchType.INSERT:
      return { type: PatchType.REMOVE, path: p.path, index: p.index, node: p.node };
    case PatchType.REMOVE:
      return { type: PatchType.INSERT, path: p.path, index: p.index, node: p.node };
    case PatchType.MOVE:
      // from → to (뺀 뒤 기준) 의 반대는 to → from: 옮긴 노드는 지금 to 에 있고, 빼면 원래 자리가 from 이다
      return { type: PatchType.MOVE, path: p.path, from: p.to, to: p.from, key: p.key };
    case PatchType.REPLACE:
      if (p.node == null && p.path.length > 0) {
        // 노드를 지운 REPLACE 의 반대 = 그 자리에 옛 노드를 다시 넣기
        return { type: PatchType.INSERT, path: p.path.slice(0, -1), index: p.path[p.path.length - 1], node: p.oldNode };
      }
      return { type: PatchType.REPLACE, path: p.path, node: p.oldNode, oldNode: p.node };
    default:
      throw new Error(`invertPatches: 알 수 없는 패치 타입 ${p.type}`);
  }
}

/**
 * 키프레임 + 델타 히스토리 — 동영상 코덱의 I-프레임 / P-프레임, DB 의 체크포인트 + 로그와 같은 구조.
 *  StateHistory 는 화면(VNode 트리) 전체를 매번 저장한다. 1,000줄 화면이면 기록 하나마다 1,000줄짜리 트리.
 *  DeltaHistory 는 깊이 keyframeEvery 마다 트리 하나(키프레임)만 두고, 그 사이는 앞으로 · 뒤로 가는 패치만 저장한다.
 *   - 한 칸 이동 (뒤로가기 · 앞으로가기): 저장해 둔 패치를 그대로 돌려준다 → diff 를 하지 않는다.
 *   - 멀리 이동 (go): 목표에서 위로 올라가 가장 가까운 키프레임(또는 현재 위치)을 찾아, 패치를 차례로 VNode 에 적용해
 *                     목표를 만들고, 실제 DOM 에는 diff(현재, 목표) 한 번의 결과만 적용한다.
 *   - 뒤로 가는 패치는 앞으로 가는 패치를 뒤집어 만든다 (invertPatches) — 기록할 때 diff 를 한 번 더 하지 않는다.
 *
 *  branching: true 이면 분기 히스토리(Undo Tree): 뒤로 간 다음 새로 기록해도 원래의 "미래" 를 버리지 않고 갈래로 남긴다.
 *   - 기록은 만든 순서대로 entries 에 쌓이고, 각 기록은 부모(parent)를 가진다.
 *   - 뒤로가기 = 부모로, 앞으로가기 = 마지막으로 다녀온 자식으로.
 *   - limit 을 넘으면: 지금 위치로 오는 길에 없는 갈래 끝(잎) 중 가장 오래된 것부터 버린다.
 *     그런 잎이 없으면(기록이 일직선이면) 가장 오래된 첫 기록을 버린다 — 분기 없는 모드와 같다.
 *     지금 위치와 그 조상(뒤로가기로 갈 수 있는 길)은 버리지 않는다.
 *
 *  API 는 StateHistory 와 같다 (current · canBack · canForward · push · back · forward · go · entries · index).
 *  이동할 때 쓸 패치는 travel(target) 로 받는다.
 */
export class DeltaHistory {
  constructor(initial, { limit = 100, keyframeEvery = 10, branching = false } = {}) {
    this.entries = [{ label: '초기 상태', time: Date.now(), parent: -1, depth: 0, lastChild: -1, fwd: null, bwd: null, keyframe: initial }];
    this.index = 0;
    this.limit = limit;
    this.keyframeEvery = Math.max(1, keyframeEvery);
    this.branching = branching;
    this.cur = initial;
  }

  get current() {
    return this.cur;
  }

  get canBack() {
    return this.entries[this.index].parent !== -1;
  }

  get canForward() {
    return this.entries[this.index].lastChild !== -1;
  }

  /**
   * @param {object} vnode 새 화면
   * @param {string} label
   * @param {Array} [forwardPatches] 이미 계산한 diff(현재, vnode) 가 있으면 넘긴다 (다시 계산하지 않음)
   */
  push(vnode, label = '', forwardPatches) {
    const fwd = forwardPatches ?? diff(this.cur, vnode);
    const bwd = invertPatches(fwd); // 예전: diff(vnode, this.cur) — 기록마다 diff 한 번 더
    if (!this.branching) this.entries.splice(this.index + 1); // 지금 위치 뒤의 "미래" 는 버린다
    const parent = this.index;
    const depth = this.entries[parent].depth + 1;
    const i = this.entries.length;
    const keyframe = depth % this.keyframeEvery === 0 ? vnode : null;
    this.entries.push({ label, time: Date.now(), parent, depth, lastChild: -1, fwd, bwd, keyframe });
    this.entries[parent].lastChild = i;
    this.index = i;
    this.cur = vnode;
    while (this.entries.length > this.limit && this.#prune());
    return vnode;
  }

  /**
   * 기록 하나를 버린다 → 버렸으면 true.
   *  1) 지금 위치로 오는 길에 없는 잎(자식이 없는 기록) 중 가장 오래된 것
   *  2) 없으면 첫 기록 (자식이 하나뿐이고 지금 위치가 아닐 때) — 그 자식이 새 첫 기록이 되므로 키프레임을 만들어 둔다
   */
  #prune() {
    const E = this.entries;
    const onPath = new Set(this.#ancestors(this.index));
    const children = new Int32Array(E.length);
    for (const e of E) if (e.parent !== -1) children[e.parent]++;
    for (let k = 0; k < E.length; k++) {
      if (children[k] === 0 && !onPath.has(k)) {
        this.#remove(k);
        return true;
      }
    }
    if (E.length > 1 && children[0] === 1 && this.index !== 0) {
      const child = E.findIndex((e) => e.parent === 0);
      const c = E[child];
      if (!c.keyframe) c.keyframe = applyPatchesToVNode(E[0].keyframe, c.fwd);
      c.fwd = c.bwd = null;
      c.parent = -1;
      this.#remove(0);
      return true;
    }
    return false; // 버릴 수 있는 기록이 없다 (모두 지금 위치로 오는 길)
  }

  /** 기록 k 를 배열에서 빼고, 뒤쪽 번호들을 한 칸씩 당긴다 */
  #remove(k) {
    const E = this.entries;
    const parent = E[k].parent;
    E.splice(k, 1);
    const fix = (i) => (i > k ? i - 1 : i);
    for (const e of E) {
      if (e.parent !== -1) e.parent = fix(e.parent);
      if (e.lastChild === k) e.lastChild = -1;
      else if (e.lastChild !== -1) e.lastChild = fix(e.lastChild);
    }
    this.index = fix(this.index);
    // 버린 기록이 앞으로가기의 목적지였다면, 남은 자식 중 가장 최근 것을 따라가게 한다
    if (parent !== -1) {
      const p = fix(parent);
      if (E[p].lastChild === -1) {
        for (let i = E.length - 1; i >= 0; i--) if (E[i].parent === p) { E[p].lastChild = i; break; }
      }
    }
  }

  /** i 에서 루트까지의 조상 목록 (i 포함) */
  #ancestors(i) {
    const out = [];
    for (let k = i; k !== -1; k = this.entries[k].parent) out.push(k);
    return out;
  }

  /**
   * target 위치로 이동하고, 실제 DOM 에 적용할 패치를 돌려준다.
   * @param {number} target
   * @param {object} [options] { keep } — diff 에 넘길 포커스 key (focusedKeys)
   * @returns {{ vnode, patches, via: 'none' | 'delta' | 'delta-keep' | 'keyframe' | 'replay', steps: number }}
   */
  travel(target, options) {
    if (target < 0 || target >= this.entries.length) throw new RangeError(`history index ${target} 범위 초과`);
    const from = this.index;
    if (target === from) return { vnode: this.cur, patches: [], via: 'none', steps: 0 };
    const E = this.entries;

    // 한 칸: 부모로 (뒤로) 또는 자식으로 (앞으로) — 저장된 패치 그대로 (diff 없음)
    const up = E[from].parent === target;
    if (up || E[target].parent === from) {
      let patches = up ? E[from].bwd : E[target].fwd;
      const prev = this.cur;
      this.cur = applyPatchesToVNode(prev, patches);
      this.#arrive(target);
      // 저장된 패치는 기록할 때 만들어 "입력 중인 줄" 을 모른다. 그 줄을 옮기는 패치면 그때만 diff 를 다시 한다.
      const keep = options?.keep;
      if (keep && patches.some((p) => p.type === PatchType.MOVE && keep.has(p.key))) {
        return { vnode: this.cur, patches: diff(prev, this.cur, [], [], options), via: 'delta-keep', steps: 1 };
      }
      return { vnode: this.cur, patches, via: 'delta', steps: 1 };
    }

    // 멀리: 두 가지 출발점 중 패치를 덜 적용하는 쪽
    //  (가) 현재 위치에서 공통 조상까지 올라갔다가 목표로 내려가기
    //  (나) 목표의 조상 중 가장 가까운 키프레임에서 내려가기 — 키프레임은 깊이 keyframeEvery 마다 있으므로 많아야 그만큼만 올라간다
    const targetUp = this.#ancestors(target); // [target, 부모, …, 루트]
    const fromUp = this.#ancestors(from);
    const inTarget = new Set(targetUp);
    let lca = -1, upSteps = 0;
    for (const k of fromUp) { if (inTarget.has(k)) { lca = k; break; } upSteps++; }
    const downPath = targetUp.slice(0, targetUp.indexOf(lca)).reverse(); // lca 아래 → target
    let kfAt = -1;
    for (let d = 0; d < targetUp.length; d++) if (E[targetUp[d]].keyframe) { kfAt = d; break; }

    let vnode, via, steps;
    if (kfAt !== -1 && kfAt < upSteps + downPath.length) {
      vnode = E[targetUp[kfAt]].keyframe;
      for (let d = kfAt - 1; d >= 0; d--) vnode = applyPatchesToVNode(vnode, E[targetUp[d]].fwd);
      via = 'keyframe';
      steps = kfAt;
    } else {
      vnode = this.cur;
      for (let k = from; k !== lca; k = E[k].parent) vnode = applyPatchesToVNode(vnode, E[k].bwd);
      for (const k of downPath) vnode = applyPatchesToVNode(vnode, E[k].fwd);
      via = 'replay';
      steps = upSteps + downPath.length;
    }
    vnode = E[target].keyframe ?? vnode; // 키프레임 자리에 도착하면 그 트리를 그대로 (메모리 공유)
    const patches = diff(this.cur, vnode, [], [], options);
    this.cur = vnode;
    this.#arrive(target);
    return { vnode, patches, via, steps };
  }

  /** target 에 도착: 지나온 갈래를 "앞으로가기" 가 따라가도록 조상들의 lastChild 를 맞춘다 */
  #arrive(target) {
    for (let k = target; this.entries[k].parent !== -1; k = this.entries[k].parent) this.entries[this.entries[k].parent].lastChild = k;
    this.index = target;
  }

  back() {
    if (this.canBack) this.travel(this.entries[this.index].parent);
    return this.cur;
  }

  forward() {
    if (this.canForward) this.travel(this.entries[this.index].lastChild);
    return this.cur;
  }

  go(index) {
    this.travel(index);
    return this.cur;
  }
}
