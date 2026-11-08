import { describe, it, expect } from 'vitest';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState, useEffect } from '../src/hooks.js';

// setState는 다시 그리기를 예약만 한다. 예약된 update가 끝날 때까지 기다린다.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// effect가 mount 도중에 container를 읽어야 하는 테스트는 container를 미리 만들어 넘긴다
function mount(fn, container = document.createElement('div')) {
  const component = new FunctionComponent(fn, container).mount();
  return { container, component };
}

describe('deps에 따른 실행 횟수', () => {
  function setup(getDeps) {
    const runs = [];
    let setA;
    let setB;
    mount(() => {
      const [a, sa] = useState(0);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      useEffect(() => {
        runs.push(`a=${a},b=${b}`);
      }, getDeps(a, b));
      return h('p', null, `${a}/${b}`);
    });
    return { runs, setA: (v) => setA(v), setB: (v) => setB(v) };
  }

  it('deps 없음 → 매 렌더마다', async () => {
    const { runs, setA, setB } = setup(() => undefined);
    setA(1);
    await flush();
    setB(1);
    await flush();
    expect(runs).toEqual(['a=0,b=0', 'a=1,b=0', 'a=1,b=1']);
  });

  it('[] → 처음 한 번만', async () => {
    const { runs, setA, setB } = setup(() => []);
    setA(1);
    await flush();
    setB(1);
    await flush();
    expect(runs).toEqual(['a=0,b=0']);
  });

  it('[a] → a가 바뀔 때만 (b만 바뀌면 실행 안 함)', async () => {
    const { runs, setA, setB } = setup((a) => [a]);
    setB(1);
    await flush();
    expect(runs).toEqual(['a=0,b=0']);

    setA(1);
    await flush();
    expect(runs).toEqual(['a=0,b=0', 'a=1,b=1']);
  });

  it('[a, b] → 둘 중 하나라도 바뀌면', async () => {
    const { runs, setA, setB } = setup((a, b) => [a, b]);
    setA(1);
    await flush();
    setB(1);
    await flush();
    expect(runs).toHaveLength(3);
  });

  it('얕은 비교: 내용이 같아도 새 객체면 바뀐 것으로 본다', async () => {
    const runs = [];
    let setItem;
    mount(() => {
      const [item, set] = useState({ id: 1 });
      setItem = set;
      useEffect(() => {
        runs.push(item.id);
      }, [item]);
      return h('p');
    });

    setItem({ id: 1 });
    await flush();
    expect(runs).toEqual([1, 1]);
  });
});

describe('실행 시점', () => {
  it('렌더 도중이 아니라 DOM이 붙은 뒤에 실행된다 (mount)', () => {
    const log = [];
    const container = document.createElement('div');
    mount(() => {
      log.push('render');
      useEffect(() => {
        log.push(`effect: DOM=${container.textContent}`);
      });
      return h('p', null, '안녕');
    }, container);
    // mount가 끝나기 전, effect 안에서 이미 화면 내용을 읽을 수 있다
    expect(log).toEqual(['render', 'effect: DOM=안녕']);
    expect(container.textContent).toBe('안녕');
  });

  it('update에서도 patch가 끝난 DOM을 본다', async () => {
    const seen = [];
    let setCount;
    const container = document.createElement('div');
    mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      useEffect(() => {
        seen.push(container.textContent);
      }, [count]);
      return h('p', null, `count ${count}`);
    }, container);

    setCount(1);
    await flush();
    expect(seen.at(-1)).toBe('count 1');
  });

  it('effect 안에서 setState하면 다음 update로 이어진다', async () => {
    let renders = 0;
    const container = document.createElement('div');
    mount(() => {
      renders++;
      const [width, setWidth] = useState(0);
      useEffect(() => {
        setWidth(container.textContent.length); // DOM을 측정해 상태로 저장
      }, []);
      return h('p', null, `글자수 ${width}`);
    }, container);
    await flush();
    expect(container.textContent).toBe('글자수 5'); // 첫 화면 "글자수 0" = 5글자
    expect(renders).toBe(2);
  });
});

