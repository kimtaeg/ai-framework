import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/lib/vdom.js';
import {
  FunctionComponent, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer,
} from '../src/lib/component.js';
import { container, flushMicrotasks } from './setup.js';

/** 컴포넌트 밖에서 setter 를 꺼내 쓰기 위한 헬퍼 */
function setup(fn, opts) {
  const el = container();
  const comp = new FunctionComponent(fn, {}, opts).mount(el);
  return { el, comp };
}

describe('FunctionComponent', () => {
  test('mount: 최초 렌더링 시 DOM 을 만든다', () => {
    const { el, comp } = setup(() => h('p', { class: 'x' }, 'hi'));
    assert.equal(el.innerHTML, '<p class="x">hi</p>');
    assert.equal(comp.isMounted, true);
    assert.equal(comp.renderCount, 1);
  });

  test('update: 상태 변경 후 diff/patch 로 같은 DOM 노드를 재사용', async () => {
    let set;
    const { el } = setup(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h('div', null, h('span', null, `count ${n}`), h('i', null, 'static'));
    });
    const span = el.querySelector('span');
    const italic = el.querySelector('i');
    set(5);
    await flushMicrotasks();
    assert.equal(span.textContent, 'count 5');
    assert.equal(el.querySelector('span'), span, 'span 노드가 재생성되지 않아야 함');
    assert.equal(el.querySelector('i'), italic);
  });

  test('update() 는 diff 결과 patches 를 반환한다', () => {
    let set;
    const { comp } = setup(() => {
      const [n, setN] = useState('a');
      set = setN;
      return h('p', null, n);
    });
    set('b');
    const patches = comp.flush();
    assert.deepEqual(patches.map((p) => p.type), ['TEXT']);
  });

  test('onCommit 콜백에 커밋 정보가 전달된다', async () => {
    const commits = [];
    let set;
    setup(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h('p', null, n);
    }, { onCommit: (info) => commits.push(info.type) });
    set(1);
    await flushMicrotasks();
    assert.deepEqual(commits, ['mount', 'update']);
  });

  test('unmount: DOM 제거 + effect cleanup + 이후 setState 무시', async () => {
    let cleaned = 0;
    let set;
    const { el, comp } = setup(() => {
      const [n, setN] = useState(0);
      set = setN;
      useEffect(() => () => cleaned++, []);
      return h('p', null, n);
    });
    comp.unmount();
    assert.equal(el.innerHTML, '');
    assert.equal(cleaned, 1);
    set(10);
    await flushMicrotasks();
    assert.equal(comp.renderCount, 1);
  });

  test('루트가 null 을 반환해도 동작', () => {
    const { el } = setup(() => null);
    assert.equal(el.textContent, '');
  });
});

describe('useState', () => {
  test('렌더 간 상태 유지 + 함수형 업데이트', async () => {
    let set;
    const { el } = setup(() => {
      const [n, setN] = useState(1);
      set = setN;
      return h('b', null, n);
    });
    set((x) => x + 1);
    set((x) => x * 10);
    await flushMicrotasks();
    assert.equal(el.textContent, '20');
  });

  test('lazy initializer 는 1회만 호출', async () => {
    let calls = 0;
    let set;
    setup(() => {
      const [n, setN] = useState(() => { calls++; return 0; });
      set = setN;
      return h('b', null, n);
    });
    set(1);
    await flushMicrotasks();
    set(2);
    await flushMicrotasks();
    assert.equal(calls, 1);
  });

  test('setState 함수의 참조는 렌더가 바뀌어도 동일', async () => {
    const setters = [];
    const { comp } = setup(() => {
      const [n, setN] = useState(0);
      setters.push(setN);
      return h('b', null, n);
    });
    setters[0](1);
    comp.flush();
    assert.equal(setters[0], setters[1]);
  });

  test('같은 값으로 setState 하면 리렌더하지 않는다 (bail-out)', async () => {
    let set;
    const { comp } = setup(() => {
      const [n, setN] = useState(3);
      set = setN;
      return h('b', null, n);
    });
    set(3);
    await flushMicrotasks();
    assert.equal(comp.renderCount, 1);
  });

  test('Batching: 여러 setState 는 한 번만 렌더링', async () => {
    let setA, setB;
    const { comp, el } = setup(() => {
      const [a, sa] = useState(0);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      return h('p', null, `${a}-${b}`);
    });
    setA(1); setA((x) => x + 1); setB(9);
    assert.equal(comp.renderCount, 1, '동기 구간에서는 아직 렌더링하지 않음');
    await flushMicrotasks();
    assert.equal(comp.renderCount, 2);
    assert.equal(el.textContent, '2-9');
  });

  test('여러 useState 는 호출 순서로 구분된다', async () => {
    let setSecond;
    const { el } = setup(() => {
      const [a] = useState('A');
      const [b, sb] = useState('B');
      const [c] = useState('C');
      setSecond = sb;
      return h('p', null, a + b + c);
    });
    setSecond('x');
    await flushMicrotasks();
    assert.equal(el.textContent, 'AxC');
  });
});

