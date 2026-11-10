// VNode props → 실제 DOM 반영. render와 patch가 모두 이 함수들만 쓴다.

// 속성(attribute)은 초기값일 뿐이고, 화면의 실제 상태는 프로퍼티(property)에 있는 것들
const PROPERTY_KEYS = new Set(['value', 'checked', 'selected']);

// on + 대문자로 시작하는 prop은 이벤트 핸들러다 (onClick → 'click', onInput → 'input')
const EVENT_PROP_PATTERN = /^on[A-Z]/;
// 소문자로 바꾸기만 해서는 DOM 이벤트 이름과 맞지 않는 것들
const EVENT_NAME_EXCEPTIONS = { onDoubleClick: 'dblclick' };

// 요소마다 지금 붙어 있는 핸들러 { click: fn }.
// removeEventListener는 "붙일 때 쓴 바로 그 함수"를 넘겨야 떼어지므로 옛 함수를 기억해 둔다.
// WeakMap이라 요소가 DOM에서 사라지면 기록도 같이 정리된다.
const listenersByElement = new WeakMap();

function isEventProp(key) {
  return EVENT_PROP_PATTERN.test(key);
}

function toEventName(key) {
  return EVENT_NAME_EXCEPTIONS[key] ?? key.slice(2).toLowerCase();
}

// handler가 함수가 아니면(null, false, 문자열 등) 붙어 있던 핸들러를 뗀다
function setListener(el, key, handler) {
  const type = toEventName(key);
  const listeners = listenersByElement.get(el) ?? {};
  const prevHandler = listeners[type];
  const nextHandler = typeof handler === 'function' ? handler : undefined;
  if (prevHandler === nextHandler) return;

  // 옛 핸들러를 떼지 않고 새 것만 붙이면 클릭 한 번에 둘 다 실행된다
  if (prevHandler) el.removeEventListener(type, prevHandler);
  if (nextHandler) {
    el.addEventListener(type, nextHandler);
    listeners[type] = nextHandler;
  } else {
    delete listeners[type];
  }
  listenersByElement.set(el, listeners);
}

function isSkipped(key) {
  if (key === 'key') return true; // key 기반 diff용 표식. DOM에는 그리지 않는다
  // HTML에서 온 문자열 핸들러(onclick="alert(1)")는 입력이 코드로 실행되면 위험하므로 그리지 않는다
  if (key.startsWith('on') && !isEventProp(key)) return true;
  return false;
}

// false/null/undefined는 "속성 없음", true는 값 없는 속성(<input disabled>)
function isAbsent(value) {
  return value === false || value === null || value === undefined;
}

export function setProp(el, key, value) {
  if (isSkipped(key)) return;

  if (isEventProp(key)) {
    setListener(el, key, value);
    return;
  }

  if (isAbsent(value)) {
    removeProp(el, key);
    return;
  }

  // 같은 값을 다시 쓰면 DOM 변경(MutationRecord)이 생기므로 다를 때만 쓴다
  const attrValue = value === true ? '' : String(value);
  if (el.getAttribute(key) !== attrValue) el.setAttribute(key, attrValue);

  if (PROPERTY_KEYS.has(key) && key in el) {
    if (key === 'value') {
      // 같은 값이면 건드리지 않는다 (입력 중 커서가 튀는 것 방지)
      if (el.value !== String(value)) el.value = value;
    } else {
      // checked/selected는 속성이 있기만 하면 true (<input checked> → checked: '')
      el[key] = true;
    }
  }
}

export function removeProp(el, key) {
  if (isSkipped(key)) return;

  if (isEventProp(key)) {
    setListener(el, key, null);
    return;
  }

  el.removeAttribute(key);

  if (PROPERTY_KEYS.has(key) && key in el) {
    el[key] = key === 'value' ? '' : false;
  }
}

// patch용: oldProps → newProps로 바뀐 부분만 반영
export function updateProps(el, oldProps, newProps) {
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) removeProp(el, key);
  }
  for (const [key, value] of Object.entries(newProps)) {
    // 프로퍼티는 사용자가 화면에서 바꿨을 수 있으므로 VNode 값이 같아도 다시 맞춘다
    if (PROPERTY_KEYS.has(key) || oldProps[key] !== value) setProp(el, key, value);
  }
}
