/**
 * Virtual DOM
 * ------------------------------------------------------------------
 * VNode 구조
 *   Element : { type: 'div', props: { id: 'a' }, key: null, children: [VNode...] }
 *   Text    : { type: '#text', props: {}, key: null, children: [], text: 'hello' }
 *   Component (렌더 전에만 존재) : { type: Function, props, key, children }
 *
 * 실제 DOM 노드는 수많은 속성/메서드/레이아웃 정보를 가진 무거운 객체지만,
 * VNode 는 "무엇을 그려야 하는가" 만 담은 가벼운 JS 객체이므로 생성·비교 비용이 매우 작다.
 */

import { warn } from './warn.js';

export const TEXT = '#text';
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** 내용 없이 열고 닫는 태그 (직렬화 시 닫는 태그를 쓰지 않는다) */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/** attribute 가 아닌 DOM property 로 다뤄야 화면에 반영되는 상태값 */
const BOOLEAN_PROPS = new Set(['checked', 'selected', 'disabled', 'multiple', 'readOnly', 'hidden']);

// ------------------------------------------------------------------
// VNode 생성
// ------------------------------------------------------------------

export function createText(text) {
  return { type: TEXT, props: {}, key: null, children: [], text: String(text) };
}

/**
 * hyperscript 함수. JSX 가 컴파일되면 나오는 React.createElement 와 같은 역할.
 *   h('ul', { class: 'list' }, h('li', { key: 1 }, 'A'), ...)
 * - 중첩 배열은 평탄화, null / undefined / boolean 은 무시 (조건부 렌더링 지원)
 * - 숫자·문자열은 텍스트 VNode 로 변환
 * - props.key 는 VNode.key 로 분리 (DOM 속성으로 렌더하지 않음)
 */
export function h(type, props, ...children) {
  const p = props ? { ...props } : {};
  const key = p.key ?? null;
  delete p.key;
  for (const c of children) if (Array.isArray(c)) checkListKeys(c, type);
  return { type, props: p, key, children: normalizeChildren(children) };
}

/** 배열(map 결과)로 넘긴 형제들 중 key 가 없는 엘리먼트가 있으면 경고 (React 와 같은 규칙) */
function checkListKeys(list, parentType) {
  let elements = 0;
  let missing = 0;
  for (const c of list) {
    if (c && typeof c === 'object' && !Array.isArray(c) && c.type !== TEXT) {
      elements++;
      if (c.key == null) missing++;
    }
  }
  if (elements >= 2 && missing > 0) {
    const where = typeof parentType === 'string' ? `<${parentType}>` : parentType?.name || '컴포넌트';
    warn(`${where} 안의 리스트 항목 ${missing}개에 key 가 없습니다. 리스트를 map 으로 만들 때는 각 항목에 고유한 key 를 지정하세요.`);
  }
}

export function normalizeChildren(children, out = []) {
  for (const c of children) {
    if (Array.isArray(c)) normalizeChildren(c, out);
    else if (c == null || typeof c === 'boolean') continue;
    else if (typeof c === 'object') out.push(c);
    else out.push(createText(c));
  }
  return out;
}

// ------------------------------------------------------------------
// 실제 DOM → Virtual DOM
// ------------------------------------------------------------------

/**
 * 브라우저 DOM 노드를 읽어 VNode 트리로 변환한다.
 *
 * 정책 (엣지 케이스)
 *  - 주석 / 처리 지시문 등은 무시
 *  - 줄바꿈이 포함된 공백 전용 텍스트(들여쓰기)는 무시 → 코드 포매팅이 diff 에 영향을 주지 않음
 *  - sanitize(기본값 true): <script> 태그와 on* 인라인 이벤트 속성 제거 (사용자 입력 HTML 보호)
 *  - key / data-key 속성은 VNode.key 로도 사용 → 리스트 재정렬 시 이동(MOVE) 감지
 *
 * @returns {object|null} 변환 대상이 아니면 null
 */
export function domToVNode(node, options = {}) {
  const { sanitize = true } = options;

  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.nodeValue;
    if (isFormattingWhitespace(text)) return null;
    return createText(text);
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return null;

  const type = node.namespaceURI === SVG_NS ? node.localName : node.localName.toLowerCase();
  if (sanitize && type === 'script') return null;

  const props = {};
  for (const attr of node.attributes) {
    if (sanitize && /^on/i.test(attr.name)) continue;
    props[attr.name] = attr.value;
  }
  const key = props.key ?? props['data-key'] ?? null;

  // <template> 는 내용이 content(DocumentFragment)에 들어 있다.
  const source = type === 'template' && node.content ? node.content : node;
  const children = [];
  for (const child of source.childNodes) {
    const v = domToVNode(child, options);
    if (v) children.push(v);
  }
  return { type, props, key, children };
}

