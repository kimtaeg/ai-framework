// VNode props → 실제 DOM 반영. render와 patch가 모두 이 함수들만 쓴다.

// 속성(attribute)은 초기값일 뿐이고, 화면의 실제 상태는 프로퍼티(property)에 있는 것들
const PROPERTY_KEYS = new Set(['value', 'checked', 'selected']);

function isSkipped(key) {
  if (key === 'key') return true; // key 기반 diff용 표식. DOM에는 그리지 않는다
  // TODO(Phase 2): on으로 시작하는 prop(onClick 등)은 여기서 addEventListener로 이벤트를 붙인다
  if (key.startsWith('on')) return true;
  return false;
}

// false/null/undefined는 "속성 없음", true는 값 없는 속성(<input disabled>)
function isAbsent(value) {
  return value === false || value === null || value === undefined;
}

export function setProp(el, key, value) {
  if (isSkipped(key)) return;

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
