// 닫는 태그가 없는 HTML 요소. 파서(parseHTML)와 직렬화(toHTML)가 같은 목록을 써야
// toHTML ↔ parseHTML 왕복이 어긋나지 않는다.
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

// SVG 네임스페이스 판단에 쓰는 태그 이름. foreignObject 안쪽은 다시 HTML 문맥이다.
// (vdom.js의 render/isSvgContext와 parseHTML.js의 self-closing 검사가 같은 이름을 써야 판단이 어긋나지 않는다)
export const SVG_TAG = 'svg';
export const FOREIGN_OBJECT_TAG = 'foreignObject';
