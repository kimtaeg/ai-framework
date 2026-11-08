// Phase 2 마무리 점검에서 찾은 엣지 케이스 회귀 테스트
import { describe, it, expect } from 'vitest';
import { flush } from './helpers.js';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState, useEffect, useMemo } from '../src/hooks.js';
import { createApp, sanitizeTodos } from '../phase2/app.js';

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

describe('할 일 앱: 빠른 연속 클릭과 빈 목록', () => {
  const TODOS = [
    { id: 'a', text: 'A', done: false },
    { id: 'b', text: 'B', done: false },
  ];

  it('같은 틱에 체크를 두 번 누르면 원래대로, 렌더는 한 번', async () => {
    const { container, component } = mount(createApp({ initialTodos: TODOS }));
    const box = container.querySelector('input[type=checkbox]');
    box.click();
    box.click();
    await flush();
    expect(container.querySelector('.todo').className).toBe('todo');
    expect(component.renderCount).toBe(2);
    expect(component.lastBatchSize).toBe(2);
  });

  it('같은 틱에 같은 삭제 버튼을 두 번 눌러도 하나만 지워진다', async () => {
    const { container } = mount(createApp({ initialTodos: TODOS }));
    const button = container.querySelector('.todo__delete');
    button.click();
    button.click();
    await flush();
    expect([...container.querySelectorAll('.todo__text')].map((el) => el.textContent)).toEqual(['B']);
  });

  it('여러 틱에 걸쳐 빠르게 추가해도 순서대로 모두 들어간다', async () => {
    const { container } = mount(createApp({ initialTodos: [] }));
    for (const text of ['1', '2', '3', '4', '5']) {
      const input = container.querySelector('.todo-input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      container.querySelector('.todo-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    }
    expect([...container.querySelectorAll('.todo__text')].map((el) => el.textContent)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('빈 목록: 안내 문구, 완료 지우기 비활성, 모든 필터에서 깨지지 않음', async () => {
    const { container } = mount(createApp({ initialTodos: [] }));
    expect(container.querySelector('.todo-footer .btn').disabled).toBe(true);
    for (const key of ['active', 'done', 'all']) {
      container.querySelector(`[data-filter="${key}"]`).click();
      await flush();
      expect(container.querySelector('.todo-empty')).not.toBeNull();
    }
  });

  it('마지막 하나를 지우면 목록 대신 안내 문구로 바뀐다 (ul → p REPLACE)', async () => {
    const renders = [];
    const container = document.createElement('div');
    new FunctionComponent(createApp({ initialTodos: [TODOS[0]] }), container, {
      onRender: (info) => renders.push(info),
    }).mount();
    container.querySelector('.todo__delete').click();
    await flush();
    expect(container.querySelector('.todo-list')).toBeNull();
    expect(container.querySelector('.todo-empty')).not.toBeNull();
    expect(renders.at(-1).patches.some((p) => p.type === 'REPLACE')).toBe(true);
  });
});

describe('저장 데이터 정리 (sanitizeTodos)', () => {
  it('배열이 아니면 null (샘플로 시작)', () => {
    expect(sanitizeTodos(null)).toBeNull();
    expect(sanitizeTodos({ a: 1 })).toBeNull();
  });

  it('깨진 항목은 버리고, 빠진 값은 채우고, 중복 id는 새로 만든다', () => {
    const result = sanitizeTodos([
      null,
      'x',
      { text: 1 },
      { text: '   ' },
      { id: 'a', text: '정상', done: true },
      { id: 'a', text: '중복 id', done: 'yes' },
      { text: 'id 없음' },
    ]);
    expect(result.map(({ text, done }) => ({ text, done }))).toEqual([
      { text: '정상', done: true },
      { text: '중복 id', done: false },
      { text: 'id 없음', done: false },
    ]);
    expect(new Set(result.map((t) => t.id)).size).toBe(3);
  });

  it('정리한 데이터로 앱이 정상 시작한다', () => {
    const initialTodos = sanitizeTodos([null, { text: '살아남음' }]);
    const { container } = mount(createApp({ initialTodos }));
    expect(container.querySelector('.todo__text').textContent).toBe('살아남음');
  });
});
