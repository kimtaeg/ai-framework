// node:test에는 브라우저가 없으므로, DOM이 필요한 테스트를 위해 jsdom으로 window·document를 전역에 둔다.
// 각 테스트 파일 맨 위에서 `import './setup.js';`로 불러온다.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const GLOBALS = ['window', 'document', 'Node', 'Text', 'Comment', 'HTMLElement', 'MutationObserver', 'Event', 'MouseEvent'];

globalThis.window = dom.window;
for (const name of GLOBALS) {
  if (name !== 'window') globalThis[name] = dom.window[name];
}

// 테스트마다 깨끗한 컨테이너를 만든다
export function makeContainer() {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  return container;
}
