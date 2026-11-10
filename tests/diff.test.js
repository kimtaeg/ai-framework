import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { diff } from '../src/core/diff.js';

const types = (patches) => patches.map((p) => p.type);
const li = (key, text = key) => h('li', { key }, text);
const list = (...keys) => h('ul', null, ...keys.map((k) => li(k)));

describe('diff — 기본 5가지 케이스', () => {
  test('같으면 patch가 없다', () => {
    assert.deepEqual(diff(h('p', { id: 'a' }, 'x'), h('p', { id: 'a' }, 'x')), []);
  });

  test('1) CREATE: 새 자식이 생기면 부모 경로와 들어갈 위치', () => {
    const next = h('ul', null, h('li', null, 'a'), h('li', null, 'b'));
    assert.deepEqual(diff(h('ul', null, h('li', null, 'a')), next), [
      { type: 'CREATE', parentPath: [], index: 1, vnode: next.children[1] },
    ]);
  });

  test('2) REMOVE: 없어진 자식은 이전 트리 기준 경로', () => {
    assert.deepEqual(diff(h('ul', null, h('li', null, 'a'), h('li', null, 'b')), h('ul', null, h('li', null, 'a'))), [
      { type: 'REMOVE', path: [1] },
    ]);
  });

  test('3) REPLACE: 태그가 다르면 통째로 교체 (그 아래는 비교하지 않음)', () => {
    const next = h('section', null, 'a');
    assert.deepEqual(diff(h('div', null, 'a'), next), [{ type: 'REPLACE', path: [], vnode: next }]);
  });

  test('3) REPLACE: 텍스트 ↔ 요소', () => {
    const next = h('p', null, h('b', null, 'a'));
    assert.deepEqual(diff(h('p', null, 'a'), next), [{ type: 'REPLACE', path: [0], vnode: next.children[0] }]);
    assert.deepEqual(types(diff(next, h('p', null, 'a'))), ['REPLACE']);
  });

  test('4) UPDATE_PROPS: 추가·변경은 set, 삭제는 remove', () => {
    assert.deepEqual(diff(h('a', { href: '/a', title: 't' }), h('a', { href: '/b', class: 'on' })), [
      { type: 'UPDATE_PROPS', path: [], set: { href: '/b', class: 'on' }, remove: ['title'] },
    ]);
  });

  test('4) UPDATE_PROPS: style 객체는 내용이 같으면 새 객체여도 바뀐 것이 아니다', () => {
    assert.deepEqual(diff(h('p', { style: { color: 'red' } }), h('p', { style: { color: 'red' } })), []);
    assert.deepEqual(types(diff(h('p', { style: { color: 'red' } }), h('p', { style: { color: 'blue' } }))), ['UPDATE_PROPS']);
  });

  test('4) UPDATE_PROPS: 이벤트 핸들러가 바뀌거나 사라지는 것도 속성 변경', () => {
    const a = () => {};
    const b = () => {};
    assert.deepEqual(diff(h('button', { onClick: a }), h('button', { onClick: b })), [
      { type: 'UPDATE_PROPS', path: [], set: { onClick: b }, remove: [] },
    ]);
    assert.deepEqual(diff(h('button', { onClick: a }), h('button')), [{ type: 'UPDATE_PROPS', path: [], set: {}, remove: ['onClick'] }]);
    assert.deepEqual(diff(h('button', { onClick: a }), h('button', { onClick: a })), []);
  });

  test('5) UPDATE_TEXT: 텍스트 내용만 바뀜 (중첩 경로)', () => {
    assert.deepEqual(diff(h('ul', null, h('li', null, 'a'), h('li', null, 'b')), h('ul', null, h('li', null, 'a'), h('li', null, 'B'))), [
      { type: 'UPDATE_TEXT', path: [1, 0], text: 'B' },
    ]);
  });

  test('루트가 없던 곳에 생기거나 사라지는 경우', () => {
    const root = h('p', null, 'a');
    assert.deepEqual(diff(null, root), [{ type: 'CREATE', parentPath: null, index: 0, vnode: root }]);
    assert.deepEqual(diff(root, null), [{ type: 'REMOVE', path: [] }]);
  });
});

