import { describe, it, expect } from 'vitest';
import { h } from '../src/vdom.js';
import { FunctionComponent } from '../src/component.js';
import { useState } from '../src/hooks.js';
import { OBSERVE_OPTIONS, summarizeMutations } from '../src/mutationStats.js';

// 예약된 update(마이크로태스크)가 끝날 때까지 기다린다
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 클릭 한 번에 setState를 3번 부르는 카운터. 배칭 켬/끔만 바꿔 같은 코드로 비교한다.
function mountCounter(options) {
  const container = document.createElement('div');
  const renders = [];
  const component = new FunctionComponent(
    () => {
      const [count, setCount] = useState(0);
      return h(
        'button',
        {
          onClick: () => {
            setCount((c) => c + 1);
            setCount((c) => c + 1);
            setCount((c) => c + 1);
          },
        },
        `count ${count}`
      );
    },
    container,
    { ...options, onRender: (info) => renders.push(info) }
  ).mount();

  // 실제 DOM이 몇 번 바뀌는지도 같이 센다.
  // await 하는 동안 콜백이 기록을 먼저 가져가므로, 콜백으로 받은 것과 남은 것(takeRecords)을 합친다.
  const records = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(container, OBSERVE_OPTIONS);
  const takeMutations = () => summarizeMutations([...records.splice(0), ...observer.takeRecords()]);

  return { container, component, renders, takeMutations, button: container.firstChild };
}

describe('Batching (기본: 켬)', () => {
  it('setState 3번 → 렌더 1번, 최종 값에는 3번 모두 반영', async () => {
    const { component, button, container } = mountCounter();

    button.click();
    expect(container.textContent).toBe('count 0'); // 아직 예약만 됨
    expect(component.isUpdateScheduled).toBe(true);
    await flush();

    expect(container.textContent).toBe('count 3');
    expect(component.renderCount).toBe(2); // mount 1 + update 1
    expect(component.lastBatchSize).toBe(3); // 3번의 setState가 한 렌더로 합쳐짐
  });

  it('실제 DOM 텍스트도 한 번만 바뀐다 (중간값 1, 2는 화면에 나타나지 않음)', async () => {
    const { button, takeMutations } = mountCounter();
    button.click();
    await flush();
    expect(takeMutations()).toMatchObject({ text: 1, total: 1 });
  });

  it('이미 예약돼 있으면 다시 예약하지 않는다 (마이크로태스크 1개)', async () => {
    const { component } = mountCounter();
    // 같은 컴포넌트의 setter를 꺼내기 위해 사물함에 직접 접근
    const setCount = component.hooks[0].setState;

    const scheduled = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task) => {
      scheduled.push(task);
      original(task);
    };
    try {
      setCount(1);
      setCount(2);
      setCount(3);
    } finally {
      globalThis.queueMicrotask = original;
    }

    expect(scheduled).toHaveLength(1);
    await flush();
    expect(component.renderCount).toBe(2);
  });

  it('다른 틱(따로 일어난 이벤트)은 각각 렌더된다', async () => {
    const { component, button } = mountCounter();
    button.click();
    await flush();
    button.click();
    await flush();
    expect(component.renderCount).toBe(3);
  });

  it('같은 값 setState는 배치 크기에 세지 않는다', async () => {
    const { component } = mountCounter();
    const setCount = component.hooks[0].setState;
    setCount(0); // 이미 0 → 무시 (예약도 안 함)
    setCount(5);
    await flush();
    expect(component.renderCount).toBe(2);
    expect(component.lastBatchSize).toBe(1);
  });

  it('onRender로 렌더마다 횟수·배치 크기·patch를 받는다', async () => {
    const { button, renders } = mountCounter();
    button.click();
    await flush();

    expect(renders.map(({ type, renderCount, batchSize }) => ({ type, renderCount, batchSize }))).toEqual([
      { type: 'mount', renderCount: 1, batchSize: 0 },
      { type: 'update', renderCount: 2, batchSize: 3 },
    ]);
    // 렌더마다 새로 만드는 onClick 함수(최신 클로저)로 교체하는 PROPS + 숫자 TEXT
    expect(renders[1].patches.map((p) => p.type)).toEqual(['PROPS', 'TEXT']);
  });
});

describe('Batching 끔 (비교용)', () => {
  it('같은 클릭에서 setState 3번 → 렌더 3번, 최종 값은 같다', () => {
    const { component, button, container, renders } = mountCounter({ batching: false });

    button.click(); // await 없이 바로 반영된다

    expect(container.textContent).toBe('count 3');
    expect(component.renderCount).toBe(4); // mount 1 + update 3
    expect(renders.slice(1).map((r) => r.batchSize)).toEqual([1, 1, 1]);
  });

  it('실제 DOM 텍스트가 3번 바뀐다 (1 → 2 → 3 중간값이 모두 DOM을 거침)', () => {
    const { button, takeMutations } = mountCounter({ batching: false });
    button.click();
    expect(takeMutations()).toMatchObject({ text: 3, total: 3 });
  });
});
