// HTML 문자열 → 루트 VNode 하나
// 브라우저 파서는 틀린 HTML도 조용히 고쳐 버리므로, 파싱 전에 태그 짝을 직접 검사해
// 사용자가 쓴 그대로를 기준으로 에러를 알려 준다.

import { toVNode } from './domToVNode.js';
import { VOID_TAGS, SVG_TAG, FOREIGN_OBJECT_TAG } from './htmlTags.js';

// <태그 속성="값 > 포함 가능"> / </태그> / <태그 />
const TAG_PATTERN =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/g;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

export class HTMLParseError extends Error {
  constructor(message, line) {
    super(line ? `${line}번째 줄: ${message}` : message);
    this.name = 'HTMLParseError';
    this.line = line;
  }
}

export function parseHTML(source) {
  if (source.trim() === '') {
    throw new HTMLParseError('입력이 비어 있습니다. 루트 요소 하나를 입력하세요.');
  }

  const tagCount = checkTags(source);

  const template = document.createElement('template');
  template.innerHTML = source;

  // 태그 짝이 맞아도 HTML 중첩 규칙에 어긋나면 브라우저가 구조를 바꾼다
  // (<p> 안의 <div> → <p>가 쪼개짐, <table> 바로 아래 <tr> → <tbody>가 끼어듦)
  const elementCount = template.content.querySelectorAll('*').length;
  if (elementCount !== tagCount) {
    throw new HTMLParseError(
      `브라우저가 구조를 고쳐 입력과 결과가 달라집니다. (태그 ${tagCount}개 → 요소 ${elementCount}개) ` +
        '<p> 안의 블록 요소, <table>에서 생략한 <tbody>처럼 중첩 규칙에 어긋난 곳이 있는지 확인하세요.'
    );
  }

  checkAttributeNames(template.content, source);

  const roots = [...template.content.childNodes].map(toVNode).filter((v) => v !== null);

  if (roots.length === 0) {
    throw new HTMLParseError('요소가 없습니다. 루트 요소 하나를 입력하세요.');
  }
  if (roots.length > 1) {
    throw new HTMLParseError(`루트 요소는 하나여야 합니다. (지금 ${roots.length}개)`);
  }
  if (typeof roots[0] === 'string') {
    throw new HTMLParseError('루트는 텍스트가 아니라 요소여야 합니다.');
  }
  return roots[0];
}

function getLineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

// 브라우저 HTML 파서는 @click, :a 같은 속성 이름도 받아들이지만 setAttribute는 InvalidCharacterError를 던진다.
// 그대로 두면 render/patch 도중에 터져 실제 영역이 일부만 바뀐 채 남으므로, 파싱 단계에서 미리 알린다.
function checkAttributeNames(fragment, source) {
  const probe = document.createElement('div');
  for (const el of fragment.querySelectorAll('*')) {
    for (const { name } of el.attributes) {
      try {
        probe.setAttribute(name, '');
        probe.removeAttribute(name);
      } catch {
        const index = source.indexOf(name);
        throw new HTMLParseError(
          `"${name}"은(는) 속성 이름으로 쓸 수 없습니다. 영문자로 시작하는 이름을 쓰세요.`,
          index === -1 ? undefined : getLineNumber(source, index)
        );
      }
    }
  }
}

function checkTags(source) {
  // 주석은 같은 길이의 공백으로 바꿔 줄 번호를 유지한다
  const text = source.replace(COMMENT_PATTERN, (m) => m.replace(/[^\n]/g, ' '));

  // 태그로 인식되지 않은 '<' 가 남아 있으면 '>' 누락 등으로 깨진 태그다
  const leftover = /<\/?[a-zA-Z]/.exec(text.replace(TAG_PATTERN, (m) => ' '.repeat(m.length)));
  if (leftover) {
    throw new HTMLParseError('태그가 제대로 닫히지 않았습니다. (\'>\' 누락?)', getLineNumber(text, leftover.index));
  }

  const stack = [];
  let openCount = 0;

  for (const match of text.matchAll(TAG_PATTERN)) {
    const [, slash, rawName, , selfClose] = match;
    const name = rawName.toLowerCase();
    const line = getLineNumber(text, match.index);

    if (!slash) openCount++;
    if (VOID_TAGS.has(name)) continue;

    if (slash) {
      const top = stack.at(-1);
      if (!top) throw new HTMLParseError(`</${name}>에 맞는 여는 태그가 없습니다.`, line);
      if (top.name !== name) {
        throw new HTMLParseError(`</${name}>이(가) 왔지만 <${top.name}>(${top.line}번째 줄)이 아직 안 닫혔습니다.`, line);
      }
      stack.pop();
    } else if (selfClose) {
      // HTML에서 <div/>의 '/'는 무시되어 열린 태그가 된다. SVG 안에서만 스스로 닫을 수 있다.
      // 가장 가까운 문맥을 본다: foreignObject 안쪽은 SVG 안이어도 다시 HTML 문맥이다.
      const context = stack.findLast((tag) => tag.name === SVG_TAG || tag.name === FOREIGN_OBJECT_TAG.toLowerCase());
      const isInSvg = context?.name === SVG_TAG;
      if (!isInSvg) throw new HTMLParseError(`<${name}/>처럼 일반 요소는 스스로 닫을 수 없습니다. </${name}>을 쓰세요.`, line);
    } else {
      stack.push({ name, line });
    }
  }

  const unclosed = stack.at(-1);
  if (unclosed) {
    throw new HTMLParseError(`<${unclosed.name}>의 닫는 태그가 없습니다.`, unclosed.line);
  }
  return openCount;
}
