import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, createElement, htmlToVNode, TEXT } from '../src/lib/vdom.js';
import { diff, PatchType, longestIncreasingSubsequence, diffProps } from '../src/lib/diff.js';
import { applyPatches } from '../src/lib/patch.js';

/** old 를 그리고 diff/patch 로 new 로 바꾼 결과가 new 를 처음부터 그린 결과와 같은지 검증 */
function check(oldV, newV) {
  const host = document.createElement('div');
  let root = createElement(oldV);
  host.appendChild(root);
  const patches = diff(oldV, newV);
  root = applyPatches(root, patches);
  const expected = createElement(newV).outerHTML;
  assert.equal(host.firstChild.outerHTML ?? host.firstChild.nodeValue, expected);
  return { patches, root, host };
}

const types = (patches) => patches.map((p) => p.type);
const ul = (...keys) => h('ul', null, keys.map((k) => h('li', { key: k }, String(k))));

describe('diff — 5가지 핵심 케이스', () => {
  test('① INSERT: 새 자식 추가', () => {
    const { patches } = check(h('ul', null, h('li', null, 'a')), h('ul', null, h('li', null, 'a'), h('li', null, 'b')));
    assert.deepEqual(types(patches), [PatchType.INSERT]);
    assert.equal(patches[0].index, 1);
  });

  test('② REMOVE: 자식 삭제', () => {
    const { patches } = check(h('ul', null, h('li', null, 'a'), h('li', null, 'b')), h('ul', null, h('li', null, 'a')));
    assert.deepEqual(types(patches), [PatchType.REMOVE]);
  });

  test('③ REPLACE: 태그가 바뀌면 노드 교체', () => {
    const { patches } = check(h('div', null, h('p', null, 'x')), h('div', null, h('h3', null, 'x')));
    assert.deepEqual(types(patches), [PatchType.REPLACE]);
    assert.deepEqual(patches[0].path, [0]);
  });

  test('③ REPLACE: 텍스트 ↔ 엘리먼트', () => {
    const { patches } = check(h('div', null, 'x'), h('div', null, h('b', null, 'x')));
    assert.deepEqual(types(patches), [PatchType.REPLACE]);
  });

  test('④ TEXT: 텍스트만 변경', () => {
    const { patches } = check(h('p', null, 'hello'), h('p', null, 'world'));
    assert.deepEqual(types(patches), [PatchType.TEXT]);
    assert.equal(patches[0].text, 'world');
  });

  test('⑤ PROPS: 속성 추가/수정/삭제', () => {
    const { patches, root } = check(h('div', { id: 'a', title: 't' }), h('div', { id: 'b', class: 'c' }));
    assert.deepEqual(types(patches), [PatchType.PROPS]);
    assert.equal(root.getAttribute('id'), 'b');
    assert.equal(root.hasAttribute('title'), false);
    assert.equal(root.getAttribute('class'), 'c');
  });

  test('변경이 없으면 패치 0개', () => {
    const v = () => h('div', { id: 'x' }, h('p', null, 'a'), h('ul', null, h('li', { key: 1 }, '1')));
    assert.equal(diff(v(), v()).length, 0);
  });

  test('같은 참조는 하위 비교를 건너뛴다', () => {
    const shared = h('p', null, 'same');
    assert.equal(diff(h('div', null, shared), h('div', null, shared)).length, 0);
  });

  test('루트 태그 교체 시 새 루트를 반환', () => {
    const { root } = check(h('div', null, 'a'), h('section', null, 'a'));
    assert.equal(root.tagName, 'SECTION');
  });
});

