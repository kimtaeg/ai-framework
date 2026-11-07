/**
 * State History — Virtual DOM 스냅샷의 실행 취소/다시 실행 스택
 *  - push: 현재 위치 뒤의 "미래" 기록은 버리고 새 스냅샷을 쌓는다. (브라우저 히스토리와 동일)
 *  - VNode 는 불변(immutable)으로 취급하므로 참조만 저장해도 안전하다.
 */
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
