import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { FunctionComponent } from '../src/core/component.js';
import { useState, useEffect } from '../src/core/hooks.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 클릭 한 번에 서로 다른 state 3개를 바꾸는 App
function mountThreeSetters(options) {
  let setters;
  const container = makeContainer();
  const component = new FunctionComponent(() => {
    const [a, setA] = useState(0);
    const [b, setB] = useState(0);
    const [c, setC] = useState(0);
    setters = { setA, setB, setC };
    return h('p', null, `${a}${b}${c}`);
  }, container, options).mount();
  const clickOnce = () => {
    setters.setA(1);
    setters.setB(2);
    setters.setC(3);
  };
  return { container, component, clickOnce };
}

describe('배칭 (scheduler)', () => {
  test('켜면: 같은 틱의 setState 3번 → update 1번, 결과는 3개 모두 반영', async () => {
    const { container, component, clickOnce } = mountThreeSetters();
    clickOnce();
    assert.equal(container.textContent, '000'); // 예약만
    await flush();
    assert.equal(container.textContent, '123');
    assert.equal(component.renderCount, 2);
    assert.equal(component.lastBatchSize, 3);
  });

  test('끄면: setState마다 바로 update → 3번', () => {
    const { container, component, clickOnce } = mountThreeSetters({ batching: false });
    clickOnce();
    assert.equal(container.textContent, '123'); // 기다리지 않아도 이미 반영
    assert.equal(component.renderCount, 4);
  });

  test('다른 틱이면 따로 렌더된다', async () => {
    const { component, clickOnce } = mountThreeSetters();
    clickOnce();
    await flush();
    component.hooks[0].setState(9);
    await flush();
    assert.equal(component.renderCount, 3);
  });

  test('같은 틱의 렌더가 50번 넘게 이어지면 멈추고 원인을 알린다 (deps 없는 effect 안의 setState)', async (t) => {
    const messages = [];
    t.mock.method(console, 'error', (message) => messages.push(String(message)));
    for (const batching of [true, false]) {
      let renders = 0;
      new FunctionComponent(() => {
        renders++;
        const [n, setN] = useState(0);
        useEffect(() => setN(n + 1));
        return h('p', null, String(n));
      }, makeContainer(), { batching }).mount();
      await flush();
      await flush();
      assert.ok(renders <= 52, `배칭 ${batching}: 렌더 ${renders}번`);
    }
    assert.equal(messages.filter((m) => m.includes('deps 없는 useEffect 안에서 setState')).length, 2);
  });

  test('틱이 바뀌면 다시 센다 (50번 넘게 클릭해도 문제없음)', async () => {
    const { component, container } = mountThreeSetters();
    for (let i = 1; i <= 60; i++) {
      component.hooks[0].setState(i);
      await flush();
    }
    assert.equal(container.textContent, '6000');
    assert.equal(component.renderCount, 61);
  });

  test('예약된 update가 있는 채로 unmount하면 그 update는 실행되지 않는다', async () => {
    const { component, clickOnce } = mountThreeSetters();
    clickOnce();
    component.unmount();
    await flush();
    assert.equal(component.renderCount, 1);
  });
});
