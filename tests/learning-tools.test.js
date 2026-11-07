/**
 * 학습 도구 기능 테스트: Phase 1 단계별 Patch · 트리 비교 표시, 샌드박스 틀, 새 예제, Inspector 표시 함수
 */
import './setup.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Playground } from '../phase1/playground.js';
import { PRESETS } from '../phase1/presets.js';
import { computeMarks, markOfNew, markOfOld, renderTree } from '../phase1/vtree.js';
import { h, createElement } from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';
import * as lib from '../src/lib/component.js';
import { TEMPLATES, SNIPPETS } from '../sandbox/templates.js';
import { EffectTimingApp, ContextApp } from '../examples/apps.js';
import { describeHook, preview } from '../tools/inspector.js';
import { container, flushMicrotasks } from './setup.js';

const { FunctionComponent } = lib;

// ================================================================ 단계별 Patch
describe('Phase 1 단계별 Patch', () => {
  const page = readFileSync(new URL('../phase1/index.html', import.meta.url), 'utf8');
  const sample = page.match(/<div id="actual" class="sample">([\s\S]*?)<\/div>\s*<div id="overlay"/)[1];
  let actual, pg, commits;
  beforeEach(() => {
    actual = container(sample);
    commits = [];
    pg = new Playground({ actualRoot: actual, renderTestArea: () => {}, onCommit: (r) => commits.push(r) });
    pg.init();
  });
  const combo = () => PRESETS.find((p) => p.id === 'combo').apply(pg.current);

  test('하나씩 적용한 최종 결과 == 한 번에 적용한 결과', () => {
    const next = combo();
    const expected = document.createElement('div');
    expected.append(...next.children.map((c) => createElement(c)));
    const s = pg.beginSteps(next, '단계');
    assert.ok(s.patches.length >= 4);
    assert.equal(actual.innerHTML === expected.innerHTML, false, '시작 전에는 아직 그대로');
    const r1 = pg.stepNext();
    assert.equal(r1.index, 1);
    assert.equal(r1.done, false);
    pg.finishSteps();
    assert.equal(actual.innerHTML, expected.innerHTML);
    assert.equal(pg.history.entries.length, 2, '완료하면 히스토리에 기록');
    assert.equal(commits.at(-1).patches.length, s.patches.length);
    assert.equal(pg.inSteps, false);
  });

  test('중간에 취소하면 시작 전 상태로 복원, 히스토리 기록 없음', () => {
    const before = actual.innerHTML;
    pg.beginSteps(combo());
    pg.stepNext();
    pg.stepNext();
    assert.notEqual(actual.innerHTML, before);
    pg.cancelSteps();
    assert.equal(actual.innerHTML, before);
    assert.equal(pg.history.entries.length, 1);
  });

  test('한 단계마다 DOM 변경이 기록된다', () => {
    pg.beginSteps(combo());
    let total = 0;
    for (let r = pg.stepNext(); r; r = pg.stepNext()) total += r.mutations;
    assert.ok(total >= 4);
  });
});

// ================================================================ 트리 비교 표시
describe('트리 비교 표시 (computeMarks)', () => {
  test('추가/삭제/텍스트/속성/이동을 올바른 노드에 표시', () => {
    const li = (k, t) => h('li', { key: k }, t);
    const oldV = h('div', null, h('p', { class: 'a' }, 'x'), h('ul', null, li('a', 'A'), li('b', 'B'), li('c', 'C')), h('i', null, 'gone'));
    const newV = h('div', null, h('p', { class: 'b' }, 'y'), h('ul', null, li('c', 'C'), li('a', 'A'), li('b', 'B'), li('d', 'D')));
    const marks = computeMarks(diff(oldV, newV));
    assert.equal(markOfNew(newV.children[0], [0], marks), 'PROPS');
    assert.equal(markOfNew(newV.children[0].children[0], [0, 0], marks), 'TEXT');
    assert.equal(markOfNew(newV.children[1].children[0], [1, 0], marks), 'MOVE');
    assert.equal(markOfNew(newV.children[1].children[3], [1, 3], marks), 'INSERT');
    assert.equal(markOfNew(newV.children[1].children[1], [1, 1], marks), null, '움직이지 않은 노드');
    assert.equal(markOfOld(oldV.children[2], marks), 'REMOVE');
  });

  test('renderTree 는 표시된 노드에 태그를 붙인다', () => {
    const oldV = h('div', null, h('p', null, 'a'));
    const newV = h('div', null, h('p', null, 'b'));
    const marks = computeMarks(diff(oldV, newV));
    const ul = renderTree(newV, (v, path) => markOfNew(v, path, marks));
    assert.equal(ul.querySelectorAll('.vt-tag.TEXT').length, 1);
  });
});

