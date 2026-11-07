/**
 * file:// 용 번들 생성기 (의존성 없음)
 * ------------------------------------------------------------------
 * HTML 파일을 더블클릭해서(file://) 열면 브라우저 보안 정책(CORS) 때문에
 * <script type="module"> 이 다른 파일을 import 하지 못한다.
 * 그래서 각 페이지의 진입점(main.js)과 import 하는 모듈들을 하나의 일반 스크립트로 합친다.
 *
 *   node build.js   →  phase1/bundle.js, phase2/bundle.js
 *
 * 원본(소스)은 여전히 src/ 와 phase*\/main.js 이고, bundle.js 는 생성물이다.
 * 서버(npm start)로 열면 원본 모듈을, file:// 로 열면 bundle.js 를 사용한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { syncNav } from './tools/sync-nav.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;

function bundle(entry) {
  const order = [];
  const seen = new Set();

  // 의존성이 먼저 오도록 깊이 우선 순회 (위상 정렬)
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, spec] of code.matchAll(IMPORT_RE)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
    }
    order.push({ file, code });
  }
  visit(resolve(ROOT, entry));

  const body = order
    .map(({ file, code }) => {
      const stripped = code
        .replace(IMPORT_RE, '')                       // import 문 제거 (모두 같은 스코프에 합쳐짐)
        .replace(/^export\s+(default\s+)?/gm, '');    // export 키워드 제거
      return `// ---- ${relative(ROOT, file).replace(/\\/g, '/')} ----\n${stripped}`;
    })
    .join('\n');

  return `/* 자동 생성 파일 (node build.js) — 직접 수정하지 마세요. file:// 로 열 때만 사용됩니다. */\n(() => {\n'use strict';\n${body}\n})();\n`;
}

for (const page of ['phase1', 'phase2', 'examples', 'sandbox', 'deepdive', 'week2/redis', 'week2/redis/examples', 'week2/redis/sandbox', 'week2/redis/theory', 'week2/redis/deepdive', 'week2/dbms/phase1', 'week2/dbms/phase2', 'week2/dbms/phase3', 'week2/dbms/examples', 'week2/dbms/sandbox', 'week2/dbms/theory', 'week2/dbms/deepdive']) {
  const out = resolve(ROOT, page, 'bundle.js');
  const code = bundle(`${page}/main.js`);
  // 여러 모듈을 한 스코프에 합치므로 같은 이름이 두 번 선언되면 문법 에러가 난다 → 빌드 단계에서 바로 알린다
  new Script(code, { filename: out });
  writeFileSync(out, code);
  console.log(`built ${relative(ROOT, out)}`);
}

// 모든 페이지의 상단 메뉴를 같은 목록으로
const navChanged = syncNav();
if (navChanged.length) console.log(`nav 갱신: ${navChanged.join(', ')}`);
