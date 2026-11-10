import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/phase1/history.js';
import { parseHTML, toHTML } from '../src/phase1/html.js';
import { h } from '../src/core/vdom.js';

describe('History', () => {
  test('비어 있으면 current는 null, 이동 불가, 눌러도 에러 없음', () => {
    const history = new History();
    assert.equal(history.current(), null);
    assert.equal(history.canBack(), false);
    assert.equal(history.canForward(), false);
    assert.equal(history.back(), null);
    assert.equal(history.forward(), null);
    assert.deepEqual(history.position(), { index: 0, total: 0 });
  });

  test('push → back → forward, 양 끝에서는 그대로', () => {
    const history = new History();
    ['v0', 'v1', 'v2'].forEach((v) => history.push(v));
    assert.equal(history.back(), 'v1');
    assert.equal(history.back(), 'v0');
    assert.equal(history.back(), 'v0'); // 처음
    assert.equal(history.canBack(), false);
    assert.equal(history.forward(), 'v1');
    assert.equal(history.forward(), 'v2');
    assert.equal(history.forward(), 'v2'); // 끝
    assert.equal(history.canForward(), false);
    assert.deepEqual(history.position(), { index: 3, total: 3 });
  });

  test('과거 시점에서 push하면 그 뒤 기록은 지운다', () => {
    const history = new History();
    ['v0', 'v1', 'v2', 'v3'].forEach((v) => history.push(v));
    history.back();
    history.back(); // v1
    history.push('new');
    assert.deepEqual(history.position(), { index: 3, total: 3 });
    assert.equal(history.canForward(), false);
    assert.equal(history.back(), 'v1');
  });
});

describe('parseHTML · toHTML (테스트 영역 textarea용)', () => {
  test('루트 요소 하나를 VNode로 (data-key는 key로)', () => {
    assert.deepEqual(parseHTML('\n<ul>\n  <li data-key="a">A</li>\n</ul>\n'), {
      type: 'ul', key: null, props: {}, children: [{ type: 'li', key: 'a', props: { 'data-key': 'a' }, children: ['A'] }],
    });
  });

  test('비었거나 루트가 여러 개거나 텍스트뿐이면 알아보기 쉬운 에러', () => {
    assert.throws(() => parseHTML('   '), /비어 있습니다/);
    assert.throws(() => parseHTML('<p>a</p><p>b</p>'), /하나여야/);
    assert.throws(() => parseHTML('그냥 글자'), /요소여야/);
  });

  test('toHTML은 들여쓴 HTML을 만들고, 다시 읽으면 같은 VNode', () => {
    const vnode = h('section', { class: 'card' },
      h('h3', null, '제목'),
      h('p', null, '안녕 ', h('b', null, '굵게')),
      h('ul', null, h('li', { key: 'a', 'data-key': 'a' }, 'A')),
      h('input', { type: 'checkbox', checked: '' }));
    const html = toHTML(vnode);
    assert.equal(html, [
      '<section class="card">',
      '  <h3>제목</h3>',
      '  <p>안녕 <b>굵게</b></p>',
      '  <ul>',
      '    <li data-key="a">A</li>',
      '  </ul>',
      '  <input type="checkbox" checked>',
      '</section>',
    ].join('\n'));
    assert.deepEqual(parseHTML(html), vnode);
  });

  test('특수문자는 이스케이프', () => {
    const vnode = h('p', { title: 'a "b" & c' }, '1 < 2 & 3');
    assert.deepEqual(parseHTML(toHTML(vnode)), vnode);
  });
});