// ================================================================ 샌드박스 틀
describe('샌드박스 틀', () => {
  const API = { h, ...Object.fromEntries(['useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'createContext', 'useContext'].map((k) => [k, lib[k]])) };
  const compile = (code) => new Function(...Object.keys(API), 'console', `"use strict";\n${code}\n;return typeof App === 'function' ? App : undefined;`)(...Object.values(API), console);

  for (const t of TEMPLATES) {
    test(`"${t.name}" 틀이 에러 없이 실행되고, 버튼을 눌러도 동작한다`, async () => {
      const App = compile(t.code);
      assert.equal(typeof App, 'function');
      const errors = [];
      const el = container();
      const comp = new FunctionComponent(App, {}, { onError: (e) => errors.push(e) }).mount(el);
      assert.ok(el.textContent.length > 0);
      for (const b of el.querySelectorAll('button')) {
        b.click();
        await flushMicrotasks();
      }
      comp.unmount(); // 타이머 틀의 setInterval 같은 것을 cleanup 으로 정리
      assert.deepEqual(errors, []);
    });
  }

  test('모든 틀에 설명과 "해볼 것" 이 있다', () => {
    for (const t of TEMPLATES) {
      assert.ok(t.desc && t.try.length > 0, t.id);
    }
  });

  test('조각 코드들은 문법이 올바르다', () => {
    for (const s of SNIPPETS) {
      // 화면 조각은 끝이 "," 인 표현식이므로 배열 안에 넣어 검사
      const wrapped = s.group === '화면' ? `[${s.code}]` : s.code;
      assert.doesNotThrow(() => new Function('h', 'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useRef', 'useReducer', 'createContext', wrapped), s.label);
    }
  });
});

// ================================================================ 새 예제
describe('예제: Effect 타이밍 / Context', () => {
  test('Context 예제: 테마와 이름이 Drilling 쪽과 Context 쪽에 똑같이 반영', async () => {
    const el = container();
    new FunctionComponent(ContextApp).mount(el);
    const greets = () => [...el.querySelectorAll('.greet')].map((g) => g.className + '|' + g.textContent);
    assert.equal(new Set(greets()).size, 1);
    el.querySelector('.ctx-theme').click();
    await flushMicrotasks();
    const input = el.querySelector('input');
    input.value = '박정글';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flushMicrotasks();
    const g = greets();
    assert.equal(new Set(g).size, 1, '두 방식의 결과가 같음');
    assert.ok(g[0].startsWith('greet dark|') && g[0].includes('박정글'));
    assert.equal(el.querySelectorAll('.relay-tag.drill').length, 3);
    assert.equal(el.querySelectorAll('.relay-tag.ctx').length, 3);
  });

  test('Effect 타이밍 예제: useLayoutEffect 로 잡으면 그리기 전에 이미 제자리', async () => {
    const el = container();
    const comp = new FunctionComponent(EffectTimingApp).mount(el);
    el.querySelector('input[type=checkbox]').click(); // 300ms 대기 끄기
    await flushMicrotasks();
    el.querySelectorAll('input[type=radio]')[1].click(); // useLayoutEffect 로
    await flushMicrotasks();
    el.querySelector('#et-btn').click();
    // 업데이트(microtask) → layout effect 에서 위치 setState → 다시 microtask 로 렌더: 모두 화면 그리기(macrotask) 전
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(el.querySelector('.et-tip.placed'), 'macrotask 전에 이미 placed');
    comp.unmount();
  });

  test('Effect 타이밍 예제: useEffect 로 잡으면 잠깐 잘못된 자리(unplaced) 상태가 된다', async () => {
    const el = container();
    new FunctionComponent(EffectTimingApp).mount(el);
    el.querySelector('input[type=checkbox]').click();
    await flushMicrotasks();
    el.querySelector('#et-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(el.querySelector('.et-tip.unplaced'), '화면을 그리는 시점에는 아직 잘못된 자리');
    await flushMicrotasks();
    assert.ok(el.querySelector('.et-tip.placed'));
  });
});

// ================================================================ Inspector 표시
describe('Inspector 표시 함수', () => {
  test('preview: 긴 배열/객체/VNode 를 짧게', () => {
    assert.equal(preview([1, 2, 3, 4, 5]), '[1, 2, 3, … 총 5개]');
    assert.equal(preview({ a: 1, b: 'x' }), '{ a: 1, b: "x" }');
    assert.equal(preview(h('ul')), '<ul> VNode');
    assert.equal(preview(() => {}), 'ƒ');
  });

  test('describeHook: 종류별 요약', () => {
    assert.deepEqual(describeHook({ kind: 'useState', value: 3 }), { value: '3' });
    assert.equal(describeHook({ kind: 'useEffect', deps: undefined, cleanup: null, ran: true }).deps, '없음 (매 렌더)');
    assert.equal(describeHook({ kind: 'useRef', value: { current: 0 } }).value, '{ current: 0 }');
  });
});
