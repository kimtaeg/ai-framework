// Hooks: useState · useEffect · useMemo
//
// ■ "함수는 매번 새로 실행되는데 상태는 어떻게 유지되는가?"
//   App()은 렌더할 때마다 처음부터 다시 실행되므로, 함수 안의 지역 변수는 매번 새로 태어났다 사라진다.
//   그래서 상태는 함수 "밖", FunctionComponent 인스턴스의 hooks 배열(사물함)에 둔다.
//
//     hooks = [ {useState: 3}, {useMemo: …}, {useEffect: …} ]     ← 인스턴스에 있으므로 렌더가 끝나도 남는다
//               ↑ 0번          ↑ 1번         ↑ 2번
//
//   사물함에는 이름표가 없고 "몇 번째로 호출된 Hook인지"(hookIndex)가 곧 번호다.
//   렌더를 시작할 때 hookIndex를 0으로 되돌리면, 같은 순서로 불린 Hook이 같은 사물함을 다시 연다.
//   → 그래서 Hook은 if·for 안에서 부르면 안 된다 (순서가 바뀌면 남의 사물함을 연다). 어기면 에러로 알린다.
//
//   setState는 첫 렌더에 한 번 만들어 사물함에 넣어 둔다. 이 함수는 클로저로 "자기 사물함"과 "자기 컴포넌트"를
//   기억하므로, 렌더가 끝난 뒤 클릭 핸들러에서 불려도 어디에 값을 넣고 누구를 다시 그릴지 안다.
//
// ■ Hook은 루트 컴포넌트(App)에서만
//   사물함은 FunctionComponent(=App) 하나에만 있다. 자식 컴포넌트는 props만 받는 순수 함수로 두고(Lifting State Up),
//   자식이 Hook을 부르면 명확한 에러를 던진다.

const ROOT_PHASE = 'root'; // App 함수를 실행하는 중 → Hook 허용
const CHILDREN_PHASE = 'children'; // 자식 컴포넌트를 펼치는 중 → Hook 금지

let currentComponent = null;
let renderPhase = null;

export const HOOK_ORDER_RULE = 'Hook은 if·for 안이 아니라 App 맨 위에서 항상 같은 순서로 호출하세요.';

// FunctionComponent 전용: App 실행(root) → 자식 펼치기(children) 순서로 단계를 표시한다.
// 렌더 중 에러가 나도 단계가 남지 않도록 finally에서 끈다.
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
    throw new Error(`${hookName}는 루트 컴포넌트(App)에서만 쓸 수 있습니다. 자식 컴포넌트는 상태를 props로 받으세요. (Lifting State Up)`);
  }
  if (renderPhase !== ROOT_PHASE) {
    throw new Error(`${hookName}는 컴포넌트가 렌더되는 중에만 호출할 수 있습니다. 이벤트 핸들러·setTimeout 안이나 컴포넌트 밖에서는 부를 수 없습니다.`);
  }
  return currentComponent;
}

// 이번 Hook 호출이 열 사물함을 꺼낸다. 처음이면 만들고, 이후 렌더면 종류·개수가 같은지 확인한다.
function takeHookSlot(component, hookName, createSlot) {
  const index = component.hookIndex++;
  if (index === component.hooks.length) {
    if (component.expectedHookCount !== null) {
      throw new Error(`${index + 1}번째 Hook(${hookName})이 이전 렌더에는 없었습니다. ${HOOK_ORDER_RULE}`);
    }
    const slot = { hookName, mountGeneration: component.mountGeneration, ...createSlot() };
    component.hooks.push(slot);
    return slot;
  }
  const slot = component.hooks[index];
  if (slot.hookName !== hookName) {
    throw new Error(`${index + 1}번째 Hook이 이전 렌더에서는 ${slot.hookName}였는데 이번에는 ${hookName}입니다. ${HOOK_ORDER_RULE}`);
  }
  return slot;
}

export function useState(initialValue) {
  const component = getRenderingComponent('useState');
  // 첫 렌더만 초기값을 쓴다. useState(() => 계산)이면 그 함수를 첫 렌더에 한 번만 실행한다 (지연 초기화)
  const slot = takeHookSlot(component, 'useState', () => ({
    value: typeof initialValue === 'function' ? initialValue() : initialValue,
  }));

  if (!slot.setState) {
    // 클로저: 이 함수는 만들어질 때의 slot과 component를 계속 기억한다
    slot.setState = (action) => {
      // unmount 전에 받아 둔 옛 setState는 새로 mount된 트리를 건드리지 않는다
      if (slot.mountGeneration !== component.mountGeneration) return;
      if (renderPhase !== null) {
        throw new Error('렌더 중에 setState를 호출하면 무한히 다시 렌더됩니다. 이벤트 핸들러나 useEffect 안에서 호출하세요.');
      }
      // setState(prev => next): 사물함의 "최신 값"을 넘긴다 → 연속으로 불러도 앞의 변경이 반영된다
      const nextValue = typeof action === 'function' ? action(slot.value) : action;
      if (Object.is(nextValue, slot.value)) return; // 같은 값이면 다시 그리지 않는다
      slot.value = nextValue;
      // setState가 하는 또 하나의 일: "다시 그려 달라"고 예약한다 (배칭은 scheduler가 맡는다)
      component.requestUpdate();
    };
  }
  return [slot.value, slot.setState];
}

// deps 없음 → 매번 "바뀜" / 길이가 다르거나 원소 하나라도 다르면(Object.is, 얕은 비교) "바뀜"
// [] 는 비교할 원소가 없어 두 번째 렌더부터 항상 "같음" → 처음 한 번만
function haveDepsChanged(prevDeps, nextDeps) {
  if (prevDeps === undefined || nextDeps === undefined) return true;
  if (prevDeps.length !== nextDeps.length) return true;
  return nextDeps.some((dep, i) => !Object.is(dep, prevDeps[i]));
}

// 렌더 중에는 실행할지만 판단해 예약하고, 실제 실행은 patch로 화면이 바뀐 "뒤"에 한다.
// 렌더 함수는 순수해야 하고 몇 번 실행될지 모르므로, 바깥세상 일(타이머, document.title, body 클래스)은 여기로 뺀다.
export function useEffect(effect, deps) {
  const component = getRenderingComponent('useEffect');
  const slot = takeHookSlot(component, 'useEffect', () => ({ deps: undefined, cleanup: undefined }));
  if (haveDepsChanged(slot.deps, deps)) component.pendingEffects.push({ slot, effect, deps });
}

// 렌더 도중 바로 계산해 값을 돌려준다. deps가 같으면 다시 계산하지 않고 저장된 값을 쓴다 (동작은 같고 일만 줄인다)
export function useMemo(compute, deps) {
  const component = getRenderingComponent('useMemo');
  const slot = takeHookSlot(component, 'useMemo', () => ({ value: undefined, deps: undefined }));
  if (haveDepsChanged(slot.deps, deps)) {
    const value = compute(); // 에러가 나면 아래 대입이 안 일어나 다음 렌더에 다시 계산한다
    slot.value = value;
    slot.deps = deps;
  }
  return slot.value;
}