/**
 * 컨테이너 자체가 아니라 컨테이너의 "내용" 을 하나의 루트 VNode 로 감싼다.
 * (Phase 1 의 실제 영역 / 테스트 영역은 서로 다른 id 를 가지므로 컨테이너 속성은 비교 대상에서 제외)
 */
export function containerToVNode(container, options) {
  const children = [];
  const source = container.content ?? container; // <template> 지원
  for (const child of source.childNodes) {
    const v = domToVNode(child, options);
    if (v) children.push(v);
  }
  return { type: 'div', props: {}, key: null, children };
}

/** HTML 문자열 → 루트 VNode. <template> 로 파싱하므로 스크립트가 실행되지 않는다. */
export function htmlToVNode(html, options) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return containerToVNode(tpl.content, options);
}

export function isFormattingWhitespace(text) {
  return /^\s*$/.test(text) && text.includes('\n');
}

/**
 * VNode 로 변환하지 않는 노드(주석, 들여쓰기 공백 등)를 실제 DOM 에서도 제거한다.
 * DOM childNodes 의 인덱스와 VNode children 의 인덱스를 1:1 로 맞추기 위한 정규화.
 */
export function normalizeDom(node, options = {}) {
  const { sanitize = true } = options;
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      if (isFormattingWhitespace(child.nodeValue)) child.remove();
    } else if (child.nodeType === 1) {
      if (sanitize && child.localName === 'script') { child.remove(); continue; }
      if (sanitize) {
        for (const attr of [...child.attributes]) {
          if (/^on/i.test(attr.name)) child.removeAttribute(attr.name);
        }
      }
      normalizeDom(child.content ?? child, options);
    } else {
      child.remove();
    }
  }
  // 인접 텍스트 노드 병합 (파서 결과와 동일하게)
  node.normalize?.();
  return node;
}

// ------------------------------------------------------------------
// Virtual DOM → 실제 DOM
// ------------------------------------------------------------------

/** VNode 로부터 실제 DOM 노드를 생성한다. (최초 렌더링, INSERT/REPLACE 패치에 사용) */
export function createElement(vnode, parentNs = null) {
  if (vnode.type === TEXT) return document.createTextNode(vnode.text);
  if (typeof vnode.type !== 'string') {
    throw new TypeError('createElement: 컴포넌트 VNode 는 먼저 resolve 되어야 합니다.');
  }

  const ns = vnode.type === 'svg' ? SVG_NS : parentNs;
  const el = ns ? document.createElementNS(ns, vnode.type) : document.createElement(vnode.type);

  // <select value> 는 <option> 이 붙은 뒤에 설정해야 반영된다.
  const deferValue = vnode.type === 'select' && 'value' in vnode.props;
  for (const [name, value] of Object.entries(vnode.props)) {
    if (deferValue && name === 'value') continue;
    setProp(el, name, value, undefined);
  }

  const childNs = ns && vnode.type !== 'foreignObject' ? ns : null;
  const target = vnode.type === 'template' && el.content ? el.content : el;
  for (const child of vnode.children) target.appendChild(createElement(child, childNs));
  if (deferValue) setProp(el, 'value', vnode.props.value, undefined);
  return el;
}

/** 부모 DOM 기준으로 자식이 생성되어야 할 네임스페이스 (SVG 내부 여부) */
export function childNamespace(parentEl) {
  if (parentEl && parentEl.namespaceURI === SVG_NS && parentEl.localName !== 'foreignObject') return SVG_NS;
  return null;
}

// ------------------------------------------------------------------
// 속성(props) 반영
// ------------------------------------------------------------------

export function isEventProp(name, value, oldValue) {
  return /^on[A-Za-z]/.test(name) && (typeof value === 'function' || typeof oldValue === 'function');
}

/**
 * 하나의 prop 을 실제 DOM 에 반영한다. value 가 undefined 이면 제거.
 *  - on* 함수   : 이벤트 리스너 (리스너는 1회만 등록하고, 핸들러만 교체 → 매 렌더마다 add/remove 하지 않음)
 *  - style      : 문자열 또는 객체
 *  - className  : class 로 매핑, htmlFor → for
 *  - value / checked / selected 등 : attribute 와 property 를 함께 갱신 (사용자 입력 상태까지 반영)
 */
