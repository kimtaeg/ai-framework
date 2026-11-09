// 설명 사전: 기록된 사건 하나를 "어느 파일 › 함수에서 일어난 일인지"와 쉬운 문장으로 바꾼다.
// 엔진(src/)에는 설명을 넣지 않고 여기서만 관리해, 엔진 코드가 학습용 문구로 지저분해지지 않게 한다.

const DESCRIPTIONS = {
  'render:start': {
    source: 'component.js › renderVNode',
    text: (e) =>
      e.kind === 'mount'
        ? '첫 렌더를 시작합니다. hookIndex를 0으로 두고 컴포넌트 함수를 실행해요.'
        : '다시 렌더를 시작합니다. hookIndex를 0으로 되돌려 0번 사물함부터 다시 열어요.',
  },
  'hook:state': {
    source: 'hooks.js › useState',
    text: (e) =>
      e.isFirst
        ? `${e.index}번 사물함이 비어 있어서 초기값 ${show(e.value)}을(를) 넣었습니다.`
        : `${e.index}번 사물함에서 저장된 값 ${show(e.value)}을(를) 꺼냈습니다. 초기값은 무시돼요.`,
  },
  'hook:memo': {
    source: 'hooks.js › useMemo',
    text: (e) =>
      e.recomputed
        ? `deps가 바뀌어 ${e.index}번 사물함의 값을 다시 계산했습니다 → ${show(e.value)}`
        : `deps가 그대로라 계산을 건너뛰고 ${e.index}번 사물함에 저장된 ${show(e.value)}을(를) 썼습니다.`,
  },
  'hook:effect': {
    source: 'hooks.js › useEffect',
    text: (e) =>
      e.queued
        ? `deps가 바뀌어 ${e.index}번 effect를 예약했습니다. 실행은 화면에 반영된 뒤예요.`
        : `deps가 그대로라 ${e.index}번 effect는 이번에 실행하지 않습니다.`,
  },
  'expand:component': {
    source: 'component.js › expand',
    text: (e) => `${e.name} 컴포넌트를 props와 함께 실행해 펼칩니다. 결과가 또 컴포넌트면 태그가 나올 때까지 계속 펼쳐요.`,
  },
  'state:set': {
    source: 'hooks.js › setState',
    text: (e) =>
      e.skipped
        ? '같은 값이라 아무것도 하지 않았습니다.'
        : `사물함 ${e.index}번 값을 ${show(e.prev)}에서 ${show(e.next)}로 바꿨습니다. 화면은 아직 그대로예요.`,
  },
  'update:schedule': {
    source: 'component.js › scheduleUpdate',
    text: (e) =>
      e.alreadyScheduled
        ? '이미 다시 그리기가 예약돼 있어서 새로 예약하지 않았습니다 (Batching).'
        : '지금 코드가 끝난 직후 다시 그리도록 예약했습니다 (queueMicrotask).',
  },
  'update:start': {
    source: 'component.js › update',
    text: () => '예약해 둔 다시 그리기를 시작합니다. 그 사이에 바뀐 값이 모두 사물함에 들어 있어요.',
  },
  'diff:done': {
    source: 'diff.js › diff',
    text: (e) => {
      const count = e.patches?.length ?? 0;
      return count === 0 ? '이전 VDOM과 비교했더니 바뀐 곳이 없습니다.' : `이전 VDOM과 비교해 바뀐 곳 ${count}개를 찾았습니다.`;
    },
  },
  'commit:done': {
    source: 'component.js › mount / update',
    text: (e) =>
      e.kind === 'mount'
        ? '만든 DOM을 화면에 붙였습니다. 이제 화면에 보여요.'
        : '바뀐 곳만 실제 DOM에 반영했습니다 (patch).',
  },
  'effect:cleanup': {
    source: 'component.js › runEffects',
    text: (e) => `${e.index}번 effect의 이전 cleanup을 먼저 실행합니다.`,
  },
  'effect:run': {
    source: 'component.js › runEffects',
    text: (e) => `화면 반영이 끝났으니 ${e.index}번 effect를 실행합니다.`,
  },
  unmount: {
    source: 'component.js › unmount',
    text: () => '컴포넌트를 화면에서 내립니다. 남아 있는 cleanup을 모두 실행해요.',
  },
  'scenario:h': {
    source: '예제',
    text: () => 'h()로 트리를 만들었습니다. 컴포넌트(ƒ)는 아직 실행하지 않고 상자에 적어 두기만 했어요.',
  },
  'scenario:vdom': {
    source: '예제',
    text: () => '펼치기가 끝났습니다. 함수는 하나도 남지 않고 태그만 있는 VDOM이 됐어요.',
  },
  'scenario:click': {
    source: '예제',
    text: (e) => `${e.label ?? '버튼'}을(를) 눌렀습니다. 이벤트 핸들러가 실행돼요.`,
  },
  error: {
    source: '에러',
    text: (e) => `엔진이 에러를 던졌습니다: ${e.message}`,
  },
};

export const TRACE_EVENT_TYPES = Object.keys(DESCRIPTIONS);

function show(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

export function describeStep(step) {
  const { event } = step;
  const description = DESCRIPTIONS[event.type];
  const mark = event.type === 'expand:component' ? `component:${event.name}` : event.type;
  if (!description) {
    return { source: '엔진', text: `엔진에서 ${event.type} 일이 일어났습니다.`, mark };
  }
  return { source: description.source, text: description.text(event), mark };
}
