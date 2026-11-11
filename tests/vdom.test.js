import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  h, TEXT, domToVNode, containerToVNode, htmlToVNode, createElement, normalizeDom,
  vnodeToHTML, childrenToHTML, setProp, countNodes, SVG_NS,
} from '../src/lib/vdom.js';
import { container } from './setup.js';

describe('h()', () => {
  test('엘리먼트 VNode 를 만든다', () => {
    const v = h('div', { id: 'a' }, 'hello');
    assert.equal(v.type, 'div');
    assert.deepEqual(v.props, { id: 'a' });
    assert.equal(v.children[0].type, TEXT);
    assert.equal(v.children[0].text, 'hello');
  });

  test('key 는 props 에서 분리된다', () => {
    const v = h('li', { key: 7, class: 'x' });
    assert.equal(v.key, 7);
    assert.deepEqual(v.props, { class: 'x' });
  });

  test('null/boolean 은 무시, 배열은 평탄화, 숫자는 텍스트', () => {
    const v = h('ul', null, null, false, true, [h('li'), [h('li')]], 0);
    assert.equal(v.children.length, 3);
    assert.equal(v.children[2].text, '0');
  });

  test('props 객체를 변형하지 않는다', () => {
    const props = { key: 1, id: 'x' };
    h('div', props);
    assert.deepEqual(props, { key: 1, id: 'x' });
  });
});

describe('domToVNode()', () => {
  test('실제 DOM 을 VNode 트리로 변환한다', () => {
    const el = container('<p class="a" data-x="1">Hi <b>there</b></p>');
    const v = domToVNode(el.firstChild);
    assert.equal(v.type, 'p');
    assert.deepEqual(v.props, { class: 'a', 'data-x': '1' });
    assert.equal(v.children.length, 2);
    assert.equal(v.children[0].text, 'Hi ');
    assert.equal(v.children[1].type, 'b');
  });

  test('들여쓰기 공백과 주석은 무시하지만 의미 있는 공백은 유지한다', () => {
    const el = container('<ul>\n  <li>a</li>\n  <!-- c -->\n  <li>b</li>\n</ul><p><b>x</b> <i>y</i></p>');
    const ul = domToVNode(el.firstChild);
    assert.equal(ul.children.length, 2);
    const p = domToVNode(el.childNodes[1]);
    assert.equal(p.children.length, 3);
    assert.equal(p.children[1].text, ' ');
  });

  test('key / data-key 속성을 VNode.key 로 사용한다', () => {
    const el = container('<li key="a"></li><li data-key="b"></li>');
    assert.equal(domToVNode(el.childNodes[0]).key, 'a');
    assert.equal(domToVNode(el.childNodes[1]).key, 'b');
  });

  test('sanitize: script 태그와 on* 속성을 제거한다', () => {
    const v = htmlToVNode('<div onclick="alert(1)" id="d"><script>alert(1)</script><img src="x" onerror="x()"></div>');
    const div = v.children[0];
    assert.deepEqual(div.props, { id: 'd' });
    assert.equal(div.children.length, 1);
    assert.deepEqual(div.children[0].props, { src: 'x' });
  });

  test('SVG 태그 이름의 대소문자를 유지한다', () => {
    const v = htmlToVNode('<svg><linearGradient id="g"></linearGradient></svg>');
    assert.equal(v.children[0].children[0].type, 'linearGradient');
  });

  test('containerToVNode 는 컨테이너 속성을 제외한 내용만 감싼다', () => {
    const el = container('<span>1</span><span>2</span>');
    el.id = 'some-id';
    const v = containerToVNode(el);
    assert.deepEqual(v.props, {});
    assert.equal(v.children.length, 2);
  });

  test('주석/텍스트 외 노드는 null', () => {
    assert.equal(domToVNode(document.createComment('x')), null);
  });
});

