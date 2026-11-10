import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMutations } from '../src/utils/domStats.js';

// MutationObserver는 기록을 나중에 넘기므로 takeRecords()로 바로 꺼낸다
function observe(container, change) {
  const observer = new MutationObserver(() => {});
  observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true });
  change();
  const result = summarizeMutations(observer.takeRecords());
  observer.disconnect();
  return result;
}

describe('summarizeMutations', () => {
  test('글자·속성 변경은 노드 하나씩', () => {
    const container = makeContainer();
    container.innerHTML = '<p class="a">x</p>';
    const result = observe(container, () => {
      container.firstChild.className = 'b';
      container.firstChild.firstChild.nodeValue = 'y';
    });
    assert.deepEqual(result, { added: 0, removed: 0, attributes: 1, texts: 1, total: 2, nodes: 2 });
  });

  test('통째로 바꾸면 total은 루트 2개지만, nodes는 지운·만든 자식까지 모두 센다', () => {
    const container = makeContainer();
    container.innerHTML = '<ul><li>a</li><li>b</li></ul>'; // ul, li, a, li, b = 5개
    const result = observe(container, () => {
      container.innerHTML = '<ul><li>a</li><li>b</li></ul>';
    });
    assert.equal(result.total, 2);
    assert.equal(result.nodes, 10);
  });

  test('같은 노드가 여러 번 기록돼도 한 번만 센다', () => {
    const container = makeContainer();
    container.innerHTML = '<p>x</p>';
    const result = observe(container, () => {
      container.firstChild.title = '1';
      container.firstChild.title = '2';
    });
    assert.equal(result.total, 1);
    assert.equal(result.nodes, 1);
  });
});
