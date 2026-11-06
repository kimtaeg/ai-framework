import { describe, it, expect } from 'vitest';
import { diff, patch, CREATE, REMOVE, REPLACE, TEXT, PROPS } from '../src/diff.js';
import { h, render } from '../src/vdom.js';
import { toVNode } from '../src/domToVNode.js';
import { parseHTML } from '../src/parseHTML.js';

// old를 그린 DOM에 diff(old, new)를 patch하면 new와 같은 DOM이 되어야 한다
function patchAndRead(oldVNode, newVNode) {
  const container = document.createElement('div');
  container.appendChild(render(oldVNode));
  const before = container.firstChild;
  const patches = diff(oldVNode, newVNode);
  patch(container, patches);
  return { patches, result: toVNode(container.firstChild), isSameRoot: container.firstChild === before };
}

const BASE = `<section id="s">
  <h3>제목</h3>
  <p>안녕 <strong>직접</strong></p>
  <ul><li>a</li><li>b</li></ul>
</section>`;

describe('diff + patch', () => {
  it('바뀐 게 없으면 patch가 없다', () => {
    const v = parseHTML(BASE);
    expect(diff(v, parseHTML(BASE))).toEqual([]);
  });

  it('CREATE: 리스트에 항목 추가', () => {
    const next = parseHTML(BASE.replace('<li>b</li>', '<li>b</li><li>c</li>'));
    const { patches, result, isSameRoot } = patchAndRead(parseHTML(BASE), next);
    expect(patches).toEqual([expect.objectContaining({ type: CREATE, path: [2, 2] })]);
    expect(result).toEqual(next);
    expect(isSameRoot).toBe(true);
  });

  it('REMOVE: 리스트 항목 삭제', () => {
    const next = parseHTML(BASE.replace('<li>b</li>', ''));
    const { patches, result } = patchAndRead(parseHTML(BASE), next);
    expect(patches).toEqual([expect.objectContaining({ type: REMOVE, path: [2, 1] })]);
    expect(result).toEqual(next);
  });

  it('REPLACE: 중첩 태그 종류 변경', () => {
    const next = parseHTML(BASE.replace('<strong>직접</strong>', '<em>직접</em>'));
    const { patches, result } = patchAndRead(parseHTML(BASE), next);
    expect(patches).toEqual([expect.objectContaining({ type: REPLACE, path: [1, 1] })]);
    expect(result).toEqual(next);
  });

  it('TEXT: 텍스트 변경', () => {
    const next = parseHTML(BASE.replace('제목', '새 제목'));
    const { patches, result } = patchAndRead(parseHTML(BASE), next);
    expect(patches).toEqual([{ type: TEXT, path: [0, 0], from: '제목', to: '새 제목' }]);
    expect(result).toEqual(next);
  });

  it('PROPS: 속성 추가/변경/삭제', () => {
    const old = h('a', { href: '/a', title: 't' }, 'x');
    const next = h('a', { href: '/b', class: 'on' }, 'x');
    const { patches, result } = patchAndRead(old, next);
    expect(patches).toHaveLength(1);
    expect(patches[0].type).toBe(PROPS);
    expect(patches[0].changes).toEqual([
      { key: 'href', from: '/a', to: '/b' },
      { key: 'class', from: undefined, to: 'on' },
      { key: 'title', from: 't', to: undefined },
    ]);
    expect(result).toEqual(next);
  });

  it('PROPS: checked 해제가 화면 상태에도 반영된다', () => {
    const container = document.createElement('div');
    const old = h('input', { type: 'checkbox', checked: '' });
    container.appendChild(render(old));
    patch(container, diff(old, h('input', { type: 'checkbox' })));
    expect(container.firstChild.checked).toBe(false);
  });

  it('루트 태그가 바뀌면 루트를 REPLACE한다', () => {
    const { patches, result, isSameRoot } = patchAndRead(h('div', null, 'a'), h('section', null, 'a'));
    expect(patches).toEqual([expect.objectContaining({ type: REPLACE, path: [] })]);
    expect(result).toEqual(h('section', null, 'a'));
    expect(isSameRoot).toBe(false);
  });

  it('텍스트 ↔ 요소는 REPLACE', () => {
    const { patches, result } = patchAndRead(h('p', null, 'a'), h('p', null, h('b', null, 'a')));
    expect(patches.map((p) => p.type)).toEqual([REPLACE]);
    expect(result).toEqual(h('p', null, h('b', null, 'a')));
  });

  it('여러 종류가 섞여도 결과가 새 VNode와 같다', () => {
    const next = parseHTML(`<section id="s2" class="x">
      <h3>바뀐 제목</h3>
      <p>안녕 <em>직접</em> 추가</p>
      <ul><li class="done">a</li></ul>
      <footer>끝</footer>
    </section>`);
    const { patches, result } = patchAndRead(parseHTML(BASE), next);
    expect(new Set(patches.map((p) => p.type))).toEqual(new Set([CREATE, REMOVE, REPLACE, TEXT, PROPS]));
    expect(result).toEqual(next);
  });

  it('뒤에서부터 여러 개 삭제해도 경로가 어긋나지 않는다', () => {
    const old = h('ul', null, h('li', null, '1'), h('li', null, '2'), h('li', null, '3'), h('li', null, '4'));
    const next = h('ul', null, h('li', null, '1'));
    const { patches, result } = patchAndRead(old, next);
    expect(patches.map((p) => p.path)).toEqual([[3], [2], [1]]);
    expect(result).toEqual(next);
  });
});
