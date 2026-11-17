import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** HTML 을 열고(스크립트 태그 제외) bundle.js 를 실행 — 파일을 더블클릭해서 연 상황 */
export function openBundle(dir) {
  const html = read(`${dir}/index.html`).replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: `file:///project/${dir}/index.html`, runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (e) => errors.push(e.message));
  dom.window.eval(read(`${dir}/bundle.js`));
  return { dom, w: dom.window, d: dom.window.document, errors };
}
