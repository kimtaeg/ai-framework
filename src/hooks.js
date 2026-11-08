// Hooks
//
// 컴포넌트 함수는 렌더마다 새로 실행되므로 지역 변수로는 상태를 기억할 수 없다.
// 그래서 상태는 함수 밖, 컴포넌트 인스턴스의 hooks 배열(사물함)에 두고
// "몇 번째로 호출된 Hook인지"(hookIndex)로 자기 칸을 찾는다.
//
// useState가 어느 컴포넌트의 사물함을 열지 알 수 있도록, 렌더 중인 컴포넌트와 단계를 모듈 변수에 둔다.
// FunctionComponent가 렌더할 때만 runRender로 잠깐 켰다가 끈다.

const ROOT_PHASE = 'root'; // 루트 컴포넌트 함수 실행 중 → Hook 허용
const CHILDREN_PHASE = 'children'; // expand로 자식 컴포넌트를 펼치는 중 → Hook 금지

let currentComponent = null;
let renderPhase = null;

// FunctionComponent 전용: 루트 함수 실행 → 자식 펼치기 순서로 단계를 표시한다.
// 렌더 중 에러가 나도 단계가 남아 있지 않도록 finally에서 끈다.
export function runRender(component, callRoot, expandTree) {
  currentComponent = component;
  try {
    renderPhase = ROOT_PHASE;
    const tree = callRoot();
    renderPhase = CHILDREN_PHASE;
    return expandTree(tree);
  } finally {
    currentComponent = null;
    renderPhase = null;
  }
}

function getRenderingComponent(hookName) {
  if (renderPhase === CHILDREN_PHASE) {
    throw new Error(
      `${hookName}는 루트 컴포넌트에서만 쓸 수 있습니다. 자식 컴포넌트는 상태를 props로 받으세요. (Lifting State Up)`
    );
  }
  if (renderPhase !== ROOT_PHASE) {
    throw new Error(
      `${hookName}는 컴포넌트가 렌더되는 중에만 호출할 수 있습니다. ` +
        '이벤트 핸들러·setTimeout 안이나 컴포넌트 밖에서는 부를 수 없습니다.'
    );
  }
  return currentComponent;
}

export function useState(initialValue) {
  const component = getRenderingComponent('useState');
  const index = component.hookIndex++;

  // 첫 렌더: 사물함이 비어 있으므로 초기값과 setState를 만들어 넣는다.
  // 다음 렌더부터는 같은 번호의 사물함을 그대로 꺼내므로 초기값은 무시된다.
  if (index === component.hooks.length) {
    const hook = { value: initialValue };

    // setState는 클로저로 "자기 사물함(hook)"과 "자기 컴포넌트"를 기억한다.
    // 그래서 렌더가 끝난 뒤 이벤트 핸들러에서 불려도 어디에 값을 넣고 누구를 다시 그릴지 안다.
    // 첫 렌더에 한 번만 만들어 두므로 렌더마다 같은 함수다 (props로 넘겨도 PROPS patch가 생기지 않는다).
    hook.setState = (action) => {
      if (renderPhase !== null) {
        throw new Error('렌더 중에 setState를 호출하면 무한히 다시 렌더됩니다. 이벤트 핸들러에서 호출하세요.');
      }
      // prev => next 형태면 사물함의 최신 값을 넘긴다 (연속 호출해도 앞의 변경이 반영된다)
      const nextValue = typeof action === 'function' ? action(hook.value) : action;
      if (Object.is(nextValue, hook.value)) return; // 같은 값이면 다시 그리지 않는다
      hook.value = nextValue;
      component.scheduleUpdate();
    };

    component.hooks.push(hook);
  }

  const hook = component.hooks[index];
  return [hook.value, hook.setState];
}

// deps가 없으면 매번 "바뀜". 길이가 다르거나 원소 하나라도 다르면(Object.is, 얕은 비교) "바뀜".
// [] 는 비교할 원소가 없어 두 번째 렌더부터 항상 "같음" → 처음 한 번만 실행된다.
function haveDepsChanged(prevDeps, nextDeps) {
  if (prevDeps === undefined || nextDeps === undefined) return true;
  if (prevDeps.length !== nextDeps.length) return true;
  return nextDeps.some((dep, i) => !Object.is(dep, prevDeps[i]));
}

// 렌더 중에는 "실행할지"만 판단해 예약하고, 실제 실행은 FunctionComponent가 patch를 끝낸 뒤에 한다.
// 렌더 함수는 순수해야 하고 몇 번 실행될지 모르므로, 바깥세상(DOM 측정, 타이머, 요청)과 닿는 일은 여기로 뺀다.
export function useEffect(effect, deps) {
  const component = getRenderingComponent('useEffect');
  const index = component.hookIndex++;

  if (index === component.hooks.length) {
    component.hooks.push({ deps: undefined, cleanup: undefined });
  }
  const hook = component.hooks[index];

  // deps는 실제로 실행할 때 저장한다 (렌더가 중간에 실패하면 실행되지 않은 deps가 남지 않도록)
  if (haveDepsChanged(hook.deps, deps)) {
    component.pendingEffects.push({ hook, effect, deps });
  }
}
