import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, createElement, domToVNode } from '../src/core/vdom.js';

const fromHTML = (html) => {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstChild;
};

describe('h()', () => {
  test('요소 VNode를 만들고 key는 props에서 빼서 따로 둔다', () => {
    assert.deepEqual(h('li', { key: 'a', class: 'item' }, '빨래'), {
      type: 'li',
      key: 'a',
      props: { class: 'item' },
      children: ['빨래'],
    });
  });

  test('props가 없으면 빈 객체, key가 없으면 null', () => {
    assert.deepEqual(h('p'), { type: 'p', key: null, props: {}, children: [] });
  });

  test('null·undefined·true·false 자식은 버리고, 숫자는 문자열로, 배열은 평탄화', () => {
    const vnode = h('div', null, null, undefined, true, false, 0, 7, ['a', ['b']], '');
    assert.deepEqual(vnode.children, ['0', '7', 'a', 'b', '']);
  });

  test('빈 자식이면 children은 빈 배열', () => {
    assert.deepEqual(h('ul', null).children, []);
    assert.deepEqual(h('ul', null, []).children, []);
  });
});

describe('createElement()', () => {
  test('문자열은 텍스트 노드, 요소는 속성·자식까지 만든다', () => {
    const el = createElement(h('p', { id: 'x', class: 'a b' }, '안녕 ', h('b', null, '굵게')));
    assert.equal(el.outerHTML, '<p id="x" class="a b">안녕 <b>굵게</b></p>');
    assert.equal(createElement('텍스트').nodeType, Node.TEXT_NODE);
  });

  test('key는 DOM 속성으로 그리지 않는다 (data-key는 그대로)', () => {
    const el = createElement(h('li', { key: 'a', 'data-key': 'a' }, 'x'));
    assert.equal(el.outerHTML, '<li data-key="a">x</li>');
  });

  test('이벤트 핸들러를 붙인다', () => {
    let clicks = 0;
    const el = createElement(h('button', { onClick: () => clicks++ }, '눌러'));
    el.click();
    assert.equal(clicks, 1);
    assert.equal(el.hasAttribute('onclick'), false);
  });

  test('style 객체와 문자열, value·checked는 property까지 반영', () => {
    const box = createElement(h('div', { style: { color: 'red', fontSize: '12px' } }));
    assert.equal(box.getAttribute('style'), 'color: red; font-size: 12px;');
    const input = createElement(h('input', { value: 'hi', checked: true, type: 'checkbox' }));
    assert.equal(input.value, 'hi');
    assert.equal(input.checked, true);
  });
});

describe('domToVNode()', () => {
  test('요소·속성·텍스트를 VNode로 바꾼다', () => {
    assert.deepEqual(domToVNode(fromHTML('<p id="x">안녕 <b>굵게</b></p>')), h('p', { id: 'x' }, '안녕 ', h('b', null, '굵게')));
  });

  test('주석은 버린다', () => {
    assert.deepEqual(domToVNode(fromHTML('<div><!-- 메모 -->a</div>')), h('div', null, 'a'));
    assert.equal(domToVNode(document.createComment('x')), null);
  });

  test('줄바꿈이 섞인 공백 텍스트(들여쓰기)는 버리고, 같은 줄 공백은 남긴다', () => {
    const vnode = domToVNode(fromHTML('<ul>\n  <li>a</li>\n  <li><b>x</b> <i>y</i></li>\n</ul>'));
    assert.deepEqual(vnode, h('ul', null, h('li', null, 'a'), h('li', null, h('b', null, 'x'), ' ', h('i', null, 'y'))));
  });

  test('data-key 속성을 key로 읽는다 (data-key prop도 남겨 왕복이 가능)', () => {
    const vnode = domToVNode(fromHTML('<li data-key="a">x</li>'));
    assert.equal(vnode.key, 'a');
    assert.deepEqual(vnode.props, { 'data-key': 'a' });
  });

  test('createElement → domToVNode 왕복 결과가 같다', () => {
    const vnode = h('section', { class: 'card' }, h('h3', null, '제목'), h('ul', null, h('li', { 'data-key': 'a' }, 'A')));
    const back = domToVNode(createElement(vnode));
    assert.deepEqual(back, { ...vnode, children: [vnode.children[0], { ...vnode.children[1], children: [{ ...vnode.children[1].children[0], key: 'a' }] }] });
  });

  test('컨테이너에 붙은 실제 노드도 변환한다', () => {
    const container = makeContainer();
    container.innerHTML = '<div><span>1</span></div>';
    assert.deepEqual(domToVNode(container.firstChild), h('div', null, h('span', null, '1')));
  });
});
