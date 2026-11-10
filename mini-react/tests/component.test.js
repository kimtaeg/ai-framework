import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { expand, FunctionComponent } from '../src/core/component.js';
import { useState } from '../src/core/hooks.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('expand', () => {
  test('함수 컴포넌트를 props와 children으로 실행해 태그만 남은 VNode로 펼친다 (중첩도 끝까지)', () => {
    const Item = ({ text }) => h('li', null, text);
    const List = ({ children }) => h('ul', null, children);
    const tree = h(List, null, h(Item, { text: 'a', key: 'a' }), h(Item, { text: 'b' }));
    assert.deepEqual(expand(tree), h('ul', null, h('li', { key: 'a' }, 'a'), h('li', null, 'b')));
  });

  test('컴포넌트에 준 key는 펼친 결과로 옮겨진다 (리스트 diff에서 항목을 알아보게)', () => {
    const Row = ({ id }) => h('tr', null, id);
    const vdom = expand(h('tbody', null, h(Row, { key: 'o1', id: 'o1' })));
    assert.equal(vdom.children[0].key, 'o1');
  });

  test('null·false를 돌려주면 그 자리가 비고, return을 빠뜨리면(undefined) 에러', () => {
    const Hidden = () => null;
    assert.deepEqual(expand(h('div', null, h(Hidden), 'x')), h('div', null, 'x'));
    function Broken() {}
    assert.throws(() => expand(h(Broken)), /Broken가 undefined/);
  });
});

describe('FunctionComponent', () => {
  test('mount는 처음 그리고, update는 바뀐 곳만 patch한다 (루트 DOM 유지)', async () => {
    const container = makeContainer();
    let setN;
    const component = new FunctionComponent(() => {
      const [n, set] = useState(0);
      setN = set;
      return h('section', null, h('h3', null, '제목'), h('p', null, String(n)));
    }, container).mount();
    const root = container.firstChild;
    const h3 = container.querySelector('h3');

    setN(1);
    await flush();
    assert.equal(container.innerHTML, '<section><h3>제목</h3><p>1</p></section>');
    assert.equal(container.firstChild, root);
    assert.equal(container.querySelector('h3'), h3);
    assert.equal(component.hookIndex, 1); // 이번 렌더에서 Hook 1개를 열었다
  });

  test('onRender로 렌더마다 patch 수·종류별 횟수·소요 시간을 알려 준다', async () => {
    const container = makeContainer();
    const renders = [];
    let setN;
    new FunctionComponent(() => {
      const [n, set] = useState(0);
      setN = set;
      return h('p', null, String(n));
    }, container, { onRender: (info) => renders.push(info) }).mount();
    setN(1);
    await flush();

    assert.equal(renders.length, 2);
    assert.equal(renders[0].type, 'mount');
    const update = renders[1];
    assert.equal(update.type, 'update');
    assert.equal(update.renderCount, 2);
    assert.equal(update.patches.length, 1);
    assert.equal(update.counts.textUpdated, 1);
    assert.equal(typeof update.durationMs, 'number');
    assert.equal(update.batchSize, 1);
  });

  test('renderMode "full"은 diff 없이 통째로 다시 그린다 (같은 화면, 다른 DOM 노드)', async () => {
    const container = makeContainer();
    let setN;
    const renders = [];
    const component = new FunctionComponent(() => {
      const [n, set] = useState(0);
      setN = set;
      return h('section', null, h('h3', null, '제목'), h('p', null, String(n)));
    }, container, { renderMode: 'full', onRender: (info) => renders.push(info) }).mount();
    const h3 = container.querySelector('h3');

    setN(1);
    await flush();
    assert.equal(container.innerHTML, '<section><h3>제목</h3><p>1</p></section>');
    assert.notEqual(container.querySelector('h3'), h3); // 바뀌지 않은 h3까지 새로 만들어짐
    assert.equal(renders.at(-1).patches, null);
    assert.equal(component.renderMode, 'full');
  });

  test('setOptions로 비교 모드·배칭을 실행 중에 바꿀 수 있다', () => {
    const component = new FunctionComponent(() => h('p'), makeContainer()).mount();
    component.setOptions({ renderMode: 'full', batching: false });
    assert.equal(component.renderMode, 'full');
    assert.equal(component.batching, false);
  });

  test('이미 mount된 컴포넌트를 다시 mount하면 에러, unmount 뒤 setState는 무시', async () => {
    const container = makeContainer();
    let setN;
    const component = new FunctionComponent(() => {
      const [n, set] = useState(0);
      setN = set;
      return h('p', null, String(n));
    }, container).mount();
    assert.throws(() => component.mount(), /이미 mount된/);
    component.unmount();
    setN(5);
    await flush();
    assert.equal(container.innerHTML, '');
  });
});