describe('useEffect', () => {
  test('화면 반영 후 비동기로 실행된다 (DOM 접근 가능)', async () => {
    let seen = null;
    setup(() => {
      useEffect(() => { seen = document.querySelector('#eff')?.textContent; }, []);
      return h('p', { id: 'eff' }, 'ready');
    });
    assert.equal(seen, null, 'mount 직후에는 아직 실행 전 (그리기 뒤로 미뤄짐)');
    await flushMicrotasks();
    assert.equal(seen, 'ready');
  });

  test('useLayoutEffect 는 DOM 반영 직후 동기로, useEffect 는 그 뒤에', async () => {
    const order = [];
    let set;
    setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      useEffect(() => { order.push(`effect ${n}`); return () => order.push(`effect cleanup ${n}`); });
      useLayoutEffect(() => { order.push(`layout ${n} dom=${document.querySelector('#le').textContent}`); return () => order.push(`layout cleanup ${n}`); });
      return h('b', { id: 'le' }, n);
    }, { onCommit: () => order.push('commit') });
    assert.deepEqual(order, ['layout 0 dom=0', 'commit'], '레이아웃 effect 는 commit 알림 전에 이미 실행');
    await flushMicrotasks();
    assert.deepEqual(order.slice(2), ['effect 0']);
    order.length = 0;
    set(1);
    await flushMicrotasks();
    assert.deepEqual(order, ['layout cleanup 0', 'layout 1 dom=1', 'commit', 'effect cleanup 0', 'effect 1']);
  });

  test('다음 업데이트 전에 밀린 useEffect 를 먼저 실행한다', () => {
    const order = [];
    let set;
    const { comp } = setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      useEffect(() => { order.push(`effect ${n}`); });
      return h('b', null, n);
    });
    set(1);
    comp.flush(); // 동기로: 밀린 effect 0 → 렌더 1 → effect 1
    assert.deepEqual(order, ['effect 0', 'effect 1']);
  });

  test('언마운트 전에 아직 안 돈 effect 를 실행하고 cleanup 도 호출', () => {
    const log = [];
    const { comp } = setup(() => {
      useEffect(() => { log.push('run'); return () => log.push('clean'); }, []);
      return h('p');
    });
    comp.unmount();
    assert.deepEqual(log, ['run', 'clean']);
  });

  test('deps 가 바뀔 때만 재실행 + 이전 cleanup 먼저 호출', async () => {
    const log = [];
    let setA, setB;
    setup(() => {
      const [a, sa] = useState(0);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      useEffect(() => {
        log.push(`run ${a}`);
        return () => log.push(`clean ${a}`);
      }, [a]);
      return h('p', null, `${a}${b}`);
    });
    setB(1);
    await flushMicrotasks();
    assert.deepEqual(log, ['run 0'], 'b 변경은 effect 를 실행하지 않음');
    setA(1);
    await flushMicrotasks();
    assert.deepEqual(log, ['run 0', 'clean 0', 'run 1']);
  });

  test('deps 생략 → 매 렌더 실행, [] → 1회', async () => {
    let every = 0;
    let once = 0;
    let set;
    setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      useEffect(() => { every++; });
      useEffect(() => { once++; }, []);
      return h('p', null, n);
    });
    set(1);
    await flushMicrotasks();
    set(2);
    await flushMicrotasks();
    assert.equal(every, 3);
    assert.equal(once, 1);
  });

  test('effect 안의 setState 는 다음 업데이트를 예약한다', async () => {
    const { el } = setup(() => {
      const [n, sn] = useState(0);
      useEffect(() => { if (n < 3) sn(n + 1); }, [n]);
      return h('p', null, n);
    });
    for (let i = 0; i < 5; i++) await flushMicrotasks();
    assert.equal(el.textContent, '3');
  });

  test('무한 업데이트 루프를 감지한다', async () => {
    const errors = [];
    const { comp } = setup(() => {
      const [n, sn] = useState(0);
      useEffect(() => { sn(n + 1); }); // deps 없음 → 무한 루프
      return h('p', null, n);
    }, { onError: (e) => errors.push(e) });
    // useEffect 는 화면을 그린 뒤(다음 작업)에 실행되므로 한 바퀴마다 작업 하나씩 걸린다
    for (let i = 0; i < 40 && errors.length === 0; i++) await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /중첩/);
    assert.ok(comp.renderCount <= 60, '루프가 중단되어야 함');
  });
});

