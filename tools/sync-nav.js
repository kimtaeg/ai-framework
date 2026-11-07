// 모든 페이지 상단 메뉴(<nav>)를 같은 목록으로 맞추고, 학습 도우미 챗봇을 모든 페이지에 넣는다.  node tools/sync-nav.js  (build.js 가 자동 실행)
//  - 1주차 · 2주차 레디스 · 2주차 DBMS 페이지는 각자의 메뉴
//  - 홈(index.html)에는 세 메뉴가 다 있고, 왼쪽에서 고른 과제에 맞는 메뉴를 보여 준다 (<nav class="nav-redis">, <nav class="nav-dbms">)
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

/** 2주차 · 미니 레디스 (1주차 메뉴와 같은 순서).  link: true 는 메뉴에만 있는 링크 (그 파일의 메뉴는 바꾸지 않음) */
export const REDIS_PAGES = [
  ['index.html#redis', '홈', { link: true }],
  ['week2/redis/guide/index.html', '학습 가이드'],
  ['week2/redis/index.html', '미니 레디스'],
  ['week2/redis/examples/index.html', '예제'],
  ['week2/redis/sandbox/index.html', '샌드박스'],
  ['week2/redis/walkthrough/index.html', '코드 해설'],
  ['week2/redis/theory/index.html', '레디스 이론'],
  ['week2/redis/deepdive/index.html', '개념 더 파고들기'],
  ['week2/redis/cheatsheet/index.html', '한 장 요약'],
  ['week2/redis/docs/index.html', '설명서'],
];

/** 2주차 · 미니 DBMS (Phase 1 · 2 · 3 을 1주차 Phase 페이지처럼 나눔) */
export const DBMS_PAGES = [
  ['index.html#dbms', '홈', { link: true }],
  ['week2/dbms/guide/index.html', '학습 가이드'],
  ['week2/dbms/phase1/index.html', 'Phase 1 · SQL'],
  ['week2/dbms/phase2/index.html', 'Phase 2 · B+ 트리'],
  ['week2/dbms/phase3/index.html', 'Phase 3 · API 서버'],
  ['week2/dbms/examples/index.html', '예제'],
  ['week2/dbms/sandbox/index.html', '샌드박스'],
  ['week2/dbms/walkthrough/index.html', '코드 해설'],
  ['week2/dbms/theory/index.html', 'DBMS 이론'],
  ['week2/dbms/deepdive/index.html', '개념 더 파고들기'],
  ['week2/dbms/cheatsheet/index.html', '한 장 요약'],
  ['week2/dbms/docs/index.html', '설명서'],
];

/** 예전 이름 (테스트 호환): 2주차 전체 */
export const WEEK2_PAGES = [...REDIS_PAGES, ...DBMS_PAGES];

/** 실제 파일이 있는 모든 페이지 */
export const ALL_PAGES = [...PAGES, ...WEEK2_PAGES.filter(([, , o]) => !o?.link)];

const GROUPS = [['week1', PAGES], ['redis', REDIS_PAGES], ['dbms', DBMS_PAGES]];

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
  for (const [group, list] of GROUPS) {
    for (const [page, , opts] of list) {
      if (opts?.link) continue;
      const file = resolve(ROOT, page);
      const depth = page.split('/').length - 1;
      const up = depth ? '../'.repeat(depth) : './';
      const html = readFileSync(file, 'utf8');
      let next = html.replace(/(<header class="topbar">[\s\S]*?)<nav>[\s\S]*?<\/nav>/, `$1<nav>\n${navLinks(list, page, up)}\n    </nav>`);
      // 홈: 2주차 메뉴(레디스 · DBMS)도 함께 넣어 두고, 화면에서 고른 과제에 따라 바꿔 보여 준다
      if (group === 'week1') {
        next = next.replace(/<nav class="nav-redis"([^>]*)>[\s\S]*?<\/nav>/, (m, attrs) => `<nav class="nav-redis"${attrs}>\n${navLinks(REDIS_PAGES, page, up)}\n    </nav>`);
        next = next.replace(/<nav class="nav-dbms"([^>]*)>[\s\S]*?<\/nav>/, (m, attrs) => `<nav class="nav-dbms"${attrs}>\n${navLinks(DBMS_PAGES, page, up)}\n    </nav>`);
      }
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
