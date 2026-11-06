import { describe, it, expect } from 'vitest';
import { measureMutations } from '../src/mutationStats.js';
import { diff, patch } from '../src/diff.js';
import { h, render } from '../src/vdom.js';
import { setProp } from '../src/props.js';

// v를 그린 컨테이너
function mount(vnode) {
  const container = document.createElement('div');
  container.appendChild(render(vnode));
  return container;
}

const list = (...items) => h('ul', { class: 'todo' }, ...items.map((t) => h('li', null, t)));

describe('measureMutations', () => {
  it('추가/삭제는 서브트리 노드까지 센다', () => {
    const container = mount(list('a'));
    const ul = container.firstChild;
    // <li>b</li> = li + 텍스트 = 2개
    expect(measureMutations(container, () => ul.appendChild(render(h('li', null, 'b'))))).toEqual({
      added: 2, removed: 0, attributes: 0, text: 0, total: 2,
    });
    expect(measureMutations(container, () => ul.firstChild.remove())).toMatchObject({ removed: 2, total: 2 });
  });

  it('속성·텍스트 변경을 센다', () => {
    const container = mount(h('p', { id: 'a' }, 'x'));
    const p = container.firstChild;
    const summary = measureMutations(container, () => {
      p.setAttribute('id', 'b');
      p.firstChild.nodeValue = 'y';
    });
    expect(summary).toEqual({ added: 0, removed: 0, attributes: 1, text: 1, total: 2 });
  });

  it('같은 값으로 setProp하면 변경이 생기지 않는다', () => {
    const container = mount(h('input', { type: 'checkbox', checked: '', value: 'v' }));
    const el = container.firstChild;
    const summary = measureMutations(container, () => {
      setProp(el, 'checked', '');
      setProp(el, 'value', 'v');
      setProp(el, 'type', 'checkbox');
    });
    expect(summary.total).toBe(0);
  });
});

describe('patch vs innerHTML', () => {
  const prev = h('section', null, h('h3', null, '제목'), list('a', 'b', 'c'), h('p', null, '본문 ', h('b', null, '굵게')));
  // 노드 수: section, h3, "제목", ul, li×3, 텍스트×3, p, "본문 ", b, "굵게" = 14
  const SIZE = 14;

  function compare(next) {
    const patched = mount(prev);
    const byPatch = measureMutations(patched, () => patch(patched, diff(prev, next)));

    const replaced = mount(prev);
    const byInnerHTML = measureMutations(replaced, () => {
      replaced.innerHTML = render(next).outerHTML;
    });

    expect(patched.innerHTML).toBe(replaced.innerHTML); // 결과 화면은 같다
    return { byPatch, byInnerHTML };
  }

  it('텍스트 하나 바꾸면 patch는 1개, innerHTML은 전부 지우고 다시 만든다', () => {
    const next = h('section', null, h('h3', null, '새 제목'), list('a', 'b', 'c'), h('p', null, '본문 ', h('b', null, '굵게')));
    const { byPatch, byInnerHTML } = compare(next);
    expect(byPatch).toEqual({ added: 0, removed: 0, attributes: 0, text: 1, total: 1 });
    expect(byInnerHTML).toEqual({ added: SIZE, removed: SIZE, attributes: 0, text: 0, total: SIZE * 2 });
  });

  it('리스트 항목 추가: patch는 새 li만', () => {
    const next = h('section', null, h('h3', null, '제목'), list('a', 'b', 'c', 'd'), h('p', null, '본문 ', h('b', null, '굵게')));
    const { byPatch, byInnerHTML } = compare(next);
    expect(byPatch.total).toBe(2);
    expect(byInnerHTML.total).toBe(SIZE + SIZE + 2);
  });

  it('변경이 없으면 patch는 0, innerHTML은 그래도 전부 다시 만든다', () => {
    const { byPatch, byInnerHTML } = compare(prev);
    expect(byPatch.total).toBe(0);
    expect(byInnerHTML.total).toBe(SIZE * 2);
  });
});