describe('diff — key 기반 리스트 재정렬 (MOVE)', () => {
  test('맨 뒤 → 맨 앞: MOVE 1회, 노드 재사용', () => {
    const host = document.createElement('div');
    const oldV = ul('a', 'b', 'c', 'd');
    const root = createElement(oldV);
    host.appendChild(root);
    const dNode = root.childNodes[3];
    const patches = diff(oldV, ul('d', 'a', 'b', 'c'));
    applyPatches(root, patches);
    assert.deepEqual(types(patches), [PatchType.MOVE]);
    assert.equal(root.childNodes[0], dNode, '같은 DOM 노드가 이동되어야 함 (재생성 X)');
    assert.equal(root.textContent, 'dabc');
  });

  test('맨 앞 → 맨 뒤: LIS 덕분에 MOVE 1회', () => {
    const { patches } = check(ul('a', 'b', 'c', 'd'), ul('b', 'c', 'd', 'a'));
    assert.deepEqual(types(patches), [PatchType.MOVE]);
  });

  test('역순 정렬', () => {
    const { patches } = check(ul(1, 2, 3, 4, 5), ul(5, 4, 3, 2, 1));
    assert.equal(patches.filter((p) => p.type === 'MOVE').length, 4);
  });

  test('삽입 + 삭제 + 이동 + 내용 변경 혼합', () => {
    const oldV = h('ul', null, ['a', 'b', 'c', 'd'].map((k) => h('li', { key: k }, k)));
    const newV = h('ul', null, ['c', 'x', 'a', 'd'].map((k) => h('li', { key: k, class: k === 'a' ? 'on' : null }, k + '!')));
    check(oldV, newV);
  });

  test('key 없는 리스트는 순서대로 비교', () => {
    const { patches } = check(
      h('ul', null, h('li', null, 'a'), h('li', null, 'b')),
      h('ul', null, h('li', null, 'x'), h('li', null, 'b'), h('li', null, 'c')),
    );
    assert.deepEqual(types(patches), [PatchType.INSERT, PatchType.TEXT]);
  });

  test('key 가 같아도 태그가 다르면 REPLACE', () => {
    const { patches } = check(h('div', null, h('p', { key: 1 }, 'a')), h('div', null, h('span', { key: 1 }, 'a')));
    assert.deepEqual(types(patches), [PatchType.REPLACE]);
  });

  test('중복 key 도 결과는 올바르다', () => {
    check(ul('a', 'a', 'b'), ul('b', 'a', 'a'));
  });

  test('keyed / unkeyed 혼합', () => {
    check(
      h('div', null, h('p', null, '1'), h('i', { key: 'k' }, 'k'), h('p', null, '2')),
      h('div', null, h('i', { key: 'k' }, 'k'), h('p', null, '2'), h('b', { key: 'n' }, 'n')),
    );
  });

  test('모든 자식 삭제 / 빈 리스트에서 추가', () => {
    check(ul('a', 'b', 'c'), ul());
    check(ul(), ul('a', 'b'));
  });
});

describe('diff — 중첩 / 특수 케이스', () => {
  test('깊은 트리의 텍스트 하나만 변경 → TEXT 1개', () => {
    const tree = (t) => h('div', null, h('section', null, h('article', null, h('p', null, 'x'), h('p', null, t))));
    const { patches } = check(tree('a'), tree('b'));
    assert.deepEqual(types(patches), ['TEXT']);
    assert.deepEqual(patches[0].path, [0, 0, 1, 0]);
  });

  test('이동한 노드 내부 변경도 올바른 경로로 적용', () => {
    check(
      h('ul', null, h('li', { key: 1 }, h('b', null, 'one')), h('li', { key: 2 }, 'two')),
      h('ul', null, h('li', { key: 2 }, 'TWO'), h('li', { key: 1 }, h('b', { class: 'x' }, 'ONE'))),
    );
  });

  test('SVG 안에 삽입되는 노드는 SVG 네임스페이스', () => {
    const host = document.createElement('div');
    const oldV = h('svg', null, h('rect'));
    const root = createElement(oldV);
    host.append(root);
    applyPatches(root, diff(oldV, h('svg', null, h('rect'), h('circle', { r: 2 }))));
    assert.equal(root.lastChild.namespaceURI, 'http://www.w3.org/2000/svg');
  });

  test('style 객체가 값이 같으면 변경 없음', () => {
    assert.equal(diffProps({ style: { color: 'red' } }, { style: { color: 'red' } }).length, 0);
  });

  test('HTML 문자열로 만든 VDOM 끼리도 동작', () => {
    check(
      htmlToVNode('<table><tr><td>1</td></tr></table><p>x</p>'),
      htmlToVNode('<table><tr><td>1</td><td>2</td></tr></table><p class="y">x</p><hr>'),
    );
  });
});

describe('LIS', () => {
  test('최장 증가 부분 수열 인덱스', () => {
    assert.deepEqual(longestIncreasingSubsequence([2, 0, 1, 3]), [1, 2, 3]);
    assert.deepEqual(longestIncreasingSubsequence([]), []);
    assert.equal(longestIncreasingSubsequence([5, 4, 3]).length, 1);
    assert.equal(longestIncreasingSubsequence([0, 8, 4, 12, 2, 10, 6, 14, 1, 9]).length, 4);
  });
});

