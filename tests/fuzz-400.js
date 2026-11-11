import './setup.js';
import assert from 'node:assert/strict';
import { h, createElement } from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';
import { applyPatches } from '../src/lib/patch.js';

console.log('======================================================================');
console.log('🚀 [미니 리액트] 400개 무작위 퍼즈 검증 시작');
console.log('======================================================================\n');

// ---------------------------------------------------------------- 난수 발생기 (PRNG)
function makeRng(seed = 123456789) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rand = makeRng(20261109);

// ====================================================================
// SECTION 1: miniReact — 400쌍 무작위 VDOM 트리 변형 및 Patch 일치율 검증
// ====================================================================
console.log('👉 [1/1] miniReact: 400쌍 무작위 VDOM 트리 Diff & Patch 구조 동일성 검증 중...');
const reactStart = Date.now();
let reactPass = 0;

function randomVTree(depth = 0) {
  const tags = ['div', 'p', 'span', 'ul', 'li', 'b', 'i', 'section', 'article'];
  const n = depth > 3 ? 0 : Math.floor(rand() * 5);
  const keyed = rand() < 0.6;
  const usedKeys = new Set();
  const children = [];

  for (let i = 0; i < n; i++) {
    if (rand() < 0.25) {
      children.push(`text_${Math.floor(rand() * 10)}`);
    } else {
      const props = {};
      if (rand() < 0.4) props.class = `cls_${Math.floor(rand() * 5)}`;
      if (rand() < 0.3) props.id = `id_${Math.floor(rand() * 10)}`;
      if (rand() < 0.2) props['data-idx'] = String(i);
      if (keyed) {
        let k;
        do { k = Math.floor(rand() * 12); } while (usedKeys.has(k));
        usedKeys.add(k);
        props.key = k;
      }
      children.push(h(tags[Math.floor(rand() * tags.length)], props, ...randomVTree(depth + 1).children));
    }
  }
  return h('div', { class: 'root' }, ...children);
}

for (let i = 0; i < 400; i++) {
  const vOld = randomVTree();
  const vNew = randomVTree();

  const host = document.createElement('div');
  let domNode = createElement(vOld);
  host.appendChild(domNode);

  const patches = diff(vOld, vNew);
  domNode = applyPatches(domNode, patches);

  const expectedDOM = createElement(vNew);
  const actualHTML = host.firstChild.outerHTML ?? host.firstChild.nodeValue;
  const expectedHTML = expectedDOM.outerHTML ?? expectedDOM.nodeValue;

  assert.equal(actualHTML, expectedHTML, `Iteration ${i + 1} VDOM Patch HTML mismatch!`);
  reactPass++;
}
const reactElapsed = Date.now() - reactStart;
console.log(`   ✅ miniReact 검증 완료: 400 / 400 통과 (100%) [소요 시간: ${reactElapsed}ms]\n`);


// ====================================================================
// 종합 결과 리포트
// ====================================================================
const totalElapsed = reactElapsed;
console.log('======================================================================');
console.log('🏆 [최종 결과] miniReact 무작위 퍼즈 검증 성공 (100% Deterministic)');
console.log('======================================================================');
console.log(`| 검증 트랙 | 검증 방식 | 무작위 케이스 수 | 통과율 | 소요 시간 |`);
console.log(`| :--- | :--- | :---: | :---: | :---: |`);
console.log(`| **1. miniReact** | 400쌍 무작위 트리 Diff/Patch HTML 일치 검증 | 400건 | **400 / 400 (100%)** | ${reactElapsed}ms |`);
console.log('----------------------------------------------------------------------');
console.log(`합계: 총 400건 무작위 검증 전수 통과 (오류 0건, 총 ${totalElapsed}ms 소요)`);
console.log('======================================================================\n');
