// VNode props → 실제 DOM 속성·프로퍼티·이벤트로 반영하는 단일 창구.
// createElement(처음 그리기)와 applyPatches(바뀐 곳 고치기)가 둘 다 이 함수들만 쓴다.

// HTML 속성(attribute)은 "초기값"일 뿐이고 화면의 실제 상태는 프로퍼티(property)에 있는 것들.
// 사용자가 한 번 입력·클릭한 뒤에는 setAttribute만으로는 화면이 바뀌지 않으므로 property도 맞춘다.
const PROPERTY_KEYS = new Set(['value', 'checked', 'selected']);

// JSX 습관 이름을 HTML 속성 이름으로
const ATTRIBUTE_ALIASES = { className: 'class', htmlFor: 'for' };

// on + 대문자로 시작하면 이벤트 핸들러 (onClick → 'click')
const EVENT_PROP_PATTERN = /^on[A-Z]/;
const EVENT_NAME_EXCEPTIONS = { onDoubleClick: 'dblclick' };

// 요소마다 지금 붙어 있는 핸들러 { click: fn }.
// removeEventListener는 "붙일 때 쓴 바로 그 함수"를 넘겨야 떼어지므로 옛 함수를 기억해 둔다.
const listenersByElement = new WeakMap();

export function isEventProp(key) {
  return EVENT_PROP_PATTERN.test(key);
}

function toEventName(key) {
  return EVENT_NAME_EXCEPTIONS[key] ?? key.slice(2).toLowerCase();
}

// false·null·undefined는 "속성 없음", true는 값 없는 속성(<input disabled>)
function isAbsent(value) {
  return value === false || value === null || value === undefined;
}

// { fontSize: '12px' } → 'font-size: 12px;'
export function styleToString(style) {
  return Object.entries(style)
    .filter(([, value]) => !isAbsent(value) && value !== '')
    .map(([name, value]) => `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`)
    .join(' ');
}

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

export function setProp(el, key, value) {
  if (key === 'key') return; // key는 diff용 표식. DOM에는 그리지 않는다
  if (isEventProp(key)) {
    setListener(el, key, value);
    return;
  }
  // HTML에서 온 문자열 핸들러(onclick="...")는 입력이 코드로 실행되면 위험하므로 그리지 않는다
  if (key.startsWith('on')) return;

  const name = ATTRIBUTE_ALIASES[key] ?? key;
  if (isAbsent(value)) {
    removeProp(el, name);
    return;
  }

  const attrValue = value === true ? '' : name === 'style' && typeof value === 'object' ? styleToString(value) : String(value);
  // 같은 값을 다시 쓰면 DOM 변경(MutationRecord)이 생기므로 다를 때만 쓴다
  if (el.getAttribute(name) !== attrValue) el.setAttribute(name, attrValue);

  if (PROPERTY_KEYS.has(name) && name in el) {
    if (name === 'value') {
      if (el.value !== String(value)) el.value = value; // 같으면 건드리지 않음 (입력 중 커서가 튀는 것 방지)
    } else {
      el[name] = true; // checked·selected는 속성이 있기만 하면 true (<input checked> → '')
    }
  }
}

export function removeProp(el, key) {
  if (key === 'key') return;
  if (isEventProp(key)) {
    setListener(el, key, null);
    return;
  }
  if (key.startsWith('on')) return;

  const name = ATTRIBUTE_ALIASES[key] ?? key;
  el.removeAttribute(name);
  if (PROPERTY_KEYS.has(name) && name in el) {
    el[name] = name === 'value' ? '' : false;
  }
}