describe('useMemo / useCallback / useRef / useReducer', () => {
  test('useMemo: deps 가 같으면 재계산하지 않는다', async () => {
    let computed = 0;
    let setA, setB;
    const { el } = setup(() => {
      const [a, sa] = useState(2);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      const sq = useMemo(() => { computed++; return a * a; }, [a]);
      return h('p', null, `${sq}/${b}`);
    });
    setB(1);
    await flushMicrotasks();
    assert.equal(computed, 1);
    setA(3);
    await flushMicrotasks();
    assert.equal(computed, 2);
    assert.equal(el.textContent, '9/1');
  });

  test('useMemo 로 재사용한 VNode 는 diff 를 건너뛴다', async () => {
    let set;
    const { comp } = setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      const heavy = useMemo(() => h('ul', null, [1, 2, 3].map((i) => h('li', { key: i }, i))), []);
      return h('div', null, h('b', null, n), heavy);
    });
    set(1);
    const patches = comp.flush();
    assert.deepEqual(patches.map((p) => p.path), [[0, 0]], 'b 의 텍스트만 변경');
  });

  test('useCallback: 참조 유지', async () => {
    const fns = [];
    let set;
    setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      fns.push(useCallback(() => n, []));
      return h('p', null, n);
    });
    set(1);
    await flushMicrotasks();
    assert.equal(fns[0], fns[1]);
  });

  test('useRef: 값이 유지되고 변경해도 리렌더하지 않는다', async () => {
    let ref;
    let set;
    const { comp } = setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      ref = useRef(0);
      ref.current++;
      return h('p', null, n);
    });
    set(1);
    await flushMicrotasks();
    assert.equal(ref.current, 2);
    assert.equal(comp.renderCount, 2);
  });

  test('useReducer', async () => {
    let dispatch;
    const { el } = setup(() => {
      const [s, d] = useReducer((st, a) => (a === 'inc' ? st + 1 : st), 0);
      dispatch = d;
      return h('p', null, s);
    });
    dispatch('inc');
    dispatch('inc');
    await flushMicrotasks();
    assert.equal(el.textContent, '2');
  });
});

