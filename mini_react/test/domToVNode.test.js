import { describe, it, expect } from 'vitest';
import { toVNode } from '../src/domToVNode.js';
import { h, render } from '../src/vdom.js';

// HTML 문자열 → 첫 번째 루트 요소
function fromHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

describe('toVNode', () => {
  it('중첩 구조를 변환한다', () => {
    const el = fromHTML('<div><ul><li>a</li><li>b</li></ul><p>c<span>d</span></p></div>');
    expect(toVNode(el)).toEqual({
      type: 'div',
      props: {},
      children: [
        {
          type: 'ul',
          props: {},
          children: [
            { type: 'li', props: {}, children: ['a'] },
            { type: 'li', props: {}, children: ['b'] },
          ],
        },
        {
          type: 'p',
          props: {},
          children: ['c', { type: 'span', props: {}, children: ['d'] }],
        },
      ],
    });
  });

  it('h()로 만든 VNode와 같은 모양이다', () => {
    const el = fromHTML('<div id="x"><span>hi</span></div>');
    expect(toVNode(el)).toEqual(h('div', { id: 'x' }, h('span', null, 'hi')));
  });

  it('속성 여러 개를 전부 props에 담는다', () => {
    const el = fromHTML(
      '<input id="name" class="a b" type="text" data-user-id="42" disabled aria-label="이름">'
    );
    expect(toVNode(el)).toEqual({
      type: 'input',
      props: {
        id: 'name',
        class: 'a b',
        type: 'text',
        'data-user-id': '42',
        disabled: '',
        'aria-label': '이름',
      },
      children: [],
    });
  });

  it('공백만 있는 텍스트와 주석을 제거한다', () => {
    const el = fromHTML(`
      <section>
        <!-- 헤더 -->
        <h1>  제목  </h1>
        <!-- 본문 -->
        <p>본문</p>

      </section>
    `);
    expect(toVNode(el)).toEqual({
      type: 'section',
      props: {},
      children: [
        { type: 'h1', props: {}, children: ['  제목  '] }, // 의미 있는 텍스트는 원문 유지
        { type: 'p', props: {}, children: ['본문'] },
      ],
    });
  });

  it('빈 요소는 children이 빈 배열이다', () => {
    expect(toVNode(fromHTML('<div></div>'))).toEqual({ type: 'div', props: {}, children: [] });
    expect(toVNode(fromHTML('<br>'))).toEqual({ type: 'br', props: {}, children: [] });
    expect(toVNode(fromHTML('<div> \n\t </div>'))).toEqual({ type: 'div', props: {}, children: [] });
    expect(toVNode(fromHTML('<div><!-- only --></div>'))).toEqual({ type: 'div', props: {}, children: [] });
  });

  it('태그 이름을 소문자로 만든다', () => {
    const el = document.createElement('DIV');
    el.appendChild(document.createElement('SPAN'));
    expect(toVNode(el)).toEqual({
      type: 'div',
      props: {},
      children: [{ type: 'span', props: {}, children: [] }],
    });
  });

  it('무시 대상 노드를 루트로 주면 null', () => {
    expect(toVNode(document.createComment('x'))).toBeNull();
    expect(toVNode(document.createTextNode('  \n '))).toBeNull();
    expect(toVNode(document.createTextNode('hi'))).toBe('hi');
  });

  describe('왕복: toVNode → render → toVNode 결과가 같다', () => {
    const samples = [
      '<div><ul><li>a</li><li>b</li></ul></div>',
      '<form id="f" class="x y"><input type="checkbox" checked data-k="v"><label for="c">L</label></form>',
      `<article>
         <!-- c -->
         <h2>T</h2>
         <p>a <b>b</b> c</p>
       </article>`,
      '<div></div>',
    ];
    for (const html of samples) {
      it(html.replace(/\s+/g, ' ').slice(0, 50), () => {
        const v1 = toVNode(fromHTML(html));
        const v2 = toVNode(render(v1));
        expect(v2).toEqual(v1);
      });
    }
  });
});
