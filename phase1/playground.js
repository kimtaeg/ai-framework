/**
 * Phase 1 Playground 컨트롤러 (UI 와 분리된 순수 로직 → 단위/기능 테스트 가능)
 *
 *  로드 시   : 실제 영역 DOM → VDOM 변환 → 히스토리[0] 저장 → 테스트 영역 렌더링
 *  Patch    : 테스트 영역 → 새 VDOM → diff(이전, 새) → 실제 영역에 변경분만 patch → 히스토리 push
 *  뒤로/앞으로: 히스토리의 VDOM 으로 이동 → 실제 영역에는 바뀐 부분만 patch + 테스트 영역 재렌더링
 *
 *  히스토리는 키프레임 + 델타 (DeltaHistory): 10칸마다 VDOM 하나, 그 사이는 앞 · 뒤 패치만 저장한다.
 *   - 한 칸 이동은 저장된 패치를 그대로 적용한다 (diff 없음)
 *   - 실제 영역을 다시 만들지 않고 patch 하므로, 사용자가 입력하던 값 · 포커스 · 스크롤이 이동 뒤에도 남는다
 *     (멀리 이동할 때는 포커스가 있는 줄을 되도록 옮기지 않도록 diff 에 알려 준다)
 */

import { containerToVNode, normalizeDom, countNodes, createElement, focusedKeys } from '../src/lib/vdom.js';
import { diff, summarizePatches } from '../src/lib/diff.js';
import { applyPatches, applyPatch } from '../src/lib/patch.js';
import { DeltaHistory } from '../src/lib/history.js';

