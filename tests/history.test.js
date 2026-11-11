import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StateHistory } from '../src/lib/history.js';

describe('StateHistory', () => {
  test('push / back / forward', () => {
    const hst = new StateHistory('v0');
    hst.push('v1');
    hst.push('v2');
    assert.equal(hst.current, 'v2');
    assert.equal(hst.back(), 'v1');
    assert.equal(hst.back(), 'v0');
    assert.equal(hst.canBack, false);
    assert.equal(hst.back(), 'v0', '처음에서 더 뒤로 가지 않음');
    assert.equal(hst.forward(), 'v1');
    assert.equal(hst.forward(), 'v2');
    assert.equal(hst.canForward, false);
  });

  test('뒤로 간 상태에서 push 하면 미래 기록을 버린다', () => {
    const hst = new StateHistory('v0');
    hst.push('v1');
    hst.push('v2');
    hst.back();
    hst.push('v3');
    assert.deepEqual(hst.entries.map((e) => e.vnode), ['v0', 'v1', 'v3']);
    assert.equal(hst.canForward, false);
  });

  test('go(index) 와 범위 검사', () => {
    const hst = new StateHistory('v0');
    hst.push('v1');
    assert.equal(hst.go(0), 'v0');
    assert.throws(() => hst.go(5), RangeError);
  });

  test('limit 을 넘으면 오래된 기록부터 제거', () => {
    const hst = new StateHistory(0, { limit: 3 });
    for (let i = 1; i <= 5; i++) hst.push(i);
    assert.deepEqual(hst.entries.map((e) => e.vnode), [3, 4, 5]);
    assert.equal(hst.index, 2);
  });
});
