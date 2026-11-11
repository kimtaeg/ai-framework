/**
 * State History — Virtual DOM 스냅샷의 실행 취소/다시 실행 스택
 *  - push: 현재 위치 뒤의 "미래" 기록은 버리고 새 스냅샷을 쌓는다. (브라우저 히스토리와 동일)
 *  - VNode 는 불변(immutable)으로 취급하므로 참조만 저장해도 안전하다.
 */
import { diff } from './diff.js';
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
 * 키프레임 + 델타 히스토리 — 동영상 코덱의 I-프레임 / P-프레임, DB 의 체크포인트 + 로그와 같은 구조.
 *  StateHistory 는 화면(VNode 트리) 전체를 매번 저장한다. 1,000줄 화면이면 기록 하나마다 1,000줄짜리 트리.
 *  DeltaHistory 는 keyframeEvery 칸마다 트리 하나(키프레임)만 두고, 그 사이는 앞으로 · 뒤로 가는 패치만 저장한다.
 *   - 한 칸 이동 (뒤로가기 · 앞으로가기): 저장해 둔 패치를 그대로 돌려준다 → diff 를 하지 않는다.
 *   - 멀리 이동 (go): 가장 가까운 키프레임(또는 현재 위치)에서 패치를 차례로 VNode 에 적용해 목표를 만들고,
 *                     실제 DOM 에는 diff(현재, 목표) 한 번의 결과만 적용한다.
 *  API 는 StateHistory 와 같다 (current · canBack · canForward · push · back · forward · go · entries · index).
 *  이동할 때 쓸 패치는 travel(target) 로 받는다.
 */

export class DeltaHistory {
  constructor(initial, { limit = 100, keyframeEvery = 10 } = {}) {
    this.entries = [{ label: '초기 상태', time: Date.now(), fwd: null, bwd: null, keyframe: initial }];
    this.index = 0;
    this.limit = limit;
    this.keyframeEvery = Math.max(1, keyframeEvery);
    this.cur = initial;
  }

  get current() {
    return this.cur;
  }

  get canBack() {
    return this.index > 0;
  }

  get canForward() {
    return this.index < this.entries.length - 1;
  }

  /**
   * @param {object} vnode 새 화면
   * @param {string} label
   * @param {Array} [forwardPatches] 이미 계산한 diff(현재, vnode) 가 있으면 넘긴다 (다시 계산하지 않음)
   */
  push(vnode, label = '', forwardPatches) {
    const fwd = forwardPatches ?? diff(this.cur, vnode);
    const bwd = diff(vnode, this.cur);
    this.entries.splice(this.index + 1); // 지금 위치 뒤의 "미래" 는 버린다 (StateHistory 와 같음)
    const i = this.entries.length;
    const keyframe = i % this.keyframeEvery === 0 ? vnode : null;
    this.entries.push({ label, time: Date.now(), fwd, bwd, keyframe });
    this.index = i;
    this.cur = vnode;
    if (this.entries.length > this.limit) this.#dropOldest();
    return vnode;
  }

  /** 가장 오래된 기록을 버린다. 새 첫 기록은 반드시 키프레임이어야 하므로 그 트리를 만들어 둔다. */
  #dropOldest() {
    const [first, second] = this.entries;
    if (!second.keyframe) second.keyframe = applyPatchesToVNode(first.keyframe, second.fwd);
    second.fwd = second.bwd = null;
    this.entries.shift();
    this.index--;
  }

  /**
   * target 위치로 이동하고, 실제 DOM 에 적용할 패치를 돌려준다.
   * @param {number} target
   * @param {object} [options] { keep } — 멀리 이동할 때 diff 에 넘길 포커스 key (focusedKeys)
   * @returns {{ vnode, patches, via: 'none' | 'delta' | 'keyframe' | 'replay', steps: number }}
   */
  travel(target, options) {
    if (target < 0 || target >= this.entries.length) throw new RangeError(`history index ${target} 범위 초과`);
    const from = this.index;
    if (target === from) return { vnode: this.cur, patches: [], via: 'none', steps: 0 };
    if (Math.abs(target - from) === 1) {
      // 한 칸: 저장된 패치 그대로 (diff 없음)
      let patches = target > from ? this.entries[target].fwd : this.entries[from].bwd;
      const prev = this.cur;
      this.cur = applyPatchesToVNode(prev, patches);
      this.index = target;
      // 저장된 패치는 push 할 때 계산해서 "입력 중인 줄" 을 모른다. 그 줄을 옮기는 패치면 그때만 diff 를 다시 한다.
      const keep = options?.keep;
      if (keep && patches.some((p) => p.type === 'MOVE' && keep.has(p.key))) {
        patches = diff(prev, this.cur, [], [], options);
        return { vnode: this.cur, patches, via: 'delta-keep', steps: 1 };
      }
      return { vnode: this.cur, patches, via: 'delta', steps: 1 };
    }
    // 멀리: 현재 위치와 키프레임들 중 목표에 가장 가까운 곳에서 출발해 VNode 를 다시 만든다
    let start = from, vnode = this.cur, via = 'replay';
    for (let k = 0; k < this.entries.length; k++) {
      const kf = this.entries[k].keyframe;
      if (kf && Math.abs(target - k) < Math.abs(target - start)) { start = k; vnode = kf; via = 'keyframe'; }
    }
    const steps = Math.abs(target - start);
    for (let i = start; i < target; i++) vnode = applyPatchesToVNode(vnode, this.entries[i + 1].fwd);
    for (let i = start; i > target; i--) vnode = applyPatchesToVNode(vnode, this.entries[i].bwd);
    // 키프레임이 있는 자리에 도착하면 그 트리를 그대로 쓴다 (다시 만든 트리와 같지만 메모리를 공유)
    vnode = this.entries[target].keyframe ?? vnode;
    const patches = diff(this.cur, vnode, [], [], options);
    this.cur = vnode;
    this.index = target;
    return { vnode, patches, via, steps };
  }

  back() {
    if (this.canBack) this.travel(this.index - 1);
    return this.cur;
  }

  forward() {
    if (this.canForward) this.travel(this.index + 1);
    return this.cur;
  }

  go(index) {
    this.travel(index);
    return this.cur;
  }
}