describe('createElement()', () => {
  test('VNode → 실제 DOM', () => {
    const el = createElement(h('div', { id: 'a', class: 'b' }, h('span', null, 'x'), 'y'));
    assert.equal(el.outerHTML, '<div id="a" class="b"><span>x</span>y</div>');
  });

  test('SVG 하위 요소는 SVG 네임스페이스로 생성된다', () => {
    const el = createElement(h('svg', null, h('rect', { width: 10 })));
    assert.equal(el.namespaceURI, SVG_NS);
    assert.equal(el.firstChild.namespaceURI, SVG_NS);
  });

  test('이벤트 핸들러를 등록한다', () => {
    let clicked = 0;
    const el = createElement(h('button', { onClick: () => clicked++ }));
    el.click();
    assert.equal(clicked, 1);
    assert.equal(el.hasAttribute('onClick'), false);
  });

  test('select 의 value 는 option 생성 후 반영된다', () => {
    const el = createElement(h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B')));
    assert.equal(el.value, 'b');
  });

  test('style 객체 / className / boolean 속성', () => {
    const el = createElement(h('input', { className: 'c', style: { color: 'red', 'margin-top': '2px' }, disabled: true, checked: false, type: 'checkbox' }));
    assert.equal(el.getAttribute('class'), 'c');
    assert.equal(el.style.color, 'red');
    assert.equal(el.style.marginTop, '2px');
    assert.equal(el.disabled, true);
    assert.equal(el.checked, false);
  });
});

describe('setProp()', () => {
  test('핸들러 교체 시 리스너를 다시 등록하지 않고 새 핸들러가 호출된다', () => {
    const el = document.createElement('button');
    const calls = [];
    setProp(el, 'onClick', () => calls.push('a'));
    setProp(el, 'onClick', () => calls.push('b'), () => {});
    el.click();
    assert.deepEqual(calls, ['b']);
    setProp(el, 'onClick', undefined, () => {});
    el.click();
    assert.deepEqual(calls, ['b']);
  });

  test('value 는 property 와 attribute 를 함께 갱신한다', () => {
    const el = document.createElement('input');
    setProp(el, 'value', 'hi');
    assert.equal(el.value, 'hi');
    setProp(el, 'value', undefined, 'hi');
    assert.equal(el.value, '');
  });

  test('checked="" (HTML 에서 읽은 boolean 속성) 은 true', () => {
    const el = document.createElement('input');
    el.type = 'checkbox';
    setProp(el, 'checked', '');
    assert.equal(el.checked, true);
  });

  test('style 객체 diff: 사라진 키는 제거', () => {
    const el = document.createElement('div');
    setProp(el, 'style', { color: 'red', width: '1px' });
    setProp(el, 'style', { color: 'blue' }, { color: 'red', width: '1px' });
    assert.equal(el.style.color, 'blue');
    assert.equal(el.style.width, '');
  });
});

describe('직렬화 & 정규화', () => {
  test('vnodeToHTML → htmlToVNode 왕복 시 동일한 VNode', () => {
    const html = '<section class="s"><h2>Title <small>sub</small></h2><ul><li key="a">A</li><li key="b">B &amp; "C"</li></ul><input type="text" value="x"><br></section>';
    const v1 = htmlToVNode(html);
    const v2 = htmlToVNode(childrenToHTML(v1));
    assert.deepEqual(v2, v1);
  });

  test('요소만 자식일 때만 들여쓰기한다', () => {
    const out = vnodeToHTML(h('ul', null, h('li', null, 'a')));
    assert.equal(out, '<ul>\n  <li>a</li>\n</ul>');
    assert.equal(vnodeToHTML(h('p', null, 'a', h('b', null, 'b'))), '<p>a<b>b</b></p>');
  });

  test('텍스트/속성 이스케이프', () => {
    assert.equal(vnodeToHTML(h('a', { title: '"x"&' }, '<b>')), '<a title="&quot;x&quot;&amp;">&lt;b&gt;</a>');
  });

  test('normalizeDom 후 childNodes 와 VNode children 인덱스가 일치', () => {
    const el = container('\n  <p>a</p>\n  <!-- x -->\n  <p>b</p>\n');
    normalizeDom(el);
    const v = containerToVNode(el);
    assert.equal(el.childNodes.length, v.children.length);
  });

  test('countNodes', () => {
    assert.equal(countNodes(h('div', null, h('p', null, 'a'), 'b')), 4);
  });
});
