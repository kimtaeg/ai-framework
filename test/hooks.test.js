import { describe, it, expect } from 'vitest';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState } from '../src/hooks.js';

// setState는 다시 그리기를 예약만 한다. 예약된 update(마이크로태스크)가 끝날 때까지 기다린다.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// fn을 container에 마운트하고, 렌더 횟수를 세는 도우미
function mount(fn) {
  const container = document.createElement('div');
  const stats = { renders: 0 };
  const component = new FunctionComponent(() => {
    stats.renders++;
    return fn();
  }, container).mount();
  return { container, component, stats, text: () => container.textContent };
}

describe('useState', () => {
  it('첫 렌더에는 초기값을 쓴다', () => {
    const { text, component } = mount(() => {
      const [count] = useState(7);
      return h('p', null, `count: ${count}`);
    });
    expect(text()).toBe('count: 7');
    expect(component.hooks).toHaveLength(1);
  });

  it('setState 후 화면에 반영된다 (예약 → 한 번에 다시 그림, 루트 DOM은 유지)', async () => {
    let setCount;
    const { container, text, stats } = mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      return h('p', null, `count: ${count}`);
    });
    const root = container.firstChild;

    setCount(5);
    expect(text()).toBe('count: 0'); // 아직 예약만 된 상태
    await flush();

    expect(text()).toBe('count: 5');
    expect(stats.renders).toBe(2);
    expect(container.firstChild).toBe(root); // diff/patch로 텍스트만 바뀜
  });

  it('두 번째 렌더부터는 초기값을 무시하고 사물함 값을 쓴다', async () => {
    let setCount;
    let initial = 100;
    const { text } = mount(() => {
      const [count, set] = useState(initial);
      setCount = set;
      return h('p', null, String(count));
    });
    initial = 999;
    setCount(1);
    await flush();
    expect(text()).toBe('1');
  });

  it('함수형 업데이트를 연속 2번 하면 둘 다 반영되고, 렌더는 1번이다', async () => {
    let setCount;
    const { text, stats } = mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      return h('p', null, String(count));
    });

    setCount((c) => c + 1);
    setCount((c) => c + 1);
    await flush();

    expect(text()).toBe('2');
    expect(stats.renders).toBe(2); // mount 1 + 배치된 update 1
  });

  it('값으로 연속 2번 부르면 렌더 시점 값을 기억한 클로저 때문에 +1만 된다', async () => {
    let increase;
    const { text } = mount(() => {
      const [count, setCount] = useState(0);
      increase = () => setCount(count + 1); // count = 이 렌더의 값(0)을 기억
      return h('p', null, String(count));
    });

    increase();
    increase(); // 여전히 0 + 1 → 같은 값이라 무시
    await flush();
    expect(text()).toBe('1');
  });

  it('같은 값으로 setState하면 다시 그리지 않는다', async () => {
    const shared = { a: 1 };
    let setCount;
    let setObj;
    const { stats } = mount(() => {
      const [, set1] = useState(0);
      const [, set2] = useState(shared);
      setCount = set1;
      setObj = set2;
      return h('p');
    });

    setCount(0);
    setCount((c) => c);
    setObj(shared); // 같은 참조
    await flush();
    expect(stats.renders).toBe(1);

    setObj({ a: 1 }); // 내용이 같아도 새 객체면 다른 값
    await flush();
    expect(stats.renders).toBe(2);
  });

  it('useState 여러 개는 호출 순서대로 각자 칸을 가진다', async () => {
    let setName;
    let setAge;
    const { text, component } = mount(() => {
      const [name, n] = useState('정글');
      const [age, a] = useState(20);
      setName = n;
      setAge = a;
      return h('p', null, `${name}/${age}`);
    });

    setAge((x) => x + 1);
    await flush();
    expect(text()).toBe('정글/21');

    setName('크래프톤');
    await flush();
    expect(text()).toBe('크래프톤/21');
    expect(component.hooks.map((hook) => hook.value)).toEqual(['크래프톤', 21]);
  });

  it('setState는 렌더마다 같은 함수다', async () => {
    const setters = [];
    mount(() => {
      const [count, setCount] = useState(0);
      setters.push(setCount);
      if (count === 0) queueMicrotask(() => setCount(1));
      return h('p');
    });
    await flush();
    expect(setters).toHaveLength(2);
    expect(setters[0]).toBe(setters[1]);
  });

  it('클릭 → 핸들러 → setState → 다시 그림 (여러 번 클릭해도 렌더 1번)', async () => {
    const { container, text, stats } = mount(() => {
      const [count, setCount] = useState(0);
      return h('button', { onClick: () => setCount((c) => c + 1) }, `클릭 ${count}`);
    });
    const button = container.firstChild;

    button.click();
    button.click();
    button.click();
    await flush();

    expect(text()).toBe('클릭 3');
    expect(stats.renders).toBe(2);
    button.click();
    await flush();
    expect(text()).toBe('클릭 4');
  });

  it('상태가 자식 컴포넌트에 props로 내려가 함께 바뀐다', async () => {
    const Item = ({ text }) => h('li', null, text);
    let setTodos;
    const { container } = mount(() => {
      const [todos, set] = useState(['빨래']);
      setTodos = set;
      return h('ul', null, todos.map((t) => h(Item, { text: t })));
    });

    setTodos((list) => [...list, '청소']);
    await flush();
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['빨래', '청소']);
  });
});

describe('잘못된 위치에서 호출하면 에러', () => {
  it('자식 컴포넌트 안: 루트에서만 쓸 수 있다고 알려 준다', () => {
    const Child = () => {
      useState(0);
      return h('span');
    };
    expect(() => mount(() => h('div', null, h(Child)))).toThrow('루트 컴포넌트에서만');
  });

  it('렌더 밖(컴포넌트 밖, 이벤트 핸들러 안): 렌더 중에만 호출할 수 있다고 알려 준다', () => {
    expect(() => useState(0)).toThrow('렌더되는 중에만');

    // 리스너 안에서 난 에러는 dispatchEvent 밖으로 나오지 않으므로, 렌더가 끝난 뒤 핸들러를 직접 부른다
    let handleClick;
    mount(() => {
      handleClick = () => useState(1);
      return h('button', { onClick: handleClick });
    });
    expect(() => handleClick()).toThrow('렌더되는 중에만');
  });

  it('렌더 중에 setState하면 무한 렌더를 막는 에러', () => {
    expect(() =>
      mount(() => {
        const [, setCount] = useState(0);
        setCount(1);
        return h('p');
      })
    ).toThrow('무한히 다시 렌더');
  });

  it('렌더 중 에러가 나도 렌더 상태가 남지 않는다', () => {
    expect(() =>
      mount(() => {
        throw new Error('렌더 실패');
      })
    ).toThrow('렌더 실패');
    expect(() => useState(0)).toThrow('렌더되는 중에만'); // 여전히 "렌더 밖"으로 판단
  });

  it('루트가 null을 돌려주면 에러', () => {
    expect(() => mount(() => null)).toThrow('루트 컴포넌트가 아무것도');
  });
});
