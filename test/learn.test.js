// Phase 2 개념 학습 페이지(phase2-learn/)의 기록기·설명 사전·시나리오
import { describe, it, expect } from 'vitest';
import { flush } from './helpers.js';
import { h } from '../src/vdom.js';
import { expand, FunctionComponent } from '../src/component.js';
import { useState, useEffect } from '../src/hooks.js';
import { createRecorder } from '../phase2-learn/recorder.js';

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
