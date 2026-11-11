// Phase 2 마무리 점검에서 찾은 엣지 케이스 회귀 테스트 (예전 엔진)
// 할 일 앱 관련 케이스는 앱과 함께 새 코어로 옮겼다 → tests/todo.test.js
import { describe, it, expect } from 'vitest';
import { flush } from './helpers.js';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState, useEffect, useMemo } from '../src/hooks.js';

function mount(fn) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const component = new FunctionComponent(fn, container).mount();
  return { container, component };
}

// 예약 렌더(마이크로태스크)에서 던진 에러를 잡아 확인하기 위해 update를 직접 부른다
function updateNow(component) {
  component.isUpdateScheduled = false;
  return component.update();
}

describe('Hook 개수·순서가 렌더마다 달라지면 바로 에러', () => {
  it('조건부로 Hook이 늘어나면', () => {
    let isOn = false;
    const { component } = mount(() => {
      useState(0);
      if (isOn) useState('추가');
      return h('p');
    });
    isOn = true;
    expect(() => updateNow(component)).toThrow('2번째 Hook(useState)이 이전 렌더에는 없었습니다');
  });

  it('조건부로 Hook이 줄어들면', () => {
    let isOn = true;
    const { component } = mount(() => {
      if (isOn) useState(1);
      useState('두번째');
      return h('p');
    });
    isOn = false;
    expect(() => updateNow(component)).toThrow('Hook 개수가 이전 렌더(2개)와 다릅니다(이번 1개)');
  });

  it('같은 자리에 다른 종류의 Hook이 오면', () => {
    let isOn = false;
    const { component } = mount(() => {
      useState(0);
      if (isOn) useState('끼어듦');
      useMemo(() => 1, []);
      return h('p');
    });
    isOn = true;
    expect(() => updateNow(component)).toThrow('2번째 Hook이 이전 렌더에서는 useMemo였는데 이번에는 useState입니다');
  });

  it('unmount 후 다시 mount하면 처음부터 다시 센다', () => {
    let hookCount = 2;
    const { component } = mount(() => {
      for (let i = 0; i < hookCount; i++) useState(i); // 의도적으로 반복 (렌더마다 개수는 같음)
      return h('p');
    });
    component.unmount();
    hookCount = 3;
    expect(() => component.mount()).not.toThrow();
    expect(component.hooks).toHaveLength(3);
  });
});

describe('무한 렌더 방지', () => {
  it('deps 없는 useEffect 안에서 setState하면 50번 넘게 이어질 때 멈추고 원인을 알린다', async () => {
    const errors = [];
    const handleError = (event) => {
      errors.push(event.error?.message ?? String(event.message));
      event.preventDefault();
    };
    window.addEventListener('error', handleError);
    const originalQueue = globalThis.queueMicrotask;
    // 마이크로태스크에서 던진 에러를 잡을 수 있도록 감싼다
    globalThis.queueMicrotask = (task) =>
      originalQueue(() => {
        try {
          task();
        } catch (error) {
          errors.push(error.message);
        }
      });

    let renders = 0;
    try {
      mount(() => {
        renders++;
        const [n, setN] = useState(0);
        useEffect(() => {
          setN(n + 1);
        });
        return h('p', null, String(n));
      });
      await flush();
      await flush();
    } finally {
      globalThis.queueMicrotask = originalQueue;
      window.removeEventListener('error', handleError);
    }

    expect(errors.some((m) => m.includes('deps 없는 useEffect 안에서 setState'))).toBe(true);
    expect(renders).toBeLessThanOrEqual(52); // mount 1 + 이어진 렌더 50 (+여유 1)
  });

  it('틱이 바뀌면 다시 센다 (사용자가 50번 넘게 클릭해도 문제없음)', async () => {
    let setN;
    const { component, container } = mount(() => {
      const [n, s] = useState(0);
      setN = s;
      return h('p', null, String(n));
    });
    for (let i = 1; i <= 60; i++) {
      setN(i);
      await flush();
    }
    expect(container.textContent).toBe('60');
    expect(component.renderCount).toBe(61);
  });
});

describe('useState 지연 초기화', () => {
  it('함수를 넘기면 첫 렌더에 한 번만 실행해 그 결과를 초기값으로 쓴다', async () => {
    let calls = 0;
    let setN;
    const { container } = mount(() => {
      const [n, s] = useState(() => {
        calls++;
        return 42;
      });
      setN = s;
      return h('p', null, String(n));
    });
    expect(container.textContent).toBe('42');
    setN(43);
    await flush();
    expect(calls).toBe(1);
  });
});

describe('mount 두 번', () => {
  it('이미 mount된 상태에서 다시 mount하면 에러', () => {
    const { component } = mount(() => h('p'));
    expect(() => component.mount()).toThrow('이미 mount된 컴포넌트입니다');
  });
});

describe('unmount 후 같은 인스턴스를 다시 mount (Codex 리뷰)', () => {
  function setupCounter() {
    const log = [];
    const setters = [];
    const container = document.createElement('div');
    const component = new FunctionComponent(() => {
      const [n, setN] = useState(0);
      setters.push(setN);
      log.push(`render ${n}`);
      return h('p', null, String(n));
    }, container);
    component.mount();
    return { component, container, log, setters };
  }

  it('예약된 update가 있는 채로 unmount → mount해도 옛 예약은 새 트리에 적용되지 않는다', async () => {
    const { component, log, setters } = setupCounter();
    setters[0](5); // 예약만 된 상태
    component.unmount();
    component.mount();
    expect(component.isUpdateScheduled).toBe(false);

    await flush();
    expect(log).toEqual(['render 0', 'render 0']); // mount 2번뿐, 옛 예약으로 인한 렌더 없음
    expect(component.renderCount).toBe(2);
  });

  it('remount 직후의 새 setState는 정상으로 예약·반영된다', async () => {
    const { component, container, setters } = setupCounter();
    setters[0](5);
    component.unmount();
    component.mount();
    setters.at(-1)(7); // 새 mount의 setState
    await flush();
    expect(container.textContent).toBe('7');
    expect(component.renderCount).toBe(3);
  });

  it('unmount 전에 받아 둔 옛 setState는 새 트리에 영향을 주지 않는다', async () => {
    const { component, container, setters } = setupCounter();
    const oldSetN = setters[0];
    component.unmount();
    component.mount();

    oldSetN(99);
    await flush();
    expect(container.textContent).toBe('0');
    expect(component.renderCount).toBe(2);
  });

  it('렌더 도중 실패한 mount를 다시 시도하면 빈 사물함에서 시작해 setState가 동작한다', async () => {
    let shouldFail = true;
    let setN;
    const container = document.createElement('div');
    const component = new FunctionComponent(() => {
      const [n, s] = useState(0);
      setN = s;
      if (shouldFail) throw new Error('첫 mount 실패');
      return h('p', null, String(n));
    }, container);

    expect(() => component.mount()).toThrow('첫 mount 실패');
    shouldFail = false;
    component.mount();
    setN(3);
    await flush();
    expect(container.textContent).toBe('3');
  });
});
