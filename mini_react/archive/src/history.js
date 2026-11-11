// VNode 기록 (브라우저 뒤로/앞으로 가기와 같은 방식)
//   stack: [v0, v1, v2, ...]
//   index: 지금 보고 있는 칸 (비어 있으면 -1)

export class History {
  constructor() {
    this.stack = [];
    this.index = -1;
  }

  // 뒤로 간 상태에서 push하면 index 뒤쪽 기록은 버린다
  push(vnode) {
    this.stack.length = this.index + 1;
    this.stack.push(vnode);
    this.index = this.stack.length - 1;
    return vnode;
  }

  // 처음/끝에서 호출하면 아무것도 바꾸지 않고 현재 VNode를 돌려준다
  back() {
    if (this.canBack()) this.index--;
    return this.current();
  }

  forward() {
    if (this.canForward()) this.index++;
    return this.current();
  }

  current() {
    return this.index === -1 ? null : this.stack[this.index];
  }

  canBack() {
    return this.index > 0;
  }

  canForward() {
    return this.index < this.stack.length - 1;
  }
}