export function setProp(el, name, value, oldValue) {
  if (name === 'children' || name === 'ref') return; // (h() 는 key 를 props 에서 이미 분리한다)

  if (isEventProp(name, value, oldValue)) {
    setEvent(el, name.slice(2).toLowerCase(), typeof value === 'function' ? value : null);
    return;
  }
  if (name === 'style') {
    setStyle(el, value, oldValue);
    return;
  }
  if (name === 'className') name = 'class';
  else if (name === 'htmlFor') name = 'for';

  if (name === 'value' && 'value' in el && el.namespaceURI !== SVG_NS) {
    const v = value == null ? '' : String(value);
    if (el.value !== v) el.value = v;
  } else if (BOOLEAN_PROPS.has(name) && name in el) {
    const v = value != null && value !== false && value !== 'false';
    if (el[name] !== v) el[name] = v;
    if (v) el.setAttribute(name, '');
    else el.removeAttribute(name);
    return;
  }

  if (value == null || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

function setEvent(el, eventName, handler) {
  const store = el.__mrHandlers || (el.__mrHandlers = {});
  const proxies = el.__mrProxies || (el.__mrProxies = {});
  if (handler) {
    store[eventName] = handler;
    if (!proxies[eventName]) {
      proxies[eventName] = (e) => store[eventName]?.(e);
      el.addEventListener(eventName, proxies[eventName]);
    }
  } else {
    delete store[eventName];
    if (proxies[eventName]) {
      el.removeEventListener(eventName, proxies[eventName]);
      delete proxies[eventName];
    }
  }
}

function setStyle(el, value, oldValue) {
  if (value == null || typeof value === 'string') {
    if (value) el.setAttribute('style', value);
    else el.removeAttribute('style');
    return;
  }
  if (typeof oldValue === 'string') el.removeAttribute('style');
  const prev = oldValue && typeof oldValue === 'object' ? oldValue : {};
  for (const k of Object.keys(prev)) {
    if (!(k in value)) setStyleKey(el.style, k, '');
  }
  for (const [k, v] of Object.entries(value)) {
    if (prev[k] !== v) setStyleKey(el.style, k, v == null ? '' : String(v));
  }
}

function setStyleKey(style, key, value) {
  if (key.includes('-')) style.setProperty(key, value);
  else style[key] = value;
}

// ------------------------------------------------------------------
// Virtual DOM → HTML 문자열 (테스트 영역 표시 / 디버깅)
// ------------------------------------------------------------------

const RAW_TEXT_TAGS = new Set(['pre', 'textarea', 'style']);

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function styleToString(style) {
  return Object.entries(style)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}: ${v}`)
    .join('; ');
}

function attrsToString(props) {
  let out = '';
  for (let [name, value] of Object.entries(props)) {
    if (typeof value === 'function' || value == null || value === false) continue;
    if (name === 'className') name = 'class';
    if (name === 'htmlFor') name = 'for';
    if (name === 'style' && typeof value === 'object') value = styleToString(value);
    out += value === true ? ` ${name}` : ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

/**
 * VNode → HTML. 요소만 자식으로 가진 경우에만 줄바꿈/들여쓰기를 넣어,
 * 다시 파싱(domToVNode)했을 때 동일한 VNode 가 나오도록 (round-trip 안정성) 보장한다.
 */
export function vnodeToHTML(vnode, depth = 0, indent = '  ') {
  if (vnode.type === TEXT) return escapeText(vnode.text);
  const open = `<${vnode.type}${attrsToString(vnode.props)}>`;
  if (VOID_TAGS.has(vnode.type)) return open;

  const kids = vnode.children;
  const allElements = kids.length > 0 && kids.every((c) => c.type !== TEXT);
  if (!allElements || RAW_TEXT_TAGS.has(vnode.type)) {
    return `${open}${kids.map((c) => vnodeToHTML(c, 0, '')).join('')}</${vnode.type}>`;
  }
  const pad = indent.repeat(depth + 1);
  const inner = kids.map((c) => pad + vnodeToHTML(c, depth + 1, indent)).join('\n');
  return `${open}\n${inner}\n${indent.repeat(depth)}</${vnode.type}>`;
}

/** 루트 VNode 의 자식들만 HTML 로 (컨테이너 내용) */
export function childrenToHTML(root, indent = '  ') {
  return root.children.map((c) => vnodeToHTML(c, 0, indent)).join('\n');
}

/** VNode 트리의 전체 노드 수 */
export function countNodes(vnode) {
  if (!vnode) return 0;
  return 1 + vnode.children.reduce((n, c) => n + countNodes(c), 0);
}
