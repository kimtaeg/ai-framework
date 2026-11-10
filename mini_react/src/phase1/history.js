// 뒤로/앞으로 기록 (브라우저 방문 기록과 같은 방식)
//   stack: [v0, v1, v2, ...]   index: 지금 보고 있는 칸 (비어 있으면 -1)
// 과거 시점에서 새로 push하면 그 뒤 기록은 지운다. 처음·끝에서 back·forward를 눌러도 에러 없이 그대로.

export class History {
  constructor() {
    this.stack = [];
    this.index = -1;
  }

  push(entry) {
    this.stack.length = this.index + 1; // 뒤로 가 있었다면 앞쪽(미래) 기록을 잘라낸다
    this.stack.push(entry);
    this.index = this.stack.length - 1;
    return entry;
  }

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

  // 화면 표시용 "3 / 5" (1부터 센다)
  position() {
    return { index: this.index + 1, total: this.stack.length };
  }
}
