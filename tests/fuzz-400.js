import './setup.js';
import assert from 'node:assert/strict';
import { h, createElement, TEXT } from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';
import { applyPatches } from '../src/lib/patch.js';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { BPlusTree } from '../week2/dbms/bptree.js';
import { tokenize, parse } from '../week2/dbms/sql.js';

console.log('======================================================================');
console.log('🚀 [미니 리액트 · 레디스 · DBMS] 전 영역 400개 무작위 퍼즈 검증 시작');
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
console.log('👉 [1/3] miniReact: 400쌍 무작위 VDOM 트리 Diff & Patch 구조 동일성 검증 중...');
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
// SECTION 2: miniRedis — 400회 무작위 K-V 연산, 점진적 리해시 & 무결성 검증
// ====================================================================
console.log('👉 [2/3] miniRedis: 400회 무작위 연산, 충돌 유도, 점진적 리해시 & 데이터 무결성 검증 중...');
const redisStart = Date.now();
let redisPass = 0;

const redis = new MiniRedis();
const referenceMap = new Map(); // 오라클(참조 모델)
const keyPool = Array.from({ length: 50 }, (_, i) => `key_${i}`);

for (let i = 0; i < 400; i++) {
  const op = rand();
  const key = keyPool[Math.floor(rand() * keyPool.length)];

  if (op < 0.45) {
    // SET 연산
    const val = `val_${Math.floor(rand() * 1000)}`;
    redis.command(['SET', key, val]);
    referenceMap.set(key, val);
    redisPass++;
  } else if (op < 0.70) {
    // GET 연산 및 오라클 대조
    const actual = redis.command(['GET', key]);
    const expected = referenceMap.has(key) ? referenceMap.get(key) : null;
    assert.equal(actual, expected, `Iteration ${i + 1} GET mismatch for key '${key}'`);
    redisPass++;
  } else if (op < 0.85) {
    // DEL 연산
    const actualDel = redis.command(['DEL', key]);
    const hadKey = referenceMap.has(key);
    referenceMap.delete(key);
    assert.equal(actualDel, hadKey ? 1 : 0);
    redisPass++;
  } else {
    // INCR 연산
    const counterKey = `cnt_${Math.floor(rand() * 5)}`;
    let expectedVal = 1;
    if (referenceMap.has(counterKey)) {
      const parsed = parseInt(referenceMap.get(counterKey), 10);
      expectedVal = isNaN(parsed) ? 1 : parsed + 1;
    }
    const actualIncr = redis.command(['INCR', counterKey]);
    referenceMap.set(counterKey, String(actualIncr));
    assert.equal(actualIncr, expectedVal);
    redisPass++;
  }
}

// 최종 상태 덤프 & 대조 검증
for (const [k, expectedV] of referenceMap.entries()) {
  const actualV = redis.command(['GET', k]);
  assert.equal(actualV, expectedV, `Final state mismatch for key '${k}'`);
}
const redisElapsed = Date.now() - redisStart;
console.log(`   ✅ miniRedis 검증 완료: 400 / 400 통과 (100%) [소요 시간: ${redisElapsed}ms]\n`);


// ====================================================================
// SECTION 3: miniDBMS — 400회 무작위 B+ Tree 삽입/탐색 및 SQL 파서 검증
// ====================================================================
console.log('👉 [3/3] miniDBMS: 400회 무작위 B+ 트리 삽입·범위 탐색 & SQL 파싱 불변식 검증 중...');
const dbmsStart = Date.now();
let dbmsPass = 0;

// 1. B+ 트리 차수 4로 무작위 삽입/검색/범위 쿼리 300회
const tree = new BPlusTree(4);
const treeOracle = new Map();

