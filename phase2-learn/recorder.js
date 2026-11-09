// 기록기: 엔진이 trace로 알리는 사건마다 "그 순간의 스냅샷"을 붙여 한 단계(step)로 쌓는다.
// 재생기는 이 steps만 보고 그림을 그리므로, 스냅샷은 참조가 아니라 그 순간의 값을 복사해 둔다.
// (나중 단계에서 상태가 바뀌어도 이전 단계의 그림이 따라 바뀌면 안 되기 때문)

import { OBSERVE_OPTIONS, summarizeMutations } from '../src/mutationStats.js';

const DEFAULT_LIMIT = 300;

// structuredClone은 함수를 복사하지 못하므로, 함수는 'ƒ 이름' 문자열로 바꿔 가며 깊게 복사한다
function copyValue(value, seen = new Map()) {
  if (typeof value === 'function') return `ƒ ${value.name || '익명'}`;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(copyValue(item, seen));
    return copy;
  }
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = copyValue(item, seen);
  return copy;
}

function snapshotHooks(component) {
  return component.hooks.map((slot) => ({
    kind: slot.hookName,
    value: copyValue(slot.value),
    deps: copyValue(slot.deps),
    hasCleanup: typeof slot.cleanup === 'function',
  }));
}

export function createRecorder({ container, limit = DEFAULT_LIMIT }) {
  const steps = [];
  let isTruncated = false;
  let isStopped = false;

  // 기록 대상 container의 DOM 변경을 모아 두었다가 DOM 반영 완료(commit:done) 단계에서 센다
  const observer = new MutationObserver(() => {});
  observer.observe(container, OBSERVE_OPTIONS);

  function push(event, component) {
    if (isStopped) return;
    if (steps.length >= limit) {
      isTruncated = true;
      return;
    }
    const mutations = event.type === 'commit:done' ? summarizeMutations(observer.takeRecords()) : null;
    steps.push({
      index: steps.length,
      event: copyValue(event),
      snapshot: {
        hooks: component ? snapshotHooks(component) : [],
        hookIndex: component ? component.hookIndex : null,
        isUpdateScheduled: component ? component.isUpdateScheduled : false,
        html: container.innerHTML,
        mutations,
      },
    });
  }

  // 시나리오가 직접 남기는 사건(클릭 등)에도 지금의 컴포넌트 상태를 찍을 수 있게 마지막 컴포넌트를 기억한다
  let lastComponent = null;

  return {
    steps,
    get isTruncated() {
      return isTruncated;
    },
    trace(event, component) {
      if (component) lastComponent = component;
      push(event, component ?? null);
    },
    note(event) {
      push(event, lastComponent);
    },
    // 실행이 끝나면 부른다. 관찰자를 끊지 않으면 같은 container를 다시 쓸 때마다 관찰자가 쌓여
    // 이후 모든 DOM 변경이 옛 기록기들에게도 전달되고, 그 steps도 메모리에 남는다.
    stop() {
      isStopped = true;
      observer.disconnect();
    },
    recordError(error) {
      // 한도가 찼어도 에러는 마지막에 꼭 보이도록 마지막 자리를 비운다 (그만큼 기록이 잘린 것)
      if (steps.length >= limit) {
        steps.length = limit - 1;
        isTruncated = true;
      }
      push({ type: 'error', message: error.message }, lastComponent);
    },
  };
}
