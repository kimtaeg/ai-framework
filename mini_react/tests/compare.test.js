import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { measureInnerHTML, measurePatch } from '../src/phase1/compare.js';

// key는 항목 번호, 글자는 따로 → 글자가 바뀌어도 같은 항목
const list = (...items) => h('ul', { class: 'todo' }, items.map((text, i) => h('li', { key: String(i) }, text)));

describe('patch vs innerHTML: 같은 변경을 두 방식으로 적용했을 때 바뀐 노드 수', () => {
  test('글자 하나만 바꿔도 innerHTML은 트리 전체를 지우고 새로 만든다', () => {
    const prev = list('a', 'b', 'c');
    const next = list('a', 'b', 'c!');
    const byPatch = measurePatch(prev, next);
    const byInnerHTML = measureInnerHTML(prev, next);

    assert.deepEqual(byPatch, { added: 0, removed: 0, attributes: 0, texts: 1, total: 1 });
    // ul 1 + li 3 + 텍스트 3 = 7개를 지우고, 같은 7개를 새로 만든다
    assert.deepEqual(byInnerHTML, { added: 7, removed: 7, attributes: 0, texts: 0, total: 14 });
  });

  test('항목 하나 추가: patch는 그 항목(li + 텍스트)만, innerHTML은 전부', () => {
    const prev = list('a', 'b');
    const next = list('a', 'b', 'c');
    assert.equal(measurePatch(prev, next).total, 2);
    assert.equal(measureInnerHTML(prev, next).total, 5 + 7);
  });

  test('바뀐 게 없으면 patch는 0, innerHTML은 그래도 전부 다시 만든다', () => {
    const tree = list('a');
    assert.equal(measurePatch(tree, tree).total, 0);
    assert.equal(measureInnerHTML(tree, tree).total, 6);
  });

  test('화면 밖 복사본에서 재므로 실제 문서는 바뀌지 않는다', () => {
    document.body.innerHTML = '<p id="x">그대로</p>';
    measureInnerHTML(list('a'), list('b'));
    measurePatch(list('a'), list('b'));
    assert.equal(document.body.innerHTML, '<p id="x">그대로</p>');
  });
});