describe('제약 조건: Hook 은 루트 컴포넌트에서만', () => {
  test('자식 컴포넌트는 props 만 받아 렌더링된다', async () => {
    const Child = ({ label, children }) => h('span', { class: 'child' }, label, ...children);
    let set;
    const { el } = setup(() => {
      const [n, sn] = useState(0);
      set = sn;
      return h('div', null, h(Child, { label: `n=${n}` }, '!'));
    });
    assert.equal(el.innerHTML, '<div><span class="child">n=0!</span></div>');
    set(1);
    await flushMicrotasks();
    assert.equal(el.textContent, 'n=1!');
  });

  test('자식 컴포넌트에서 Hook 을 호출하면 에러', () => {
    const BadChild = () => { useState(0); return h('p'); };
    assert.throws(() => setup(() => h('div', null, h(BadChild))), /최상위\(루트\) 컴포넌트에서만/);
  });

  test('컴포넌트 밖에서 Hook 호출 시 에러', () => {
    assert.throws(() => useState(0), /렌더링되는 중에만/);
  });

  test('조건부 Hook 호출(개수 변화)을 감지한다', () => {
    let set;
    const { comp } = setup(() => {
      const [on, so] = useState(false);
      set = so;
      if (on) useMemo(() => 1, []);
      return h('p', null, String(on));
    });
    set(true);
    assert.throws(() => comp.flush(), /Hook 호출 개수/);
  });

  test('Hook 순서(종류) 변화를 감지한다', () => {
    let set;
    const { comp } = setup(() => {
      const [on, so] = useState(false);
      set = so;
      if (on) useMemo(() => 1, []); else useRef(0);
      return h('p', null, String(on));
    });
    set(true);
    assert.throws(() => comp.flush(), /순서/);
  });

  test('자식 컴포넌트의 key 는 결과 엘리먼트로 전달된다 (MOVE 로 재정렬)', () => {
    const Item = ({ v }) => h('li', null, v);
    let set;
    const { el, comp } = setup(() => {
      const [list, sl] = useState(['a', 'b', 'c']);
      set = sl;
      return h('ul', null, list.map((v) => h(Item, { key: v, v })));
    });
    const c = el.querySelectorAll('li')[2];
    set(['c', 'a', 'b']);
    const patches = comp.flush();
    assert.deepEqual(patches.map((p) => p.type), ['MOVE']);
    assert.equal(el.querySelector('li'), c);
  });

  test('자식 컴포넌트가 배열(fragment)을 반환해도 펼쳐진다', () => {
    const Pair = () => [h('dt', null, 'k'), h('dd', null, 'v')];
    const { el } = setup(() => h('dl', null, h(Pair)));
    assert.equal(el.innerHTML, '<dl><dt>k</dt><dd>v</dd></dl>');
  });
});

describe('렌더 실패 · 렌더 중 setState', () => {
  test('렌더가 실패해도 effect deps 는 커밋된 렌더 기준으로 비교한다', async () => {
    let set;
    let boom = false;
    const runs = [];
    const { el, comp } = setup(() => {
      const [n, setN] = useState(0);
      set = setN;
      useEffect(() => { runs.push(n); }, [n]);
      if (boom) throw new Error('render fail');
      return h('p', null, String(n));
    }, { onError: () => {} });
    await flushMicrotasks();
    boom = true;
    set(1);
    assert.throws(() => comp.flush(), /render fail/); // n=1 렌더 실패 → 화면은 0 그대로
    boom = false;
    set(2);
    set(1);
    comp.flush(); // n=1 이 처음으로 커밋된다
    assert.equal(el.textContent, '1');
    assert.deepEqual(runs, [0, 1]);
  });

  test('실패한 렌더가 새로 만든 Hook 슬롯은 남지 않는다', () => {
    let set;
    let extra = false;
    const { el, comp } = setup(() => {
      const [n, setN] = useState(0);
      set = setN;
      if (extra) useState('x'); // 규칙 위반 (조건부 Hook)
      return h('p', null, String(n));
    }, { onError: () => {} });
    extra = true;
    set(1);
    assert.throws(() => comp.flush(), /Hook 호출 개수/);
    assert.equal(comp.hooks.length, 1);
    extra = false;
    set(2);
    comp.flush(); // 규칙을 지키면 다시 정상 동작
    assert.equal(el.textContent, '2');
  });

  test('렌더 중 조건 없는 setState 는 무한 루프 대신 에러로 멈춘다', async () => {
    const errors = [];
    let renders = 0;
    const { el } = setup(() => {
      const [n, setN] = useState(0);
      renders++;
      if (renders < 1000) setN(n + 1);
      return h('p', null, String(n));
    }, { onError: (e) => errors.push(e) });
    await flushMicrotasks(10);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Too many re-renders/);
    assert.ok(renders <= 30, `렌더 ${renders}번`);
    assert.equal(el.textContent, '24'); // 마지막으로 성공한 렌더의 화면
  });

  test('조건부로 끝나는 렌더 중 setState (props 에서 state 파생) 는 그대로 동작한다', async () => {
    const errors = [];
    const { el } = setup(() => {
      const [n, setN] = useState(0);
      if (n < 3) setN(n + 1);
      return h('p', null, String(n));
    }, { onError: (e) => errors.push(e) });
    await flushMicrotasks(10);
    assert.equal(el.textContent, '3');
    assert.equal(errors.length, 0);
  });
});