export class Playground {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.actualRoot          실제 영역 컨테이너
   * @param {(vnode) => void} opts.renderTestArea  테스트 영역을 VDOM 으로 다시 그리는 함수
   * @param {(result) => void} [opts.onCommit]     patch 가 끝날 때마다 호출 (로그/하이라이트)
   */
  constructor({ actualRoot, renderTestArea, onCommit }) {
    this.actualRoot = actualRoot;
    this.renderTestArea = renderTestArea;
    this.onCommit = onCommit ?? (() => {});
    this.observer = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {})
      : null;
  }

  init() {
    // VDOM 으로 표현하지 않는 노드(주석, 들여쓰기 공백)를 정리해 DOM 인덱스와 VDOM 인덱스를 일치시킨다.
    normalizeDom(this.actualRoot);
    const vnode = containerToVNode(this.actualRoot);
    this.history = new DeltaHistory(vnode, { keyframeEvery: 10, branching: true }); // 뒤로 간 뒤 새로 고쳐도 원래 미래는 갈래로 남는다
    this.renderTestArea(vnode);
    return vnode;
  }

  get current() {
    return this.history.current;
  }

  /** 테스트 영역에서 만든 새 VDOM 을 실제 영역에 반영 */
  patch(nextVNode, label = 'Patch') {
    const prev = this.history.current;
    const result = this.#commit(prev, nextVNode, 'patch');
    if (result.patches.length > 0) {
      this.history.push(nextVNode, label, result.patches);
      result.historyIndex = this.history.index;
      result.historyLength = this.history.entries.length;
    }
    // 정규화된 형태로 테스트 영역을 다시 그려 VDOM 과 화면을 일치시킨다.
    this.renderTestArea(nextVNode);
    this.onCommit(result);
    return result;
  }

  // ------------------------------------------------------------ 단계별 Patch
  // diff 결과를 한 번에 적용하지 않고 하나씩 적용해 보면서, 패치 순서 규칙을 눈으로 확인한다.

  /** 단계별 적용 시작. 패치 목록을 계산만 하고 아직 DOM 은 건드리지 않는다. */
  beginSteps(nextVNode, label = '단계별 Patch') {
    const prev = this.history.current;
    const patches = diff(prev, nextVNode);
    this.steps = { prev, next: nextVNode, label, patches, index: 0, applied: [], mutations: 0, duration: 0 };
    return this.steps;
  }

  get inSteps() {
    return !!this.steps;
  }

  /** 다음 패치 하나 적용 */
  stepNext() {
    const s = this.steps;
    if (!s || s.index >= s.patches.length) return null;
    const patch = s.patches[s.index];
    this.observer?.observe(this.actualRoot, { subtree: true, childList: true, attributes: true, characterData: true });
    const start = performance.now();
    const node = applyPatch(this.actualRoot, patch);
    s.duration += performance.now() - start;
    const mutations = this.observer ? this.observer.takeRecords().length : 0;
    this.observer?.disconnect();
    s.mutations += mutations;
    s.applied.push({ patch, node });
    s.index++;
    return { patch, node, mutations, index: s.index, total: s.patches.length, done: s.index >= s.patches.length };
  }

  /** 남은 패치를 모두 적용하고 히스토리에 기록 */
  finishSteps() {
    const s = this.steps;
    if (!s) return null;
    while (s.index < s.patches.length) this.stepNext();
    this.steps = null;
    if (s.patches.length) this.history.push(s.next, s.label, s.patches);
    const result = {
      kind: 'patch',
      prev: s.prev,
      next: s.next,
      patches: s.patches,
      applied: s.applied,
      summary: summarizePatches(s.patches),
      mutations: s.mutations,
      totalNodes: countNodes(s.next) - 1,
      duration: s.duration,
      historyIndex: this.history.index,
      historyLength: this.history.entries.length,
    };
    this.renderTestArea(s.next);
    this.onCommit(result);
    return result;
  }

  /** 중간에 취소: 실제 영역을 시작 전 상태로 되돌린다 */
  cancelSteps() {
    const s = this.steps;
    if (!s) return;
    this.steps = null;
    this.actualRoot.replaceChildren(...s.prev.children.map((c) => createElement(c)));
    this.renderTestArea(s.prev);
  }

  back() {
    if (!this.history.canBack) return null;
    return this.#travel(this.history.index - 1, 'back');
  }

  forward() {
    if (!this.history.canForward) return null;
    return this.#travel(this.history.index + 1, 'forward');
  }

  go(index) {
    if (index === this.history.index) return null;
    return this.#travel(index, 'go');
  }

  #travel(target, kind) {
    const prev = this.history.current;
    const keep = focusedKeys(this.actualRoot);
    const t0 = performance.now();
    const moved = this.history.travel(target, keep ? { keep } : undefined);
    const historyMs = performance.now() - t0; // 패치를 꺼내거나(한 칸) 키프레임에서 다시 만드는(멀리) 시간
    const result = this.#apply(prev, moved.vnode, kind, moved.patches);
    Object.assign(result, { via: moved.via, steps: moved.steps, historyMs });
    this.renderTestArea(moved.vnode);
    this.onCommit(result);
    return result;
  }

  #commit(prev, next, kind) {
    const keep = focusedKeys(this.actualRoot);
    return this.#apply(prev, next, kind, diff(prev, next, [], [], keep ? { keep } : undefined));
  }

  #apply(prev, next, kind, patches) {
    const applied = [];
    this.observer?.observe(this.actualRoot, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    const start = performance.now();
    let recovered = false;
    try {
      applyPatches(this.actualRoot, patches, { onApply: (p, node) => applied.push({ patch: p, node }) });
    } catch (error) {
      // 패치가 중간에 실패하면 실제 영역이 VDOM 과 어긋난다 → 목표 VDOM 으로 통째로 다시 그려 맞춘다
      this.actualRoot.replaceChildren(...next.children.map((c) => createElement(c)));
      recovered = error.message;
    }
    const duration = performance.now() - start;
    // MutationObserver: 실제 DOM 에 일어난 변경을 브라우저가 기록한 목록 → 최소 변경 검증
    const mutations = this.observer ? this.observer.takeRecords() : [];
    this.observer?.disconnect();
    return {
      kind,
      prev,
      next,
      patches,
      applied,
      summary: summarizePatches(patches),
      mutations: mutations.length,
      totalNodes: countNodes(next) - 1, // 전체 재렌더링 시 다시 만들어야 하는 노드 수 (루트 제외)
      duration,
      recovered, // 패치가 실패해 통째로 다시 그렸으면 그 오류 메시지 (아니면 false)
      historyIndex: this.history.index,
      historyLength: this.history.entries.length,
    };
  }
}
