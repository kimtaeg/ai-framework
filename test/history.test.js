import { describe, it, expect } from 'vitest';
import { History } from '../src/history.js';
import { h } from '../src/vdom.js';

const v = (n) => h('div', null, String(n));

// v(0)..v(n-1)을 차례로 push한 History
function historyOf(n) {
  const history = new History();
  for (let i = 0; i < n; i++) history.push(v(i));
  return history;
}

describe('History', () => {
  it('비어 있으면 current는 null, 이동 불가', () => {
    const history = new History();
    expect(history.current()).toBeNull();
    expect(history.canBack()).toBe(false);
    expect(history.canForward()).toBe(false);
    expect(history.back()).toBeNull();
    expect(history.forward()).toBeNull();
  });

  it('push하면 current가 방금 넣은 VNode다', () => {
    const history = new History();
    const vnode = v(0);
    expect(history.push(vnode)).toBe(vnode);
    expect(history.current()).toBe(vnode);
    expect(history.canBack()).toBe(false);
    expect(history.canForward()).toBe(false);
  });

  it('back/forward로 한 칸씩 이동한다', () => {
    const history = historyOf(3);
    expect(history.back()).toEqual(v(1));
    expect(history.canBack()).toBe(true);
    expect(history.canForward()).toBe(true);
    expect(history.forward()).toEqual(v(2));
    expect(history.current()).toEqual(v(2));
  });

  it('처음에서 back하면 에러 없이 그대로', () => {
    const history = historyOf(2);
    history.back();
    expect(history.canBack()).toBe(false);
    expect(() => history.back()).not.toThrow();
    expect(history.current()).toEqual(v(0));
    expect(history.canForward()).toBe(true);
  });

  it('끝에서 forward하면 에러 없이 그대로', () => {
    const history = historyOf(2);
    expect(history.canForward()).toBe(false);
    expect(() => history.forward()).not.toThrow();
    expect(history.current()).toEqual(v(1));
    expect(history.canBack()).toBe(true);
  });

  it('뒤로 간 상태에서 push하면 앞쪽 기록을 잘라낸다', () => {
    const history = historyOf(4); // [0,1,2,3]
    history.back();
    history.back(); // 1을 보는 중
    history.push(v('new')); // [0,1,new]

    expect(history.current()).toEqual(v('new'));
    expect(history.canForward()).toBe(false);
    expect(history.forward()).toEqual(v('new'));
    expect(history.back()).toEqual(v(1));
    expect(history.back()).toEqual(v(0));
    expect(history.canBack()).toBe(false);
  });

  it('처음까지 back한 뒤 push하면 첫 칸만 남는다', () => {
    const history = historyOf(3);
    history.back();
    history.back();
    history.push(v('x'));
    expect(history.back()).toEqual(v(0));
    expect(history.forward()).toEqual(v('x'));
    expect(history.canForward()).toBe(false);
  });

  it('연속 back/forward: 끝을 넘어 눌러도 양 끝에 멈춘다', () => {
    const history = historyOf(5);

    const backs = [];
    for (let i = 0; i < 7; i++) backs.push(history.back());
    expect(backs).toEqual([v(3), v(2), v(1), v(0), v(0), v(0), v(0)]);

    const forwards = [];
    for (let i = 0; i < 7; i++) forwards.push(history.forward());
    expect(forwards).toEqual([v(1), v(2), v(3), v(4), v(4), v(4), v(4)]);
  });

  it('연속 이동을 섞어도 위치가 맞다', () => {
    const history = historyOf(5);
    history.back();
    history.back();
    history.back(); // 1
    history.forward(); // 2
    history.back();
    history.back(); // 0
    history.forward();
    history.forward();
    history.forward(); // 3
    expect(history.current()).toEqual(v(3));
    expect(history.canBack()).toBe(true);
    expect(history.canForward()).toBe(true);
  });
});
