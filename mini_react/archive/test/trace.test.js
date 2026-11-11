// 학습 페이지용 trace 알림: 엔진이 "무슨 일이 일어났는지"를 순서대로 알리는지
import { describe, it, expect } from 'vitest';
import { flush } from './helpers.js';
import { h } from '../src/vdom.js';
import { expand, FunctionComponent } from '../src/component.js';
import { useState, useEffect, useMemo } from '../src/hooks.js';

function mountTraced(fn, options = {}) {
  const events = [];
  const container = document.createElement('div');
  const component = new FunctionComponent(fn, container, { ...options, trace: (e) => events.push(e) }).mount();
  return { events, container, component, types: () => events.map((e) => e.type) };
}

// 클릭 한 번에 setCount를 times번 부르는 Counter
function createCounter(times = 1) {
  return function Counter() {
    const [count, setCount] = useState(0);
    const handleClick = () => {
      for (let i = 0; i < times; i++) setCount((c) => c + 1);
    };
    return h('button', { onClick: handleClick }, `클릭 ${count}`);
  };
}

describe('trace', () => {
  it('trace 없이도 기존과 같다', async () => {
    const container = document.createElement('div');
    const component = new FunctionComponent(createCounter(), container).mount();
    container.firstChild.click();
    await flush();
    expect(component.renderCount).toBe(2);
    expect(container.textContent).toBe('클릭 1');
  });

  it('mount 사건 순서', () => {
    const { events, types } = mountTraced(createCounter());
    expect(types()).toEqual(['render:start', 'hook:state', 'commit:done']);
    expect(events[0]).toEqual({ type: 'render:start', kind: 'mount' });
    expect(events[1]).toEqual({ type: 'hook:state', index: 0, isFirst: true, value: 0 });
    expect(events[2]).toEqual({ type: 'commit:done', kind: 'mount' });
  });

  it('setState 3번 → state:set 3번, 새 예약 1번, update 1번', async () => {
    const { events, container } = mountTraced(createCounter(3));
    events.length = 0;
    container.firstChild.click();
    await flush();

    expect(events.map((e) => e.type)).toEqual([
      'state:set', 'update:schedule', 'state:set', 'update:schedule', 'state:set', 'update:schedule',
      'update:start', 'render:start', 'hook:state', 'diff:done', 'commit:done',
    ]);
    expect(events.filter((e) => e.type === 'update:schedule').map((e) => e.alreadyScheduled)).toEqual([false, true, true]);
    expect(events.filter((e) => e.type === 'state:set').map(({ prev, next }) => [prev, next])).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(events.find((e) => e.type === 'render:start').kind).toBe('update');
    expect(events.find((e) => e.type === 'hook:state')).toEqual({ type: 'hook:state', index: 0, isFirst: false, value: 3 });
    expect(events.find((e) => e.type === 'diff:done').patches.length).toBeGreaterThan(0);
  });

  it('같은 값 setState는 skipped: true이고 예약하지 않는다', async () => {
    const { events, component } = mountTraced(createCounter());
    events.length = 0;
    component.hooks[0].setState(0);
    await flush();
    expect(events).toEqual([{ type: 'state:set', index: 0, prev: 0, next: 0, skipped: true }]);
  });

  it('expand onComponent는 바깥 컴포넌트부터 순서대로 알린다', () => {
    const Item = ({ text }) => h('li', null, text);
    const Card = ({ children }) => h('ul', null, children);
    const seen = [];
    expand(h(Card, { title: '할 일' }, h(Item, { text: 'a' }), h(Item, { text: 'b' })), {
      onComponent: (e) => seen.push(e),
    });
    expect(seen.map((e) => e.name)).toEqual(['Card', 'Item', 'Item']);
    expect(seen[0].type).toBe('expand:component');
    expect(seen[0].props.title).toBe('할 일');
    expect(seen[0].props.children).toHaveLength(2);
    expect(seen[1].props).toEqual({ text: 'a', children: [] });
  });

  it('FunctionComponent도 자식 컴포넌트 펼치기를 expand:component로 알린다', () => {
    const Item = () => h('li', null, 'x');
    const { events } = mountTraced(() => h('ul', null, h(Item), h(Item)));
    expect(events.filter((e) => e.type === 'expand:component').map((e) => e.name)).toEqual(['Item', 'Item']);
  });

  it('effect: mount엔 run만, deps가 바뀐 update엔 cleanup → run', async () => {
    const { events, component } = mountTraced(() => {
      const [n] = useState(0);
      useEffect(() => () => {}, [n]);
      return h('p', null, String(n));
    });
    expect(events.map((e) => e.type).slice(-2)).toEqual(['commit:done', 'effect:run']);
    expect(events.find((e) => e.type === 'hook:effect')).toEqual({ type: 'hook:effect', index: 1, queued: true });
    expect(events.at(-1)).toEqual({ type: 'effect:run', index: 1 });

    events.length = 0;
    component.hooks[0].setState(1);
    await flush();
    expect(events.map((e) => e.type).slice(-3)).toEqual(['commit:done', 'effect:cleanup', 'effect:run']);
    expect(events.find((e) => e.type === 'effect:cleanup')).toEqual({ type: 'effect:cleanup', index: 1 });
  });

  it('effect: deps가 같으면 queued: false이고 실행하지 않는다', async () => {
    const { events, component } = mountTraced(() => {
      const [n] = useState(0);
      useEffect(() => {}, []);
      return h('p', null, String(n));
    });
    events.length = 0;
    component.hooks[0].setState(1);
    await flush();
    expect(events.find((e) => e.type === 'hook:effect')).toEqual({ type: 'hook:effect', index: 1, queued: false });
    expect(events.some((e) => e.type === 'effect:run')).toBe(false);
  });

  it('memo: deps가 같으면 recomputed: false', async () => {
    const { events, component } = mountTraced(() => {
      const [n] = useState(0);
      const [text] = useState('a');
      const doubled = useMemo(() => n * 2, [n]);
      return h('p', null, `${doubled}${text}`);
    });
    expect(events.find((e) => e.type === 'hook:memo')).toEqual({ type: 'hook:memo', index: 2, recomputed: true, value: 0 });

    events.length = 0;
    component.hooks[1].setState('b'); // memo의 deps(n)는 그대로
    await flush();
    expect(events.find((e) => e.type === 'hook:memo')).toEqual({ type: 'hook:memo', index: 2, recomputed: false, value: 0 });
  });

  it('unmount는 unmount 다음 effect:cleanup', () => {
    const { events, component } = mountTraced(() => {
      useEffect(() => () => {}, []);
      return h('p');
    });
    events.length = 0;
    component.unmount();
    expect(events).toEqual([{ type: 'unmount' }, { type: 'effect:cleanup', index: 0 }]);
  });

  it('render:start 순간에는 이미 hookIndex가 0이다 (다시 렌더할 때도 0번 사물함부터)', async () => {
    const seen = [];
    const container = document.createElement('div');
    const component = new FunctionComponent(createCounter(), container, {
      trace: (event, c) => {
        if (event.type === 'render:start') seen.push([event.kind, c.hookIndex]);
      },
    }).mount();
    component.hooks[0].setState(5);
    await flush();
    expect(seen).toEqual([['mount', 0], ['update', 0]]);
  });
});
