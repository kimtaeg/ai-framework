// 같은 변경(prev → next)을 두 방식으로 적용했을 때 실제 DOM이 몇 군데 바뀌는지 잰다.
//   patch     : diff로 다른 곳만 찾아 고친다 (Virtual DOM)
//   innerHTML : 새 HTML 문자열로 통째로 갈아 끼운다
// 둘 다 화면 밖 복사본(sandbox)에서 재므로 실제 영역과 문서는 건드리지 않는다.

import { createElement } from '../core/vdom.js';
import { diff } from '../core/diff.js';
import { applyPatches } from '../core/patch.js';
import { measureDeep } from '../utils/domStats.js';

function sandboxWith(vnode) {
  const sandbox = document.createElement('div');
  sandbox.appendChild(createElement(vnode));
  return sandbox;
}

export function measurePatch(prev, next) {
  const sandbox = sandboxWith(prev);
  const patches = diff(prev, next);
  return measureDeep(sandbox, () => applyPatches(sandbox, patches));
}

export function measureInnerHTML(prev, next) {
  const sandbox = sandboxWith(prev);
  const html = createElement(next).outerHTML; // 측정 전에 문자열을 만들어 둔다 (측정 범위 밖)
  return measureDeep(sandbox, () => {
    sandbox.innerHTML = html;
  });
}
