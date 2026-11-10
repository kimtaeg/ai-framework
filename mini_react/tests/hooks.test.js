import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { FunctionComponent } from '../src/core/component.js';
import { useState, useEffect, useMemo } from '../src/core/hooks.js';

// setState는 다시 그리기를 마이크로태스크로 예약만 한다. 다음 매크로태스크까지 기다리면 update·effect가 끝나 있다
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(App, options) {
  const container = makeContainer();
  const component = new FunctionComponent(App, container, options).mount();
  return { container, component, text: () => container.textContent };
}

describe('useState', () => {
  test('첫 렌더에는 초기값, 이후에는 저장된 값 (초기값 무시)', async () => {
    let setCount;
    let initial = 1;
    const { text } = mount(() => {
      const [count, set] = useState(initial);
      setCount = set;
      return h('p', null, `count ${count}`);
    });
    assert.equal(text(), 'count 1');
    initial = 999;
    setCount(5);
    assert.equal(text(), 'count 1'); // 아직 예약만 됨
    await flush();
    assert.equal(text(), 'count 5');
  });

  test('함수형 업데이트 setState(prev => next)는 연속 호출이 모두 반영된다', async () => {
    let increase;
    const { text, component } = mount(() => {
      const [count, setCount] = useState(0);
      increase = () => setCount((c) => c + 1);
      return h('p', null, String(count));
    });
    increase();
    increase();
    increase();
    await flush();
    assert.equal(text(), '3');
    assert.equal(component.renderCount, 2); // mount 1 + 배칭된 update 1
  });

  test('같은 값(Object.is)이면 다시 그리지 않는다', async () => {
    let setCount;
    const { component } = mount(() => {
      const [count, set] = useState(0);
      setCount = set;
      return h('p', null, String(count));
    });
    setCount(0);
    setCount((c) => c);
    await flush();
    assert.equal(component.renderCount, 1);
  });

  test('useState 여러 개는 호출 순서대로 각자 사물함을 가진다', async () => {
    let setB;
    const { text } = mount(() => {
      const [a] = useState('A');
      const [b, set] = useState('B');
      setB = set;
      return h('p', null, `${a}${b}`);
    });
    setB('b!');
    await flush();
    assert.equal(text(), 'Ab!');
  });

  test('useState(() => 값)은 첫 렌더에 한 번만 실행 (지연 초기화)', async () => {
    let calls = 0;
    let setN;
    mount(() => {
      const [n, set] = useState(() => (calls++, 1));
      setN = set;
      return h('p', null, String(n));
    });
    setN(2);
    await flush();
    assert.equal(calls, 1);
  });
});

describe('useEffect', () => {
  test('patch로 화면이 바뀐 뒤에 실행된다', () => {
    const container = makeContainer();
    const seen = [];
    new FunctionComponent(() => {
      useEffect(() => seen.push(container.textContent));
      return h('p', null, '그려진 뒤');
    }, container).mount();
    assert.deepEqual(seen, ['그려진 뒤']);
  });

  test('deps 생략 → 매 렌더 / [] → 처음 한 번 / [a] → a가 바뀔 때만', async () => {
    const runs = { none: 0, empty: 0, a: 0 };
    let setA;
    let setB;
    mount(() => {
      const [a, sa] = useState(0);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      useEffect(() => { runs.none++; });
      useEffect(() => { runs.empty++; }, []);
      useEffect(() => { runs.a++; }, [a]);
      return h('p', null, `${a}${b}`);
    });
    setB(1);
    await flush();
    setA(1);
    await flush();
    assert.deepEqual(runs, { none: 3, empty: 1, a: 2 });
  });

  test('cleanup: 다시 실행 직전에 옛 cleanup부터 (여러 effect는 정리를 모두 먼저)', async () => {
    const log = [];
    let setN;
    mount(() => {
      const [n, set] = useState(0);
      setN = set;
      useEffect(() => { log.push(`A${n}`); return () => log.push(`A정리${n}`); }, [n]);
      useEffect(() => { log.push(`B${n}`); return () => log.push(`B정리${n}`); }, [n]);
      return h('p');
    });
    setN(1);
    await flush();
    assert.deepEqual(log, ['A0', 'B0', 'A정리0', 'B정리0', 'A1', 'B1']);
  });

  test('unmount하면 남은 cleanup을 모두 부르고 화면을 비운다', () => {
    const log = [];
    const { component, container } = mount(() => {
      useEffect(() => () => log.push('정리'), []);
      return h('p', null, 'x');
    });
    component.unmount();
    assert.deepEqual(log, ['정리']);
    assert.equal(container.childNodes.length, 0);
  });
});

describe('useMemo', () => {
  test('deps가 같으면 이전 값을 재사용하고, 바뀌면 다시 계산', async () => {
    let calls = 0;
    let setA;
    let setB;
    const { text } = mount(() => {
      const [a, sa] = useState(2);
      const [b, sb] = useState('x');
      setA = sa;
      setB = sb;
      const doubled = useMemo(() => (calls++, a * 2), [a]);
      return h('p', null, `${doubled}${b}`);
    });
    setB('y');
    await flush();
    assert.equal(calls, 1);
    setA(5);
    await flush();
    assert.equal(calls, 2);
    assert.equal(text(), '10y');
  });
});

describe('Hook 규칙 위반은 명확한 에러', () => {
  test('자식 컴포넌트에서 Hook을 부르면 에러 (Lifting State Up)', () => {
    const Child = () => {
      useState(0);
      return h('span');
    };
    assert.throws(() => mount(() => h('div', null, h(Child))), /루트 컴포넌트\(App\)에서만/);
  });

  test('렌더 밖(이벤트 핸들러, 컴포넌트 밖)에서 부르면 에러', () => {
    assert.throws(() => useState(0), /렌더되는 중에만/);
  });

  test('Hook 개수·순서가 렌더마다 달라지면 에러', async () => {
    let isOn = false;
    const { component } = mount(() => {
      useState(0);
      if (isOn) useState('끼어듦');
      return h('p');
    });
    isOn = true;
    assert.throws(() => component.update(), /이전 렌더에는 없었습니다/);
  });

  test('렌더 중에 setState하면 무한 렌더를 막는 에러', () => {
    assert.throws(
      () => mount(() => {
        const [, set] = useState(0);
        set(1);
        return h('p');
      }),
      /렌더 중에 setState/
    );
  });
});