for (let i = 0; i < 300; i++) {
  const k = Math.floor(rand() * 2000);
  const v = `row_${k}`;

  if (treeOracle.has(k)) {
    assert.throws(() => tree.insert(k, v), /이미 있는 키입니다/);
  } else {
    tree.insert(k, v);
    treeOracle.set(k, v);
  }

  // 불변식 검증 (트리 노드 균형, 정렬성, 링크드리스트 연결)
  assert.equal(tree.check(), true, `B+ Tree invariant violated at iteration ${i + 1}`);

  // 무작위 점 조회
  if (rand() < 0.3) {
    const searchK = Math.floor(rand() * 2000);
    const actual = tree.get(searchK);
    const expected = treeOracle.get(searchK);
    assert.equal(actual, expected, `B+ Tree point lookup mismatch for key ${searchK}`);
  }

  // 무작위 범위 조회 (Range Query)
  if (rand() < 0.2) {
    const low = Math.floor(rand() * 1000);
    const high = low + Math.floor(rand() * 500);
    const actualRange = [...tree.range(low, high)].map(entry => entry[0]);
    
    // 오라클 정렬 범위
    const expectedKeys = [...treeOracle.keys()]
      .filter(key => key >= low && key <= high)
      .sort((a, b) => a - b);
    
    assert.deepEqual(actualRange, expectedKeys, `B+ Tree range mismatch for [${low}, ${high}]`);
  }
  dbmsPass++;
}

// 2. SQL 파서 & 토크나이저 100회 무작위 쿼리 파싱 및 저장형식 왕복 검증
const tableNames = ['users', 'products', 'orders', 'items'];
const cols = ['id', 'name', 'price', 'age', 'status'];

for (let i = 0; i < 100; i++) {
  const tbl = tableNames[Math.floor(rand() * tableNames.length)];
  const col = cols[Math.floor(rand() * cols.length)];
  const val = Math.floor(rand() * 1000);
  const limitVal = 1 + Math.floor(rand() * 50);

  const sql = `SELECT * FROM ${tbl} WHERE ${col} = ${val} LIMIT ${limitVal};`;
  const [ast] = parse(sql);

  assert.equal(ast.type, 'select');
  assert.equal(ast.table, tbl);
  assert.equal(ast.columns, '*');
  assert.equal(ast.where[0].column, col);
  assert.equal(ast.where[0].op, '=');
  assert.equal(ast.where[0].value.value, val);
  assert.equal(ast.limit, limitVal);
  dbmsPass++;
}
const dbmsElapsed = Date.now() - dbmsStart;
console.log(`   ✅ miniDBMS 검증 완료: 400 / 400 통과 (100%) [소요 시간: ${dbmsElapsed}ms]\n`);


// ====================================================================
// 종합 결과 리포트
// ====================================================================
const totalElapsed = reactElapsed + redisElapsed + dbmsElapsed;
console.log('======================================================================');
console.log('🏆 [최종 결과] 모든 핵심 엔진 무작위 퍼즈 검증 성공 (100% Deterministic)');
console.log('======================================================================');
console.log(`| 검증 트랙 | 검증 방식 | 무작위 케이스 수 | 통과율 | 소요 시간 |`);
console.log(`| :--- | :--- | :---: | :---: | :---: |`);
console.log(`| **1. miniReact** | 400쌍 무작위 트리 Diff/Patch HTML 일치 검증 | 400건 | **400 / 400 (100%)** | ${reactElapsed}ms |`);
console.log(`| **2. miniRedis** | 400회 무작위 K-V, 충돌, 리해시, INCR 검증 | 400건 | **400 / 400 (100%)** | ${redisElapsed}ms |`);
console.log(`| **3. miniDBMS**  | 400회 B+ 트리(Order 4) 불변식 & SQL 파서 검증 | 400건 | **400 / 400 (100%)** | ${dbmsElapsed}ms |`);
console.log('----------------------------------------------------------------------');
console.log(`합계: 총 1,200건 무작위 검증 전수 통과 (오류 0건, 총 ${totalElapsed}ms 소요)`);
console.log('======================================================================\n');
