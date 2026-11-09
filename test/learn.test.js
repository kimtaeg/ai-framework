// Phase 2 개념 학습 페이지(phase2-learn/)의 기록기·설명 사전·시나리오
import { describe, it, expect } from 'vitest';
import { flush } from './helpers.js';
import { h } from '../src/vdom.js';
import { expand, FunctionComponent } from '../src/component.js';
import { useState, useEffect } from '../src/hooks.js';
import { createRecorder } from '../phase2-learn/recorder.js';
import { TRACE_EVENT_TYPES, describeStep } from '../phase2-learn/explain.js';
import { SCENARIOS, runScenario } from '../phase2-learn/scenarios.js';

function mountRecorded(fn, recorderOptions = {}) {
  const container = document.createElement('div');
  const recorder = createRecorder({ container, ...recorderOptions });
  const component = new FunctionComponent(fn, container, { trace: recorder.trace }).mount();
  return { container, recorder, component };
}

describe('recorder', () => {
  it('사건마다 step을 쌓고 index를 붙인다', () => {
    const { recorder } = mountRecorded(() => h('p', null, String(useState(0)[0])));
    expect(recorder.steps.map((s) => s.event.type)).toEqual(['render:start', 'hook:state', 'commit:done']);
    expect(recorder.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(recorder.steps[1].snapshot).toMatchObject({
      hooks: [{ kind: 'useState', value: 0, hasCleanup: false }],
      hookIndex: 1,
      isUpdateScheduled: false,
    });
  });

  it('스냅샷은 그 순간의 값을 복사한다', async () => {
    let setList;
    const { recorder, component } = mountRecorded(() => {
      const [list, set] = useState(['a']);
      setList = set;
      return h('p', null, list.join(','));
    });
    const firstValue = recorder.steps.at(-1).snapshot.hooks[0].value;

    component.hooks[0].value.push('몰래 바꿈'); // 같은 배열을 직접 바꿔도
    setList((list) => [...list, 'b']);
    await flush();

    expect(firstValue).toEqual(['a']); // 이전 단계의 그림은 그대로
    expect(recorder.steps.at(-1).snapshot.hooks[0].value).toEqual(['a', '몰래 바꿈', 'b']);
  });

  it('함수 값은 ƒ 이름 문자열로 바꿔 복사한다', () => {
    const { recorder } = mountRecorded(() => {
      useState(() => function handleSave() {}); // 지연 초기화 결과가 함수
      return h('p');
    });
    expect(recorder.steps.at(-1).snapshot.hooks[0].value).toBe('ƒ handleSave');
  });

  it('commit:done 단계에만 mutations가 있다', async () => {
    let setN;
    const { recorder } = mountRecorded(() => {
      const [n, set] = useState(0);
      setN = set;
      return h('p', null, String(n));
    });
    setN(1);
    await flush();

    const commits = recorder.steps.filter((s) => s.event.type === 'commit:done');
    expect(commits).toHaveLength(2);
    expect(commits[1].snapshot.mutations).toMatchObject({ text: 1, total: 1 });
    expect(recorder.steps.filter((s) => s.event.type !== 'commit:done').every((s) => s.snapshot.mutations === null)).toBe(true);
    expect(commits[1].snapshot.html).toBe('<p>1</p>');
  });

  it('recordError는 마지막에 error 단계를 남긴다', () => {
    const { recorder } = mountRecorded(() => h('p'));
    recorder.recordError(new Error('일부러 낸 에러'));
    expect(recorder.steps.at(-1).event).toEqual({ type: 'error', message: '일부러 낸 에러' });
  });

  it('note는 시나리오 사건을 그대로 남긴다', () => {
    const container = document.createElement('div');
    const recorder = createRecorder({ container });
    recorder.note({ type: 'scenario:click', label: '버튼 클릭' });
    expect(recorder.steps[0].event).toEqual({ type: 'scenario:click', label: '버튼 클릭' });
  });

  it('limit을 넘으면 더 쌓지 않고 isTruncated가 true', () => {
    const container = document.createElement('div');
    const recorder = createRecorder({ container, limit: 5 });
    for (let i = 0; i < 10; i++) recorder.note({ type: 'scenario:click' });
    expect(recorder.steps).toHaveLength(5);
    expect(recorder.isTruncated).toBe(true);
  });

  it('한도가 찼어도 recordError는 마지막 자리에 에러를 남기고 isTruncated는 true', () => {
    const container = document.createElement('div');
    const recorder = createRecorder({ container, limit: 3 });
    for (let i = 0; i < 3; i++) recorder.note({ type: 'scenario:click' });
    recorder.recordError(new Error('끝'));
    expect(recorder.steps).toHaveLength(3);
    expect(recorder.steps.at(-1).event).toEqual({ type: 'error', message: '끝' });
    expect(recorder.isTruncated).toBe(true);
  });

  it('component가 null이어도(1장 expand) 스냅샷을 만든다', () => {
    const container = document.createElement('div');
    const recorder = createRecorder({ container });
    const Item = () => h('li');
    expand(h('ul', null, h(Item)), { onComponent: recorder.trace });
    expect(recorder.steps[0].event.type).toBe('expand:component');
    expect(recorder.steps[0].snapshot).toEqual({ hooks: [], hookIndex: null, isUpdateScheduled: false, html: '', mutations: null });
  });

  it('effect 사물함은 deps와 cleanup 여부를 보여 준다 (effect:run은 실행 직전이라 cleanup은 다음 단계부터)', () => {
    const { recorder } = mountRecorded(() => {
      useEffect(() => () => {}, [1, 'a']);
      return h('p');
    });
    expect(recorder.steps.at(-1).event.type).toBe('effect:run');
    expect(recorder.steps.at(-1).snapshot.hooks[0].hasCleanup).toBe(false);

    recorder.note({ type: 'scenario:click' }); // 다음 단계
    expect(recorder.steps.at(-1).snapshot.hooks[0]).toEqual({ kind: 'useEffect', value: undefined, deps: [1, 'a'], hasCleanup: true });
  });
});

describe('explain', () => {
  // 사건 종류마다 실제로 올 법한 필드를 채운 예
  const SAMPLE_EVENTS = {
    'render:start': { kind: 'update' },
    'hook:state': { index: 0, isFirst: false, value: 3 },
    'hook:memo': { index: 2, recomputed: false, value: 6 },
    'hook:effect': { index: 1, queued: true },
    'expand:component': { name: 'Card', props: { title: '할 일', children: [] } },
    'state:set': { index: 0, prev: 0, next: 1, skipped: false },
    'update:schedule': { alreadyScheduled: false },
    'update:start': {},
    'diff:done': { patches: [{ type: 'TEXT', path: [0], from: '0', to: '1' }] },
    'commit:done': { kind: 'update' },
    'effect:cleanup': { index: 1 },
    'effect:run': { index: 1 },
    unmount: {},
    'scenario:h': { tree: { type: 'ƒ Card', props: {}, children: [] } },
    'scenario:vdom': { vdom: { type: 'section', props: {}, children: [] } },
    'scenario:click': { label: '버튼 클릭' },
    error: { message: '일부러 낸 에러' },
  };
  const step = (type, fields = SAMPLE_EVENTS[type]) => ({ index: 0, event: { type, ...fields }, snapshot: {} });

  it('사건 종류 목록은 스펙의 13종 + 시나리오 3종 + error', () => {
    expect(new Set(TRACE_EVENT_TYPES)).toEqual(new Set(Object.keys(SAMPLE_EVENTS)));
  });

  it.each(Object.keys(SAMPLE_EVENTS))('%s: 출처와 설명이 비어 있지 않다', (type) => {
    const { source, text, mark } = describeStep(step(type));
    expect(source.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(mark.length).toBeGreaterThan(0);
  });

  it('엔진 사건의 출처는 "파일 › 함수", 시나리오는 "예제", 에러는 "에러"', () => {
    expect(describeStep(step('state:set')).source).toBe('hooks.js › setState');
    expect(describeStep(step('hook:state')).source).toBe('hooks.js › useState');
    expect(describeStep(step('diff:done')).source).toBe('diff.js › diff');
    expect(describeStep(step('scenario:click')).source).toBe('예제');
    expect(describeStep(step('error')).source).toBe('에러');
  });

  it('state:set은 skipped에 따라 문장이 다르다', () => {
    expect(describeStep(step('state:set')).text).toBe('사물함 0번 값을 0에서 1로 바꿨습니다. 화면은 아직 그대로예요.');
    expect(describeStep(step('state:set', { index: 0, prev: 1, next: 1, skipped: true })).text).toBe(
      '같은 값이라 아무것도 하지 않았습니다.'
    );
  });

  it('error 단계 설명에는 엔진 메시지가 그대로 들어간다', () => {
    expect(describeStep(step('error')).text).toContain('일부러 낸 에러');
  });

  it('expand:component의 mark는 component:이름, 나머지는 사건 type', () => {
    expect(describeStep(step('expand:component')).mark).toBe('component:Card');
    expect(describeStep(step('state:set')).mark).toBe('state:set');
  });

  it('모르는 사건은 기본 설명으로', () => {
    const result = describeStep({ index: 0, event: { type: 'xxx' }, snapshot: {} });
    expect(result.source).toBe('엔진');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.mark).toBe('xxx');
  });
});

describe('scenarios', () => {
  const run = (id, options = {}) => runScenario(id, options, document.createElement('div'));
  const typesOf = (steps) => steps.map((s) => s.event.type);
  const count = (steps, type) => steps.filter((s) => s.event.type === type).length;
  const lastHtml = (steps) => steps.at(-1).snapshot.html;

  it('4개 장이 정해진 순서와 모양으로 있다', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['expand', 'hooks', 'setstate', 'effects']);
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.code.length).toBeGreaterThan(0);
      expect(s.panels.length).toBeGreaterThan(0);
      expect(Array.isArray(s.controls)).toBe(true);
    }
  });

  it.each(['expand', 'hooks', 'setstate', 'effects'])('%s: 기본값으로 실행하면 steps가 생기고 에러가 없다', async (id) => {
    const { steps, error, isTruncated } = await run(id);
    expect(steps.length).toBeGreaterThan(3);
    expect(error).toBeNull();
    expect(isTruncated).toBe(false);
    expect(steps.some((s) => s.event.type === 'error')).toBe(false);
  });

  it('code의 mark는 실제로 나오는 사건과 맞는다 (강조할 줄이 하나 이상 있다)', async () => {
    for (const s of SCENARIOS) {
      const { steps } = await run(s.id);
      const marks = new Set(steps.map((step) => describeStep(step).mark));
      expect(s.code.some((line) => marks.has(line.mark))).toBe(true);
    }
  });

  it('expand: skipExpand면 마지막이 error, 메시지에 "expand()로 먼저 펼친 뒤"', async () => {
    const { steps, error } = await run('expand', { skipExpand: true });
    expect(steps.at(-1).event.type).toBe('error');
    expect(steps.at(-1).event.message).toContain('expand()로 먼저 펼친 뒤');
    expect(error).not.toBeNull();
  });

  it('expand: itemCount 3이면 expand:component가 Card 1 + Item 3', async () => {
    const { steps } = await run('expand', { itemCount: 3 });
    expect(steps.filter((s) => s.event.type === 'expand:component').map((s) => s.event.name)).toEqual(['Card', 'Item', 'Item', 'Item']);
    expect(lastHtml(steps)).toContain('장보기');
  });

  it('expand: scenario:h의 tree에는 ƒ Card가, scenario:vdom의 vdom에는 태그만 있다', async () => {
    const { steps } = await run('expand');
    const tree = steps.find((s) => s.event.type === 'scenario:h').event.tree;
    const vdom = steps.find((s) => s.event.type === 'scenario:vdom').event.vdom;
    expect(tree.type).toBe('ƒ Card');
    expect(tree.children[0].type).toBe('ƒ Item');
    const types = [];
    const walk = (node) => {
      if (typeof node === 'string') return;
      types.push(node.type);
      node.children.forEach(walk);
    };
    walk(vdom);
    expect(types.every((t) => !t.startsWith('ƒ'))).toBe(true);
    expect(types[0]).toBe('section');
  });

  it('hooks: 두 번째 렌더에서는 저장된 값을 꺼낸다 (isFirst false)', async () => {
    const { steps } = await run('hooks');
    const states = steps.filter((s) => s.event.type === 'hook:state').map((s) => s.event.isFirst);
    expect(states).toEqual([true, true, false, false]);
  });

  it('hooks: conditionalHook이면 마지막이 error, 메시지에 "이전 렌더에는 없었습니다"', async () => {
    const { steps, error } = await run('hooks', { conditionalHook: true });
    expect(steps.at(-1).event.type).toBe('error');
    expect(steps.at(-1).event.message).toContain('이전 렌더에는 없었습니다');
    expect(error).not.toBeNull();
  });

  it('setstate: 3번 + batching 켬 → update:start 1번, 화면 "클릭 3"', async () => {
    const { steps } = await run('setstate', { setStateCount: 3, batching: true });
    expect(count(steps, 'state:set')).toBe(3);
    expect(count(steps, 'update:start')).toBe(1);
    expect(lastHtml(steps)).toContain('클릭 3');
    expect(typesOf(steps)).toContain('scenario:click');
  });

  it('setstate: batching 끔 → update:start 3번', async () => {
    const { steps } = await run('setstate', { setStateCount: 3, batching: false });
    expect(count(steps, 'update:start')).toBe(3);
    expect(lastHtml(steps)).toContain('클릭 3');
  });

  it('setstate: value 방식 3번 → 화면 "클릭 1"', async () => {
    const { steps } = await run('setstate', { setStateCount: 3, updateStyle: 'value' });
    expect(lastHtml(steps)).toContain('클릭 1');
    expect(steps.filter((s) => s.event.type === 'state:set').map((s) => s.event.skipped)).toEqual([false, true, true]);
  });

  it('effects: deps [count]에서 text만 바꾸면 effect:run 없음, hook:memo recomputed false', async () => {
    const { steps } = await run('effects', { deps: 'count', change: 'text' });
    const afterClick = steps.slice(steps.findIndex((s) => s.event.type === 'scenario:click'));
    expect(count(afterClick, 'effect:run')).toBe(0);
    expect(afterClick.find((s) => s.event.type === 'hook:memo').event.recomputed).toBe(false);
  });

  it('effects: count를 바꾸면 cleanup → run, memo 다시 계산', async () => {
    const { steps } = await run('effects', { deps: 'count', change: 'count' });
    const afterClick = typesOf(steps.slice(steps.findIndex((s) => s.event.type === 'scenario:click')));
    expect(afterClick.slice(-2)).toEqual(['effect:cleanup', 'effect:run']);
    expect(steps.filter((s) => s.event.type === 'hook:memo').map((s) => s.event.recomputed)).toEqual([true, true]);
  });

  it('effects: deps 없음이면 text만 바꿔도 effect가 다시 돈다, []이면 안 돈다', async () => {
    const none = await run('effects', { deps: 'none', change: 'text' });
    const empty = await run('effects', { deps: 'empty', change: 'text' });
    expect(count(none.steps, 'effect:run')).toBe(2);
    expect(count(empty.steps, 'effect:run')).toBe(1);
  });

  it('effects: unmount 켜면 마지막 쪽에 unmount → effect:cleanup', async () => {
    const { steps } = await run('effects', { unmount: true });
    expect(typesOf(steps).slice(-2)).toEqual(['unmount', 'effect:cleanup']);
  });

  it('실행이 끝나면 정리용 unmount는 기록에 남기지 않는다', async () => {
    const { steps } = await run('effects');
    expect(count(steps, 'unmount')).toBe(0);
  });

  it('다시 실행해도 이전 실행이 섞이지 않는다', async () => {
    const container = document.createElement('div');
    const first = await runScenario('setstate', {}, container);
    const second = await runScenario('setstate', {}, container);
    expect(second.steps[0].event).toEqual({ type: 'render:start', kind: 'mount' });
    expect(second.steps.map((s) => s.index)[0]).toBe(0);
    expect(count(second.steps, 'update:start')).toBe(count(first.steps, 'update:start'));
    expect(second.steps.length).toBe(first.steps.length);
  });
});