describe('diff — key 리스트 (MOVE)', () => {
  test('순서 뒤집기: 하나만 그대로 두고 나머지 3개를 MOVE', () => {
    const patches = diff(list('a', 'b', 'c', 'd'), list('d', 'c', 'b', 'a'));
    assert.deepEqual(types(patches), ['MOVE', 'MOVE', 'MOVE']);
  });

  test('맨 뒤를 맨 앞으로: 옮긴 항목 하나만 MOVE (나머지는 그대로 둘 수 있다)', () => {
    assert.deepEqual(diff(list('a', 'b', 'c', 'd'), list('d', 'a', 'b', 'c')), [
      { type: 'MOVE', parentPath: [], from: 3, index: 0, key: 'd' },
    ]);
  });

  test('가운데 하나를 다른 곳으로: MOVE 하나', () => {
    assert.deepEqual(types(diff(list('a', 'b', 'c', 'd', 'e'), list('a', 'c', 'd', 'b', 'e'))), ['MOVE']);
  });

  test('맨 앞을 맨 뒤로: MOVE 하나', () => {
    assert.deepEqual(diff(list('a', 'b', 'c'), list('b', 'c', 'a')), [{ type: 'MOVE', parentPath: [], from: 0, index: 2, key: 'a' }]);
  });

  test('중간 삽입: 새 key만 CREATE, 나머지는 그대로', () => {
    const next = list('a', 'x', 'b', 'c');
    assert.deepEqual(diff(list('a', 'b', 'c'), next), [{ type: 'CREATE', parentPath: [], index: 1, vnode: next.children[1] }]);
  });

  test('중간 삭제: 인덱스 방식과 달리 REMOVE 하나만 (뒤 항목을 고치지 않음)', () => {
    assert.deepEqual(diff(list('a', 'b', 'c'), list('a', 'c')), [{ type: 'REMOVE', path: [1] }]);
  });

  test('비교: key가 없으면 중간 삭제가 "텍스트 변경 + 마지막 삭제"가 된다', () => {
    const plain = (...texts) => h('ul', null, ...texts.map((t) => h('li', null, t)));
    assert.deepEqual(types(diff(plain('a', 'b', 'c'), plain('a', 'c'))), ['REMOVE', 'UPDATE_TEXT']);
  });

  test('전부 삭제', () => {
    assert.deepEqual(diff(list('a', 'b', 'c'), h('ul', null)), [
      { type: 'REMOVE', path: [0] },
      { type: 'REMOVE', path: [1] },
      { type: 'REMOVE', path: [2] },
    ]);
  });

  test('옮겨진 항목 안의 변경은 이전 위치 경로로 나온다', () => {
    const patches = diff(list('a', 'b'), h('ul', null, li('b', 'B!'), li('a')));
    // 둘을 맞바꾸면 어느 쪽을 옮겨도 MOVE는 하나. 여기서는 a를 그대로 두고 b를 옮긴다
    assert.deepEqual(patches, [
      { type: 'MOVE', parentPath: [], from: 1, index: 0, key: 'b' },
      { type: 'UPDATE_TEXT', path: [1, 0], text: 'B!' }, // b의 이전 위치(1) 기준 경로
    ]);
  });

  test('같은 key인데 태그가 다르면 REPLACE', () => {
    const next = h('ul', null, h('p', { key: 'a' }, 'a'));
    assert.deepEqual(types(diff(h('ul', null, li('a')), next)), ['REPLACE']);
  });

  test('key가 일부만 있으면: key끼리는 key로, key 없는 것끼리는 순서대로 짝짓는다', () => {
    const old = h('ul', null, li('a'), h('li', null, '무명1'), li('b'), h('li', null, '무명2'));
    const next = h('ul', null, li('b'), h('li', null, '무명1'), li('a'), h('li', null, '무명2'));
    const patches = diff(old, next);
    assert.equal(patches.filter((p) => p.type === 'CREATE' || p.type === 'REMOVE').length, 0);
    assert.ok(patches.some((p) => p.type === 'MOVE'));
  });

  test('key가 중복되면 경고하고, 뒤에 나온 같은 key는 key 없는 항목처럼 다룬다', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const patches = diff(list('a', 'a', 'b'), list('a', 'b', 'a'));
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /key "a"가 중복/);
    assert.ok(Array.isArray(patches));
  });
});
