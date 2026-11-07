/**
 * 추가 기능: Context, 개발 경고, 커밋 정보(단계별 시간, 렌더 원인)
 */
import './setup.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';
import { FunctionComponent, useState, useMemo, createContext, useContext } from '../src/lib/component.js';
import { devConfig, resetWarnings } from '../src/lib/warn.js';
import { container, flushMicrotasks } from './setup.js';

const mountApp = (fn, opts) => new FunctionComponent(fn, {}, opts).mount(container());

describe('Context', () => {
  const Theme = createContext('light');
  const Button = () => h('button', null, useContext(Theme));

  test('Provider 가 없으면 기본값, 있으면 가장 가까운 Provider 의 값', () => {
    const comp = mountApp(() =>
      h('div', null,
        h(Button),
        h(Theme.Provider, { value: 'dark' }, h(Button), h(Theme.Provider, { value: 'blue' }, h(Button))),
      ));
    assert.deepEqual([...comp.container.querySelectorAll('button')].map((b) => b.textContent), ['light', 'dark', 'blue']);
  });

  test('Provider 는 DOM 을 만들지 않는다', () => {
    const comp = mountApp(() => h('section', null, h(Theme.Provider, { value: 'x' }, h('i'), h('b'))));
    assert.equal(comp.container.innerHTML, '<section><i></i><b></b></section>');
  });

  test('자식 컴포넌트에서도 useContext 사용 가능 (상태를 만들지 않는 읽기)', async () => {
    let set;
    const Deep = () => h('span', null, `theme=${useContext(Theme)}`);
    const Middle = () => h('div', null, h(Deep));
    const comp = mountApp(() => {
      const [t, st] = useState('light');
      set = st;
      return h(Theme.Provider, { value: t }, h(Middle));
    });
    assert.equal(comp.container.textContent, 'theme=light');
    set('dark');
    await flushMicrotasks();
    assert.equal(comp.container.textContent, 'theme=dark');
  });

  test('useMemo 로 재사용한 VNode 안의 소비자도 새 Context 값을 받는다 (캐시 우회)', async () => {
    let set;
    const comp = mountApp(() => {
      const [t, st] = useState('a');
      set = st;
      const tree = useMemo(() => h('p', null, h(Button)), []);
      return h(Theme.Provider, { value: t }, tree);
    });
    set('b');
    await flushMicrotasks();
    assert.equal(comp.container.textContent, 'b');
  });

  test('렌더 밖에서 useContext 는 에러', () => {
    assert.throws(() => useContext(Theme), /렌더링 중에만/);
  });
});

describe('개발 모드 경고', () => {
  let warnings;
  let original;
  beforeEach(() => {
    warnings = [];
    original = console.warn;
    console.warn = (m) => warnings.push(m);
    devConfig.warnings = true;
    resetWarnings();
  });
  afterEach(() => {
    console.warn = original;
    devConfig.warnings = false;
  });

  test('map 으로 만든 리스트에 key 가 없으면 경고', () => {
    h('ul', null, ['a', 'b'].map((x) => h('li', null, x)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /<ul> 안의 리스트 항목 2개에 key 가 없습니다/);
  });

  test('key 가 있거나 항목이 1개면 경고하지 않음', () => {
    h('ul', null, ['a', 'b'].map((x) => h('li', { key: x }, x)));
    h('ul', null, [h('li')]);
    h('p', null, 'text', h('b')); // 배열이 아닌 일반 자식
    assert.equal(warnings.length, 0);
  });

  test('형제 사이 중복 key 경고', () => {
    diff(h('ul', null, h('li', { key: 1 }), h('li', { key: 1 })), h('ul', null, h('li', { key: 1 })));
    assert.ok(warnings.some((w) => /같은 key "1"/.test(w)));
  });

  test('같은 경고는 한 번만', () => {
    for (let i = 0; i < 3; i++) h('ul', null, [h('li'), h('li')]);
    assert.equal(warnings.length, 1);
  });

  test('언마운트 후 setState 경고', () => {
    let set;
    const comp = mountApp(() => {
      const [, s] = useState(0);
      set = s;
      return h('p');
    });
    comp.unmount();
    set(1);
    assert.ok(warnings.some((w) => /언마운트된 컴포넌트에서 setState/.test(w)));
  });

  test('devConfig.warnings = false 면 조용함', () => {
    devConfig.warnings = false;
    h('ul', null, [h('li'), h('li')]);
    assert.equal(warnings.length, 0);
  });
});

describe('커밋 정보 (Inspector 용)', () => {
  test('단계별 시간과 렌더 원인(setState 들)', async () => {
    const commits = [];
    const effects = [];
    let setA, setB;
    mountApp(() => {
      const [a, sa] = useState(0);
      const [b, sb] = useState(0);
      setA = sa;
      setB = sb;
      return h('p', null, a + b);
    }, { onCommit: (c) => commits.push(c), onEffects: (e) => effects.push(e) });
    setA(1); setA(2); setB(5);
    await flushMicrotasks();
    const c = commits.at(-1);
    assert.equal(c.type, 'update');
    for (const k of ['render', 'diff', 'patch', 'layout']) assert.equal(typeof c.timings[k], 'number', k);
    assert.deepEqual(c.reasons.map((r) => r.index), [0, 0, 1], 'setState 3번 → 렌더 1번');
  });

  test('onEffects 는 useEffect 가 실제로 돈 뒤 호출', async () => {
    const effects = [];
    const { useEffect } = await import('../src/lib/component.js');
    mountApp(() => {
      useEffect(() => {}, []);
      return h('p');
    }, { onEffects: (e) => effects.push(e) });
    assert.equal(effects.length, 0);
    await flushMicrotasks();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].count, 1);
  });
});
