// setState 배칭: 같은 이벤트·같은 틱 안의 여러 setState를 모아 update()를 한 번만 실행한다.
//
// 원리
//   setState는 값만 바꾸고 "다시 그려야 할 컴포넌트"를 큐(Set)에 넣는다. Set이라 같은 컴포넌트는 한 번만 들어간다.
//   큐를 비우는 일(flush)은 queueMicrotask로 미룬다. 마이크로태스크는 "지금 실행 중인 코드(클릭 핸들러 등)가
//   끝난 직후, 브라우저가 화면을 그리기 전"에 실행되므로, 그때는 같은 핸들러 안의 setState가 모두 끝나 있다.
//   → setState 3번 = 큐에 1번 = update 1번. 화면에는 중간값(1, 2)이 나타나지 않는다.

const dirtyComponents = new Set();
let isFlushScheduled = false;

// 무한 렌더 방지: 한 틱 안에서 같은 컴포넌트의 update가 이만큼 이어지면 멈춘다.
// deps 없는 useEffect 안에서 setState하면 "렌더 → effect → setState → 렌더…"가 끝없이 이어지고,
// 마이크로태스크라 브라우저가 화면을 그릴 틈도 없이 멈춰 버리기 때문이다.
export const MAX_CHAINED_UPDATES = 50;
const chainedUpdates = new WeakMap(); // 컴포넌트 → 이번 틱에 이어진 update 수

function allowUpdate(component) {
  const count = (chainedUpdates.get(component) ?? 0) + 1;
  chainedUpdates.set(component, count);
  // 다음 매크로태스크(사용자의 다음 클릭, 다음 타이머)에서는 다시 0부터 센다
  if (count === 1) setTimeout(() => chainedUpdates.delete(component), 0);
  if (count <= MAX_CHAINED_UPDATES) return true;
  if (count === MAX_CHAINED_UPDATES + 1) {
    console.error(`[mini-react] 렌더가 쉬지 않고 ${MAX_CHAINED_UPDATES}번 넘게 이어져 멈췄습니다. deps 없는 useEffect 안에서 setState하고 있지 않은지 확인하세요.`);
  }
  component.pendingSetStateCount = 0;
  return false;
}

export function scheduleUpdate(component) {
  if (!component.batching) {
    if (allowUpdate(component)) component.update(); // 비교용: 배칭을 끄면 setState마다 바로 그린다
    return;
  }
  dirtyComponents.add(component);
  if (isFlushScheduled) return; // 이미 예약됐으면 다시 예약하지 않는다
  isFlushScheduled = true;
  queueMicrotask(flushUpdates);
}

// unmount할 때 부른다: 예약해 둔 update가 내려간(또는 다시 mount된) 컴포넌트에 적용되지 않게 큐에서 뺀다
export function cancelUpdate(component) {
  dirtyComponents.delete(component);
}

function flushUpdates() {
  isFlushScheduled = false;
  const components = [...dirtyComponents];
  dirtyComponents.clear();
  // update 중에 effect가 다시 setState하면 큐에 새로 들어가 다음 마이크로태스크에서 처리된다
  for (const component of components) {
    if (allowUpdate(component)) component.update();
  }
}
