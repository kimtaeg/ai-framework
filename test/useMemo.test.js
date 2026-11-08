import { describe, it, expect, vi } from 'vitest';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState, useEffect, useMemo } from '../src/hooks.js';

// setState는 다시 그리기를 예약만 한다. 예약된 update가 끝날 때까지 기다린다.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(fn) {
  const container = document.createElement('div');
  new FunctionComponent(fn, container).mount();
  return { container, text: () => container.textContent };
}

// todos(목록)와 input(입력창) 두 상태. 완료 개수 계산은 todos에만 의존한다.
function setupTodoApp(getDeps) {
  const countDone = vi.fn((todos) => todos.filter((t) => t.done).length);
  let setTodos;
  let setInput;
  const app = mount(() => {
    const [todos, st] = useState([{ done: true }, { done: false }]);
    const [input, si] = useState('');
    setTodos = st;
    setInput = si;
    const doneCount = useMemo(() => countDone(todos), getDeps(todos, input));
    return h('p', null, `완료 ${doneCount} / 입력 "${input}"`);
  });
  return { ...app, countDone, setTodos: (v) => setTodos(v), setInput: (v) => setInput(v) };
}

describe('useMemo', () => {
  it('첫 렌더에 계산한 값을 돌려준다', () => {
    const { text, countDone } = setupTodoApp((todos) => [todos]);
    expect(text()).toBe('완료 1 / 입력 ""');
    expect(countDone).toHaveBeenCalledTimes(1);
  });

  it('deps가 같으면 다시 렌더돼도 fn을 호출하지 않는다', async () => {
    const { text, countDone, setInput } = setupTodoApp((todos) => [todos]);

    setInput('a');
    await flush();
    setInput('ab');
    await flush();

    expect(text()).toBe('완료 1 / 입력 "ab"'); // 화면은 갱신됨
    expect(countDone).toHaveBeenCalledTimes(1); // 계산은 첫 렌더 한 번뿐
  });

  it('deps가 바뀌면 다시 계산한다', async () => {
    const { text, countDone, setTodos } = setupTodoApp((todos) => [todos]);

    setTodos((list) => [...list, { done: true }]);
    await flush();

    expect(text()).toBe('완료 2 / 입력 ""');
    expect(countDone).toHaveBeenCalledTimes(2);
  });

  it('[] → 처음 한 번만 계산', async () => {
    const { countDone, setTodos, setInput } = setupTodoApp(() => []);
    setTodos([]);
    await flush();
    setInput('x');
    await flush();
    expect(countDone).toHaveBeenCalledTimes(1);
  });

  it('deps 없음 → 매 렌더 다시 계산 (메모하지 않음)', async () => {
    const { countDone, setInput } = setupTodoApp(() => undefined);
    setInput('x');
    await flush();
    expect(countDone).toHaveBeenCalledTimes(2);
  });

  it('얕은 비교: 내용이 같아도 새 배열이면 다시 계산한다', async () => {
    const { countDone, setTodos } = setupTodoApp((todos) => [todos]);
    setTodos([{ done: true }, { done: false }]); // 같은 내용, 새 배열
    await flush();
    expect(countDone).toHaveBeenCalledTimes(2);
  });

  it('같은 참조의 객체를 돌려주므로 렌더 사이에 값이 유지된다', async () => {
    const results = [];
    let setInput;
    mount(() => {
      const [input, si] = useState('');
      setInput = si;
      const style = useMemo(() => ({ color: 'red' }), []);
      results.push(style);
      return h('p', null, input);
    });
    setInput('x');
    await flush();
    expect(results).toHaveLength(2);
    expect(results[0]).toBe(results[1]);
  });
});

describe('useEffect와의 차이', () => {
  it('useMemo는 렌더 "도중" 바로 계산되어 반환값을 그 렌더에서 쓴다', () => {
    const log = [];
    const { text } = mount(() => {
      const doubled = useMemo(() => {
        log.push('memo');
        return 21 * 2;
      }, []);
      useEffect(() => {
        log.push('effect');
      }, []);
      log.push(`render uses ${doubled}`);
      return h('p', null, String(doubled));
    });

    expect(log).toEqual(['memo', 'render uses 42', 'effect']);
    expect(text()).toBe('42');
  });
});

describe('Hook 순서와 에러', () => {
  it('useState·useMemo·useEffect가 섞여도 각자 칸을 지킨다', async () => {
    let setA;
    let setB;
    const memoCalls = vi.fn();
    const { text } = mount(() => {
      const [a, sa] = useState(1);
      const square = useMemo(() => {
        memoCalls();
        return a * a;
      }, [a]);
      const [b, sb] = useState(10);
      useEffect(() => {}, [b]);
      setA = sa;
      setB = sb;
      return h('p', null, `${a} ${square} ${b}`);
    });

    setB(20);
    await flush();
    expect(text()).toBe('1 1 20');
    expect(memoCalls).toHaveBeenCalledTimes(1);

    setA(3);
    await flush();
    expect(text()).toBe('3 9 20');
    expect(memoCalls).toHaveBeenCalledTimes(2);
  });

  it('fn이 에러를 던지면 저장하지 않고 다음 렌더에 다시 계산한다', () => {
    let shouldFail = true;
    const App = () => {
      const value = useMemo(() => {
        if (shouldFail) throw new Error('계산 실패');
        return 'ok';
      }, []);
      return h('p', null, value);
    };
    const container = document.createElement('div');
    const component = new FunctionComponent(App, container);
    expect(() => component.mount()).toThrow('계산 실패');

    shouldFail = false;
    component.mount();
    expect(container.textContent).toBe('ok');
  });

  it('자식 컴포넌트 안 / 렌더 밖에서 부르면 에러', () => {
    const Child = () => h('span', null, String(useMemo(() => 1, [])));
    expect(() => mount(() => h('div', null, h(Child)))).toThrow('useMemo는 루트 컴포넌트에서만');
    expect(() => useMemo(() => 1, [])).toThrow('useMemo는 컴포넌트가 렌더되는 중에만');
  });
});
