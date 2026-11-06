// Phase 1 마무리 점검에서 찾은 엣지 케이스 회귀 테스트
import { describe, it, expect } from 'vitest';
import { toVNode } from '../src/domToVNode.js';
import { h, render, SVG_NS } from '../src/vdom.js';
import { diff, patch } from '../src/diff.js';
import { parseHTML } from '../src/parseHTML.js';
import { toHTML } from '../src/toHTML.js';

describe('공백 텍스트', () => {
  it('같은 줄의 공백은 내용이라 남긴다 (<b>a</b> <i>b</i>)', () => {
    expect(parseHTML('<p><b>a</b> <i>b</i></p>')).toEqual(h('p', null, h('b', null, 'a'), ' ', h('i', null, 'b')));
  });

  it('&nbsp;는 지우지 않는다', () => {
    expect(parseHTML('<p>&nbsp;</p>')).toEqual(h('p', null, ' '));
  });

  it('줄바꿈이 섞인 들여쓰기 공백은 지운다', () => {
    expect(parseHTML('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toEqual(
      h('ul', null, h('li', null, 'a'), h('li', null, 'b'))
    );
  });

  it('공백 텍스트가 있어도 toHTML ↔ parseHTML 왕복이 같다', () => {
    const vnode = h('p', null, h('b', null, 'a'), ' ', h('i', null, 'b'), ' ');
    expect(parseHTML(toHTML(vnode))).toEqual(vnode);
  });
});

describe('브라우저가 구조를 몰래 고치는 입력', () => {
  it.each([
    ['<section><p><div>x</div></p></section>', '구조를 고쳐'],
    ['<table><tr><td>1</td></tr></table>', '구조를 고쳐'],
    ['<div>a</br>b</div>', '구조를 고쳐'],
    ['<div><span/>a</div>', '스스로 닫을 수 없습니다'],
  ])('%s → 에러', (source, message) => {
    expect(() => parseHTML(source)).toThrow(message);
  });

  it('올바르게 쓴 table은 통과한다', () => {
    expect(() => parseHTML('<table><tbody><tr><td>1</td></tr></tbody></table>')).not.toThrow();
  });
});

describe('SVG', () => {
  const SOURCE = '<div><svg viewBox="0 0 10 10"><circle r="5"/><foreignObject><p>x</p></foreignObject></svg></div>';

  it('SVG 안의 self-closing은 허용하고, 태그 대소문자를 지킨다', () => {
    const vnode = parseHTML(SOURCE);
    expect(vnode.children[0].children.map((c) => c.type)).toEqual(['circle', 'foreignObject']);
  });

  it('render는 SVG 네임스페이스로 만들고 foreignObject 안은 다시 HTML이다', () => {
    const svg = render(parseHTML(SOURCE)).firstChild;
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.querySelector('circle').namespaceURI).toBe(SVG_NS);
    expect(svg.querySelector('p').namespaceURI).toBe('http://www.w3.org/1999/xhtml');
  });

  it('patch로 svg 안에 추가/교체한 요소도 SVG 네임스페이스다', () => {
    const prev = h('svg', null, h('circle', { r: '1' }));
    const next = h('svg', null, h('rect', { width: '1' }), h('circle', { r: '2' }));
    const container = document.createElement('div');
    container.appendChild(render(prev));
    patch(container, diff(prev, next));
    for (const el of container.firstChild.children) expect(el.namespaceURI).toBe(SVG_NS);
    expect(toVNode(container.firstChild)).toEqual(next);
  });
});

describe('실제 DOM이 patch 밖에서 바뀐 경우', () => {
  it('경로를 못 찾으면 어느 경로인지 알려 주는 에러를 던진다', () => {
    const prev = h('ul', null, h('li', null, '1'), h('li', null, '2'));
    const next = h('ul', null, h('li', null, '1'), h('li', null, 'X'));
    const container = document.createElement('div');
    container.appendChild(render(prev));
    container.firstChild.lastChild.remove(); // 누군가 DOM을 직접 지움

    expect(() => patch(container, diff(prev, next))).toThrow('경로 [1, 0]');
  });
});