// ---------------------------------------------------------------- 퍼즈 테스트
describe('무작위 트리 퍼즈 테스트', () => {
  // 시드 고정 난수 (재현 가능)
  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }

  function randomTree(rand, depth = 0) {
    const tags = ['div', 'p', 'span', 'ul', 'li', 'b'];
    const n = depth > 3 ? 0 : Math.floor(rand() * 5);
    const keyed = rand() < 0.5;
    const usedKeys = new Set();
    const children = [];
    for (let i = 0; i < n; i++) {
      if (rand() < 0.3) {
        children.push(String(Math.floor(rand() * 3)));
      } else {
        const props = {};
        if (rand() < 0.4) props.class = 'c' + Math.floor(rand() * 3);
        if (rand() < 0.2) props.title = 't' + Math.floor(rand() * 2);
        if (keyed) {
          let k;
          do k = Math.floor(rand() * 8); while (usedKeys.has(k));
          usedKeys.add(k);
          props.key = k;
        }
        children.push(h(tags[Math.floor(rand() * tags.length)], props, ...randomTree(rand, depth + 1).children));
      }
    }
    return h('div', null, ...mergeText(children));
  }
  // 인접한 텍스트는 DOM 직렬화 비교를 위해 그대로 두되, 비교는 outerHTML 로 한다.
  const mergeText = (c) => c;

  test('300 쌍의 무작위 트리에서 patch 결과 == 새로 그린 결과', () => {
    const rand = rng(42);
    for (let i = 0; i < 300; i++) {
      const a = randomTree(rand);
      const b = randomTree(rand);
      check(a, b);
      check(b, a);
    }
  });

  test('패치 결과의 텍스트 노드 수까지 일치 (구조 동일성)', () => {
    const rand = rng(7);
    const countText = (n) => (n.nodeType === 3 ? 1 : [...n.childNodes].reduce((s, c) => s + countText(c), 0));
    const countV = (v) => (v.type === TEXT ? 1 : v.children.reduce((s, c) => s + countV(c), 0));
    for (let i = 0; i < 100; i++) {
      const a = randomTree(rand);
      const b = randomTree(rand);
      const { host } = check(a, b);
      assert.equal(countText(host.firstChild), countV(b));
    }
  });
});

describe('diff — 긴 목록의 이동 계산 (O(n log n) 배치)', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const keyedUl = (keys) => h('ul', null, ...keys.map((k) => h('li', { key: k }, String(k))));

  test('무작위 삽입·삭제·섞기 300번: DOM 결과가 맞고, 같은 key 의 노드를 재사용하며, MOVE 횟수 = 남은 줄 − LIS', () => {
    for (let t = 0; t < 300; t++) {
      const n = Math.floor(rand() * 60);
      const oldKeys = Array.from({ length: n }, (_, i) => i);
      let newKeys = oldKeys.filter(() => rand() > 0.2);
      for (let i = newKeys.length - 1; i > 0; i--) if (rand() < 0.5) { const j = Math.floor(rand() * (i + 1)); [newKeys[i], newKeys[j]] = [newKeys[j], newKeys[i]]; }
      newKeys = newKeys.flatMap((k) => (rand() < 0.15 ? [k, 1000 + k] : [k]));

      const host = document.createElement('div');
      const root = createElement(keyedUl(oldKeys));
      host.appendChild(root);
      const byKey = new Map([...root.childNodes].map((el, i) => [oldKeys[i], el]));
      const patches = diff(keyedUl(oldKeys), keyedUl(newKeys));
      applyPatches(root, patches);

      assert.equal(root.outerHTML, createElement(keyedUl(newKeys)).outerHTML);
      newKeys.forEach((k, i) => { if (byKey.has(k)) assert.equal(root.childNodes[i], byKey.get(k), `key ${k} 노드 재사용`); });
      const kept = oldKeys.filter((k) => newKeys.includes(k));
      const seq = kept.map((k) => newKeys.indexOf(k));
      const moves = patches.filter((p) => p.type === PatchType.MOVE).length;
      assert.ok(moves <= kept.length - longestIncreasingSubsequence(seq).length, `MOVE ${moves}회가 최소보다 많음`);
    }
  });

  test('2만 줄 뒤집기도 빠르게 끝난다 (예전 indexOf·splice 방식은 약 0.8초)', () => {
    const keys = Array.from({ length: 20000 }, (_, i) => i);
    const t0 = performance.now();
    const patches = diff(keyedUl(keys), keyedUl(keys.slice().reverse()));
    const ms = performance.now() - t0;
    assert.equal(patches.filter((p) => p.type === PatchType.MOVE).length, 19999);
    assert.ok(ms < 400, `${ms.toFixed(0)}ms`);
  });
});
