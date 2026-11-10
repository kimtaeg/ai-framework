import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, createElement } from '../src/core/vdom.js';
import { diff } from '../src/core/diff.js';
import { applyPatches } from '../src/core/patch.js';

const ZERO = { created: 0, removed: 0, replaced: 0, propsUpdated: 0, textUpdated: 0, moved: 0 };
const li = (key, text = key) => h('li', { key, 'data-key': key }, text);
const list = (...keys) => h('ul', null, ...keys.map((k) => li(k)));

// old를 그려 두고 diff(old, next)를 적용한 뒤, 결과 DOM이 next를 처음부터 그린 것과 같은지 확인한다
function patchAndCheck(old, next) {
  const container = makeContainer();
  if (old) container.appendChild(createElement(old));
  const counts = applyPatches(container, diff(old, next));
  const expected = next ? createElement(next).outerHTML : '';
  assert.equal(container.innerHTML, expected);
  return { container, counts };
}

const keyedNodes = (container) => Object.fromEntries([...container.querySelectorAll('li')].map((el) => [el.dataset.key, el]));

describe('applyPatches — 5가지 케이스와 변경 횟수', () => {
  test('바뀐 것이 없으면 모두 0', () => {
    assert.deepEqual(patchAndCheck(h('p', null, 'a'), h('p', null, 'a')).counts, ZERO);
  });

  test('CREATE · REMOVE · REPLACE · UPDATE_PROPS · UPDATE_TEXT', () => {
    const old = h('div', { class: 'a', title: 't' }, h('h3', null, '제목'), h('b', null, '굵게'), h('p', null, '사라짐'));
    const next = h('div', { class: 'b' }, h('h3', null, '새 제목'), h('i', null, '굵게'), h('span', null, '없던 것'), h('em', null, '추가'));
    const { counts } = patchAndCheck(old, next);
    // p→span은 태그가 달라 REPLACE, em은 CREATE
    assert.deepEqual(counts, { ...ZERO, created: 1, replaced: 2, propsUpdated: 1, textUpdated: 1 });
  });

  test('바뀐 곳만 고친다: 루트와 바뀌지 않은 형제는 같은 DOM 노드', () => {
    const container = makeContainer();
    const old = h('div', null, h('h3', null, '제목'), h('p', null, '본문'));
    container.appendChild(createElement(old));
    const [root, h3] = [container.firstChild, container.querySelector('h3')];
    applyPatches(container, diff(old, h('div', null, h('h3', null, '제목'), h('p', null, '바뀜'))));
    assert.equal(container.firstChild, root);
    assert.equal(container.querySelector('h3'), h3);
  });

  test('루트 교체 · 빈 컨테이너에 처음 그리기 · 전부 지우기', () => {
    assert.equal(patchAndCheck(h('div', null, 'a'), h('section', null, 'a')).counts.replaced, 1);
    assert.equal(patchAndCheck(null, h('p', null, '처음')).counts.created, 1);
    assert.equal(patchAndCheck(h('p', null, '끝'), null).counts.removed, 1);
  });

  test('텍스트 ↔ 요소 교체', () => {
    patchAndCheck(h('p', null, 'a'), h('p', null, h('b', null, 'a')));
    patchAndCheck(h('p', null, h('b', null, 'a')), h('p', null, 'a'));
  });

  test('onApply로 바뀐 노드를 알려 준다 (하이라이트용)', () => {
    const container = makeContainer();
    const old = h('ul', null, li('a'), li('b'));
    container.appendChild(createElement(old));
    const touched = [];
    applyPatches(container, diff(old, h('ul', null, li('b'), li('a', 'A!'))), { onApply: (node, patch) => touched.push([patch.type, node.nodeName]) });
    assert.deepEqual(touched.map(([type]) => type).sort(), ['MOVE', 'UPDATE_TEXT']);
  });
});