describe('cleanup', () => {
  it('다시 실행되기 직전에 이전 cleanup이 먼저 불린다', async () => {
    const log = [];
    let setCount;
    mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      useEffect(() => {
        log.push(`effect ${count}`);
        return () => log.push(`cleanup ${count}`); // cleanup도 그 렌더의 count를 기억한다
      }, [count]);
      return h('p');
    });

    setCount(1);
    await flush();
    setCount(2);
    await flush();

    expect(log).toEqual(['effect 0', 'cleanup 0', 'effect 1', 'cleanup 1', 'effect 2']);
  });

  it('여러 effect는 정리를 먼저 모두 끝낸 뒤 실행한다', async () => {
    const log = [];
    let setCount;
    mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      useEffect(() => {
        log.push(`A ${count}`);
        return () => log.push(`A cleanup ${count}`);
      });
      useEffect(() => {
        log.push(`B ${count}`);
        return () => log.push(`B cleanup ${count}`);
      });
      return h('p');
    });
    log.length = 0;

    setCount(1);
    await flush();
    expect(log).toEqual(['A cleanup 0', 'B cleanup 0', 'A 1', 'B 1']);
  });

  it('deps가 같아 다시 실행하지 않으면 cleanup도 부르지 않는다', async () => {
    const log = [];
    let setOther;
    mount(() => {
      const [, set] = useState(0);
      setOther = set;
      useEffect(() => () => log.push('cleanup'), []);
      return h('p');
    });
    setOther(1);
    await flush();
    expect(log).toEqual([]);
  });
});

describe('unmount', () => {
  it('모든 cleanup을 선언 순서대로 부르고 화면을 비운다', () => {
    const log = [];
    const { container, component } = mount(() => {
      useEffect(() => () => log.push('A'), []);
      useEffect(() => {}); // cleanup 없음
      useEffect(() => () => log.push('C'));
      return h('p', null, '보이는 중');
    });

    component.unmount();

    expect(log).toEqual(['A', 'C']);
    expect(container.childNodes).toHaveLength(0);
  });

  it('타이머를 cleanup으로 정리하고, unmount 뒤 늦게 온 setState는 무시한다', async () => {
    let ticks = 0;
    let lateSet;
    const { container, component } = mount(() => {
      const [count, setCount] = useState(0);
      lateSet = setCount;
      useEffect(() => {
        const id = setInterval(() => ticks++, 1);
        return () => clearInterval(id);
      }, []);
      return h('p', null, String(count));
    });

    component.unmount();
    const ticksAtUnmount = ticks;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks).toBe(ticksAtUnmount); // 타이머가 멈췄다

    expect(() => lateSet(5)).not.toThrow();
    await flush();
    expect(container.childNodes).toHaveLength(0); // 다시 그려지지 않는다
  });

  it('이미 예약된 update가 있어도 unmount 후에는 실행되지 않는다', async () => {
    let renders = 0;
    let setCount;
    const { component } = mount(() => {
      renders++;
      const [, set] = useState(0);
      setCount = set;
      return h('p');
    });
    setCount(1); // 예약만 된 상태
    component.unmount();
    await flush();
    expect(renders).toBe(1);
  });

  it('두 번 unmount해도 cleanup은 한 번만', () => {
    let cleanups = 0;
    const { component } = mount(() => {
      useEffect(() => () => cleanups++, []);
      return h('p');
    });
    component.unmount();
    component.unmount();
    expect(cleanups).toBe(1);
  });
});

describe('잘못된 위치에서 호출하면 에러', () => {
  it('자식 컴포넌트 안', () => {
    const Child = () => {
      useEffect(() => {});
      return h('span');
    };
    expect(() => mount(() => h('div', null, h(Child)))).toThrow('useEffect는 루트 컴포넌트에서만');
  });

  it('렌더 밖', () => {
    expect(() => useEffect(() => {})).toThrow('useEffect는 컴포넌트가 렌더되는 중에만');
  });
});
