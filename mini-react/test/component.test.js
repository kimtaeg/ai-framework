import { describe, it, expect, vi } from 'vitest';
import { h, render } from '../src/vdom.js';
import { expand } from '../src/component.js';
import { diff, patch, TEXT, PROPS, CREATE } from '../src/diff.js';
import { toVNode } from '../src/domToVNode.js';

// 테스트용 컴포넌트: 모두 props만 받는 순수 함수
function TodoItem({ text, done }) {
  return h('li', { class: done ? 'todo done' : 'todo' }, text);
}

function TodoList({ todos }) {
  return h('ul', null, todos.map((todo) => h(TodoItem, todo)));
}

function Card({ title, children }) {
  return h('section', { class: 'card' }, h('h3', null, title), h('div', { class: 'body' }, children));
}

function App({ todos }) {
  return h('main', null, h(Card, { title: '할 일' }, h(TodoList, { todos })));
}

// 펼친 VDOM → render → HTML 문자열
const toHTMLString = (vnode) => render(expand(vnode)).outerHTML;

describe('h()는 컴포넌트를 실행하지 않고 기록만 한다', () => {
  it('type에 함수가 그대로 들어간다', () => {
    const spy = vi.fn(() => h('p', null, 'x'));
    const vnode = h(spy, { a: 1 });
    expect(vnode.type).toBe(spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('펼치지 않고 render하면 원인을 알려 주는 에러', () => {
    expect(() => render(h(TodoItem, { text: 'a' }))).toThrow('expand()로 먼저 펼친 뒤');
  });
});

describe('expand', () => {
  it('단순 컴포넌트: props로 호출한 결과로 바뀐다', () => {
    expect(expand(h(TodoItem, { text: '빨래', done: false }))).toEqual(h('li', { class: 'todo' }, '빨래'));
  });

  it('중첩 컴포넌트: 끝까지 펼쳐 함수 type이 하나도 남지 않는다', () => {
    const result = expand(h(App, { todos: [{ text: '빨래', done: true }, { text: '청소', done: false }] }));
    expect(result).toEqual(
      h('main', null,
        h('section', { class: 'card' },
          h('h3', null, '할 일'),
          h('div', { class: 'body' },
            h('ul', null,
              h('li', { class: 'todo done' }, '빨래'),
              h('li', { class: 'todo' }, '청소')))))
    );
  });

  it('컴포넌트가 컴포넌트를 바로 돌려줘도 펼친다', () => {
    const Inner = () => h('b', null, '안');
    const Middle = () => h(Inner);
    const Outer = () => h(Middle);
    expect(expand(h(Outer))).toEqual(h('b', null, '안'));
  });

  it('props.children으로 태그 안의 자식을 받는다', () => {
    const received = [];
    function Box({ children }) {
      received.push(children);
      return h('div', { class: 'box' }, children);
    }
    const result = expand(h(Box, null, h('p', null, '하나'), '둘', h(TodoItem, { text: '셋' })));

    expect(received[0]).toHaveLength(3); // 펼치기 전 자식 그대로 전달
    expect(result).toEqual(h('div', { class: 'box' }, h('p', null, '하나'), '둘', h('li', { class: 'todo' }, '셋')));
  });

  it('자식이 없으면 children은 빈 배열이다', () => {
    let received;
    expand(h(({ children }) => ((received = children), h('i')), null));
    expect(received).toEqual([]);
  });

  it('컴포넌트에 넘긴 이벤트 핸들러가 펼친 뒤에도 연결된다', () => {
    const handleClick = vi.fn();
    const Button = ({ onClick, children }) => h('button', { onClick }, children);
    const el = render(expand(h(Button, { onClick: handleClick }, '저장')));
    el.click();
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('null·false를 돌려주면 그 자리가 비고, 숫자는 문자열이 된다', () => {
    const Hidden = () => null;
    const Count = () => 3;
    expect(expand(h('div', null, h(Hidden), h(Count), 'x'))).toEqual(h('div', null, '3', 'x'));
  });

  it('입력 VNode를 바꾸지 않는다', () => {
    const vnode = h('div', null, h(TodoItem, { text: 'a' }));
    expand(vnode);
    expect(vnode.children[0].type).toBe(TodoItem);
  });

  it.each([
    ['루트가 비면', () => null, '루트 컴포넌트가 아무것도'],
    ['return을 빠뜨리면', function Broken() {}, 'Broken가 undefined'],
    ['배열을 돌려주면', function List() { return [h('a'), h('b')]; }, 'List가 배열'],
  ])('%s 원인을 알려 주는 에러', (_, component, message) => {
    expect(() => expand(h(component))).toThrow(message);
  });
});

describe('펼친 결과로 render한 HTML', () => {
  it('단순 컴포넌트', () => {
    expect(toHTMLString(h(TodoItem, { text: '빨래', done: true }))).toBe('<li class="todo done">빨래</li>');
  });

  it('중첩 + children', () => {
    expect(toHTMLString(h(App, { todos: [{ text: '빨래', done: false }] }))).toBe(
      '<main><section class="card"><h3>할 일</h3><div class="body">' +
        '<ul><li class="todo">빨래</li></ul></div></section></main>'
    );
  });
});

describe('펼친 결과는 Phase 1 VDOM이라 diff/patch를 그대로 쓴다', () => {
  function mount(vnode) {
    const container = document.createElement('div');
    container.appendChild(render(vnode));
    return container;
  }

  it('상태(props)가 바뀐 두 트리를 diff → patch 하면 새 트리와 같은 DOM이 된다', () => {
    const before = expand(h(App, { todos: [{ text: '빨래', done: false }] }));
    const after = expand(h(App, { todos: [{ text: '빨래', done: true }, { text: '청소', done: false }] }));

    const container = mount(before);
    const root = container.firstChild;
    const patches = diff(before, after);
    patch(container, patches);

    expect(patches.map((p) => p.type)).toEqual([PROPS, CREATE]); // done 변경 + 항목 추가
    expect(toVNode(container.firstChild)).toEqual(after);
    expect(container.firstChild).toBe(root); // 루트는 그대로, 바뀐 곳만 고침
  });

  it('텍스트만 바뀌면 TEXT 하나', () => {
    const before = expand(h(TodoItem, { text: '빨래' }));
    const after = expand(h(TodoItem, { text: '설거지' }));
    expect(diff(before, after)).toEqual([{ type: TEXT, path: [0], from: '빨래', to: '설거지' }]);
  });
});
