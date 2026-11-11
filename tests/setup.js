// jsdom 으로 브라우저 DOM 환경을 만든다. (테스트 전용 devDependency)
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
g.Node = dom.window.Node;
g.MutationObserver = dom.window.MutationObserver;
g.HTMLElement = dom.window.HTMLElement;
if (!g.localStorage) {
  Object.defineProperty(g, 'localStorage', { value: dom.window.localStorage, configurable: true });
}

// 테스트 출력이 지저분해지지 않도록 개발 경고는 기본으로 끈다 (경고 자체를 검사하는 테스트에서만 켬)
import { devConfig } from "../src/lib/warn.js";
devConfig.warnings = false;

/**
 * 대기 중인 작업 비우기: batching 된 업데이트(microtask) + 화면 그린 뒤의 useEffect(macrotask)
 * effect 안에서 다시 setState 하는 연쇄까지 처리되도록 몇 번 반복한다.
 */
export const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 메모리 Storage (localStorage 대체) */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

export function container(html = '') {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}
