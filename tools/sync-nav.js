// 모든 페이지 상단 메뉴(<nav>)를 같은 목록으로 맞추고, 학습 도우미 챗봇을 모든 페이지에 넣는다.  node tools/sync-nav.js  (build.js 가 자동 실행)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 1주차: 미니 리액트 */
export const PAGES = [
  ['index.html', '홈'],
  ['guide/index.html', '학습 가이드'],
  ['phase1/index.html', 'Phase 1 · Diff'],
  ['phase2/index.html', 'Phase 2 · Hooks'],
  ['examples/index.html', '예제'],
  ['sandbox/index.html', '샌드박스'],
  ['walkthrough/index.html', '코드 해설'],
  ['theory/index.html', 'React 이론'],
  ['deepdive/index.html', '개념 더 파고들기'],
  ['cheatsheet/index.html', '한 장 요약'],
  ['docs/index.html', '설명서'],
];

/** 실제 파일이 있는 모든 페이지 */
export const ALL_PAGES = [...PAGES];

const GROUPS = [['week1', PAGES]];

/** 챗봇 CSS/JS 를 페이지에 한 번만 넣는다 (표식 주석으로 중복 방지) */
const CHAT_CSS = '<!-- chat:css -->';
const CHAT_JS = '<!-- chat:js -->';
export function withChat(html, up) {
  let out = html;
  if (!out.includes(CHAT_CSS)) {
    out = out.replace('</head>', `  ${CHAT_CSS}<link rel="stylesheet" href="${up}tools/chat.css" />\n</head>`);
  }
  if (!out.includes(CHAT_JS)) {
    out = out.replace('</body>', `  ${CHAT_JS}<script src="${up}tools/chat.js"></script>\n</body>`);
  }
  return out;
}

function navLinks(list, page, up) {
  return list
    .map(([target, label]) => {
      const here = target === page;
      const href = here ? './index.html' : up + target;
      return `      <a href="${href}"${here ? ' aria-current="page"' : ''}>${label}</a>`;
    })
    .join('\n');
}

export function syncNav() {
  const changed = [];
  for (const [, list] of GROUPS) {
    for (const [page, , opts] of list) {
      if (opts?.link) continue;
      const file = resolve(ROOT, page);
      const depth = page.split('/').length - 1;
      const up = depth ? '../'.repeat(depth) : './';
      const html = readFileSync(file, 'utf8');
      let next = html.replace(/(<header class="topbar">[\s\S]*?)<nav>[\s\S]*?<\/nav>/, `$1<nav>\n${navLinks(list, page, up)}\n    </nav>`);
      next = withChat(next, up);
      if (next !== html) {
        writeFileSync(file, next);
        changed.push(page);
      }
    }
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = syncNav();
  console.log(changed.length ? `nav 갱신: ${changed.join(', ')}` : 'nav 변경 없음');
}