describe('applyPatches — key 리스트', () => {
  test('순서 뒤집기: MOVE 3번, 같은 key는 같은 DOM 노드를 재사용', () => {
    const container = makeContainer();
    const old = list('a', 'b', 'c', 'd');
    container.appendChild(createElement(old));
    const before = keyedNodes(container);
    const counts = applyPatches(container, diff(old, list('d', 'c', 'b', 'a')));
    assert.equal(container.innerHTML, createElement(list('d', 'c', 'b', 'a')).outerHTML);
    assert.deepEqual(counts, { ...ZERO, moved: 3 });
    const after = keyedNodes(container);
    for (const key of ['a', 'b', 'c', 'd']) assert.equal(after[key], before[key]);
  });

  test('맨 뒤를 맨 앞으로: 실제로도 노드 하나만 옮긴다', () => {
    assert.deepEqual(patchAndCheck(list('a', 'b', 'c', 'd'), list('d', 'a', 'b', 'c')).counts, { ...ZERO, moved: 1 });
  });

  test('중간 삽입 · 중간 삭제 · 전부 삭제', () => {
    assert.deepEqual(patchAndCheck(list('a', 'b', 'c'), list('a', 'x', 'b', 'c')).counts, { ...ZERO, created: 1 });
    assert.deepEqual(patchAndCheck(list('a', 'b', 'c'), list('a', 'c')).counts, { ...ZERO, removed: 1 });
    assert.deepEqual(patchAndCheck(list('a', 'b', 'c'), h('ul', null)).counts, { ...ZERO, removed: 3 });
  });

  test('옮겨진 항목 안의 텍스트도 함께 바뀐다', () => {
    patchAndCheck(list('a', 'b', 'c'), h('ul', null, li('c', 'C!'), li('a'), li('b', 'B!')));
  });

  test('key가 일부만 있는 리스트', () => {
    const old = h('ul', null, li('a'), h('li', null, '무명1'), li('b'), h('li', null, '무명2'));
    patchAndCheck(old, h('ul', null, li('b'), h('li', null, '무명1'), h('li', null, '무명3'), li('a')));
  });

  test('key 중복이어도 결과 DOM은 맞다', (t) => {
    t.mock.method(console, 'warn', () => {});
    patchAndCheck(list('a', 'a', 'b'), list('b', 'a', 'a', 'c'));
  });

  test('무작위 순서 바꾸기·삽입·삭제 200번: 결과가 항상 맞고 살아남은 key는 같은 노드', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pool = 'abcdefghij'.split('');
    for (let round = 0; round < 200; round++) {
      const oldKeys = pool.filter(() => random() < 0.6);
      const newKeys = pool.filter(() => random() < 0.6).sort(() => random() - 0.5);
      const container = makeContainer();
      const old = list(...oldKeys);
      container.appendChild(createElement(old));
      const before = keyedNodes(container);
      applyPatches(container, diff(old, list(...newKeys)));
      assert.equal(container.innerHTML, createElement(list(...newKeys)).outerHTML, `round ${round}: ${oldKeys} → ${newKeys}`);
      const after = keyedNodes(container);
      for (const key of newKeys) if (before[key]) assert.equal(after[key], before[key], `round ${round}: ${key} 재사용`);
    }
  });
});

describe('applyPatches — 특수 속성과 이벤트', () => {
  test('속성 삭제, class, style 객체 ↔ 문자열', () => {
    patchAndCheck(h('p', { class: 'a', title: 't', style: { color: 'red' } }), h('p', { class: 'b', style: 'color: blue;' }));
    patchAndCheck(h('p', { style: 'color: blue;' }), h('p', { style: { fontSize: '12px' } }));
  });

  test('value: 사용자가 입력한 뒤에도 patch로 화면 값이 바뀐다', () => {
    const container = makeContainer();
    const old = h('input', { value: 'a' });
    container.appendChild(createElement(old));
    const input = container.firstChild;
    input.value = '사용자 입력';
    applyPatches(container, diff(old, h('input', { value: 'b' })));
    assert.equal(input.value, 'b');
  });

  test('checked: 켜고 끄기가 화면 상태(property)에 반영', () => {
    const container = makeContainer();
    const on = h('input', { type: 'checkbox', checked: true });
    container.appendChild(createElement(on));
    applyPatches(container, diff(on, h('input', { type: 'checkbox' })));
    assert.equal(container.firstChild.checked, false);
  });

  test('이벤트 핸들러 추가 → 교체 → 삭제', () => {
    const container = makeContainer();
    const calls = [];
    const v0 = h('button', null, '눌러');
    const v1 = h('button', { onClick: () => calls.push('첫') }, '눌러');
    const v2 = h('button', { onClick: () => calls.push('둘') }, '눌러');
    const v3 = h('button', null, '눌러');
    container.appendChild(createElement(v0));
    const button = container.firstChild;

    applyPatches(container, diff(v0, v1));
    button.click();
    applyPatches(container, diff(v1, v2));
    button.click();
    applyPatches(container, diff(v2, v3));
    button.click();
    assert.deepEqual(calls, ['첫', '둘']); // 교체 뒤엔 새 핸들러만, 삭제 뒤엔 아무것도
  });
});
