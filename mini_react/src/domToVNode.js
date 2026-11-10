// 실제 DOM 노드 → VNode (vdom.js와 같은 모양)
// 무시할 노드(들여쓰기용 공백 텍스트, 주석 등)는 null을 돌려준다.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// 줄바꿈이 섞인 공백만 있는 텍스트는 HTML 들여쓰기라서 버린다 (JSX와 같은 규칙).
// 같은 줄의 공백(<b>a</b> <i>b</i>)은 화면에 보이는 내용이므로 남긴다.
// String.prototype.trim은 &nbsp;(U+00A0)까지 지우므로 HTML 공백 문자만 직접 지정한다.
const FORMATTING_WHITESPACE = /^[ \t\r\f]*\n[ \t\r\n\f]*$/;

export function toVNode(node) {
  switch (node.nodeType) {
    case TEXT_NODE: {
      const text = node.textContent;
      return text === '' || FORMATTING_WHITESPACE.test(text) ? null : text;
    }

    case ELEMENT_NODE: {
      const props = {};
      for (const attr of node.attributes) {
        props[attr.name] = attr.value;
      }

      const children = [];
      for (const child of node.childNodes) {
        const vchild = toVNode(child);
        if (vchild !== null) children.push(vchild);
      }

      // localName: HTML은 소문자, SVG는 원래 대소문자(foreignObject, linearGradient)를 지킨다
      return { type: node.localName, props, children };
    }

    default:
      // 주석(8), 문서(9), 기타 노드는 무시
      return null;
  }
}
