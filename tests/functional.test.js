/**
 * 기능 테스트: 실제 페이지와 같은 흐름을 jsdom 에서 재현한다.
 *  - Phase 1 Playground: 로드 → 수정 → Patch → 뒤로/앞으로
 *  - Phase 2 스터디 플래너: 클릭/입력 → 상태 변경 → 부분 업데이트
 */
import './setup.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Playground } from '../phase1/playground.js';
import { createElement, htmlToVNode, childrenToHTML } from '../src/lib/vdom.js';
import { FunctionComponent } from '../src/lib/component.js';
import { App, STORAGE_KEY, DEFAULT_TODOS } from '../phase2/app.js';
import { container, flushMicrotasks, memoryStorage } from './setup.js';

// ================================================================ Phase 1
describe('Phase 1 Playground', () => {
  // 실제 phase1/index.html 의 샘플 HTML 을 그대로 사용
  const page = readFileSync(new URL('../phase1/index.html', import.meta.url), 'utf8');
  const sample = page.match(/<div id="actual" class="sample">([\s\S]*?)<\/div>\s*<div id="overlay"/)[1];

  let actual, testArea, pg, commits;
  beforeEach(() => {
    actual = container(sample);
    testArea = { html: '' };
    commits = [];
    pg = new Playground({
      actualRoot: actual,
      renderTestArea: (v) => { testArea.html = childrenToHTML(v); },
      onCommit: (r) => commits.push(r),
    });
    pg.init();
  });

  const edit = (fn) => pg.patch(htmlToVNode(fn(testArea.html)));

  test('로드 시 실제 영역 → VDOM → 테스트 영역 렌더링', () => {
    assert.ok(testArea.html.includes('<h2>김정글 <small>Frontend Engineer</small></h2>'));
    // 테스트 영역을 그대로 다시 파싱하면 같은 VDOM (변경 없음)
    const r = pg.patch(htmlToVNode(testArea.html));
    assert.equal(r.patches.length, 0);
    assert.equal(pg.history.entries.length, 1, '변경 없으면 히스토리에 쌓지 않음');
  });

  test('Patch: 변경된 텍스트만 실제 영역에 반영 (다른 노드는 그대로)', () => {
    const h2 = actual.querySelector('h2');
    const table = actual.querySelector('table');
    const r = edit((s) => s.replace('김정글', '박정글'));
    assert.deepEqual(r.patches.map((p) => p.type), ['TEXT']);
    assert.equal(r.mutations, 1, 'MutationObserver 기록 1건');
    assert.equal(actual.querySelector('h2'), h2);
    assert.equal(actual.querySelector('table'), table);
    assert.ok(h2.textContent.startsWith('박정글'));
  });

  test('Patch: 속성 변경 / 노드 추가 / 삭제 / 교체 / 이동을 한 번에', () => {
    const r = edit((s) => s
      .replace('data-theme="light"', 'data-theme="dark"')                    // PROPS
      .replace('<li key="hooks">Hooks</li>', '')                                // REMOVE
      .replace('<li key="js">JavaScript</li>', '')                              // (MOVE 를 위해 js 를 뒤로)
      .replace('<li key="vdom">Virtual DOM</li>', '<li key="vdom">Virtual DOM</li><li key="js">JavaScript</li><li key="ts">TypeScript</li>') // MOVE + INSERT
      .replace('<p class="bio">', '<blockquote class="bio">').replace('</b>을 직접 구현하고 있습니다.</p>', '</b>을 직접 구현하고 있습니다.</blockquote>')); // REPLACE
    const kinds = new Set(r.patches.map((p) => p.type));
    for (const k of ['PROPS', 'REMOVE', 'MOVE', 'INSERT', 'REPLACE']) assert.ok(kinds.has(k), `${k} 패치 포함`);
    assert.equal(childrenToHTML(pg.current), testArea.html);
    // 실제 영역 DOM == 새 VDOM 으로 처음부터 그린 DOM
    const fresh = document.createElement('div');
    fresh.append(...pg.current.children.map((c) => createElement(c)));
    assert.equal(actual.innerHTML, fresh.innerHTML);
    assert.deepEqual([...actual.querySelectorAll('.skills li')].map((l) => l.textContent), ['DOM API', 'Virtual DOM', 'JavaScript', 'TypeScript']);
  });

  test('뒤로가기 / 앞으로가기: 실제 영역과 테스트 영역이 함께 바뀐다', () => {
    const initialHTML = actual.innerHTML;
    const initialTest = testArea.html;
    edit((s) => s.replace('92', '100'));
    edit((s) => s.replace('85', '99'));
    assert.equal(pg.history.entries.length, 3);
    const afterHTML = actual.innerHTML;

    pg.back();
    assert.ok(actual.textContent.includes('100') && actual.textContent.includes('85'));
    pg.back();
    assert.equal(actual.innerHTML, initialHTML);
    assert.equal(testArea.html, initialTest);
    assert.equal(pg.back(), null, '처음에서는 더 뒤로 갈 수 없음');

    pg.forward();
    pg.forward();
    assert.equal(actual.innerHTML, afterHTML);
    assert.equal(pg.forward(), null);
  });

  test('뒤로 간 뒤 새로 Patch 하면 원래 미래는 갈래로 남는다 (분기 히스토리)', () => {
    edit((s) => s.replace('92', '1'));
    edit((s) => s.replace('85', '2'));
    pg.back();
    edit((s) => s.replace('알고리즘', '자료구조'));
    assert.equal(pg.history.canForward, false, '새 갈래의 끝이므로 앞으로 갈 곳이 없다');
    assert.equal(pg.history.entries.length, 4, '예전에는 3 — 85→2 기록을 버렸다');
    assert.ok(actual.textContent.includes('자료구조'));
    assert.ok(actual.textContent.includes('85'), '지금 갈래에는 85→2 가 없다');
    assert.equal(pg.history.entries[3].parent, 1, '#1 에서 갈라진 갈래');
    pg.go(2); // 버려지지 않은 원래 갈래로
    assert.ok(!actual.textContent.includes('85') && !actual.textContent.includes('자료구조'));
    pg.back();
    pg.forward(); // 앞으로가기는 마지막으로 다녀온 갈래(#2)를 따라간다
    assert.equal(pg.history.index, 2);
  });

  test('history.go 로 임의 시점 이동', () => {
    edit((s) => s.replace('92', '1'));
    edit((s) => s.replace('92', '1').replace('85', '2'));
    pg.go(0);
    assert.ok(actual.textContent.includes('92'));
    pg.go(2);
    assert.ok(actual.textContent.includes('1') && actual.textContent.includes('2'));
  });

  test('엣지: 전부 지우기 → 복원, 스크립트 삽입 무시', () => {
    edit(() => '');
    assert.equal(actual.childNodes.length, 0);
    edit(() => '<p onclick="alert(1)">x</p><script>window.__pwned = true</script>');
    assert.equal(actual.innerHTML, '<p>x</p>');
    assert.equal(globalThis.window.__pwned, undefined);
    pg.go(0);
    assert.ok(actual.querySelector('.profile'));
  });

  test('엣지: 사용자가 잘못된 HTML 을 입력해도 브라우저 파서 규칙대로 복구', () => {
    edit(() => '<div><p>unclosed<span>x</div><b>bold');
    assert.equal(actual.innerHTML, '<div><p>unclosed<span>x</span></p></div><b>bold</b>');
  });
});

// ================================================================ Phase 2
describe('Phase 2 스터디 플래너', () => {
  let el, comp, storage, commits;

  beforeEach(() => {
    el = container();
    storage = memoryStorage();
    commits = [];
    comp = new FunctionComponent(App, { storage }, { onCommit: (c) => commits.push(c) }).mount(el);
  });

  const titles = () => [...el.querySelectorAll('.todo-title')].map((n) => n.textContent);
  const input = (node, value) => {
    node.value = value;
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const change = (node, value) => {
    if (value !== undefined) node.value = value;
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  test('초기 렌더링: 기본 할 일과 진행률', () => {
    assert.deepEqual(titles(), DEFAULT_TODOS.map((t) => t.title));
    assert.equal(el.querySelector('.progress-label').textContent, '25%');
  });

  test('할 일 추가: 입력 → submit → 목록에 추가, 입력창 비움, 저장', async () => {
    const field = el.querySelector('.todo-input');
    input(field, '  새 할 일  ');
    await flushMicrotasks();
    assert.equal(el.querySelector('.todo-form button').disabled, false);
    el.querySelector('.todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    assert.equal(titles().at(-1), '새 할 일');
    assert.equal(el.querySelector('.todo-input'), field, '입력창 노드는 재사용 (포커스 유지)');
    assert.equal(field.value, '');
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).length, 5, 'useEffect 로 저장');
  });

  test('빈 입력은 추가되지 않는다', async () => {
    input(el.querySelector('.todo-input'), '   ');
    await flushMicrotasks();
    assert.equal(el.querySelector('.todo-form button').disabled, true);
    el.querySelector('.todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    assert.equal(titles().length, 4);
  });

  test('체크 토글 → 진행률 / 클래스만 부분 업데이트', async () => {
    const items = el.querySelectorAll('.todo');
    const before = commits.length;
    change(items[1].querySelector('input'));
    await flushMicrotasks();
    assert.equal(commits.length, before + 1);
    assert.ok(el.querySelectorAll('.todo')[1].classList.contains('done'));
    assert.equal(el.querySelectorAll('.todo')[1], items[1], 'li 노드 재사용');
    assert.equal(el.querySelector('.progress-label').textContent, '50%');
    const types = new Set(commits.at(-1).patches.map((p) => p.type));
    assert.ok(!types.has('REPLACE'), '교체 없이 부분 수정만');
  });

  test('삭제', async () => {
    el.querySelectorAll('.todo')[0].querySelector('button').click();
    await flushMicrotasks();
    assert.equal(titles().length, 3);
    assert.ok(!titles().includes(DEFAULT_TODOS[0].title));
  });

  test('필터: 진행 중 / 완료', async () => {
    el.querySelectorAll('.seg')[2].click(); // 완료
    await flushMicrotasks();
    assert.deepEqual(titles(), [DEFAULT_TODOS[0].title]);
    el.querySelectorAll('.seg')[1].click(); // 진행 중
    await flushMicrotasks();
    assert.equal(titles().length, 3);
  });

  test('검색: 일치 부분을 <mark> 로 강조, 결과 없으면 안내 문구', async () => {
    input(el.querySelector('.search'), 'diff');
    await flushMicrotasks();
    assert.equal(titles().length, 1);
    assert.equal(el.querySelector('mark').textContent, 'Diff');
    input(el.querySelector('.search'), 'zzz');
    await flushMicrotasks();
    assert.ok(el.querySelector('.empty').textContent.includes('zzz'));
  });

  test('정렬 변경은 노드를 재생성하지 않고 MOVE 로 재배치', async () => {
    const before = [...el.querySelectorAll('.todo')];
    change(el.querySelector('.sort-select'), 'title');
    await flushMicrotasks();
    const after = [...el.querySelectorAll('.todo')];
    assert.deepEqual(new Set(after), new Set(before), '같은 li 노드들');
    assert.ok(commits.at(-1).patches.some((p) => p.type === 'MOVE'));
    assert.deepEqual(titles(), [...DEFAULT_TODOS.map((t) => t.title)].sort((a, b) => a.localeCompare(b, 'ko')));
  });

  test('Batching 데모: setState ×3 → 카운트 +3, 렌더 +1', async () => {
    const r0 = comp.renderCount;
    el.querySelector('.btn-batch').click();
    await flushMicrotasks();
    assert.equal(el.querySelector('.batch-count').textContent, '3');
    assert.equal(comp.renderCount, r0 + 1);
  });

  test('타이머: useEffect 로 interval 등록, 정지 시 cleanup', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const btn = () => el.querySelector('.timer .primary');
    btn().click();
    await flushMicrotasks();
    t.mock.timers.tick(3000);
    await flushMicrotasks();
    assert.equal(el.querySelector('.clock').textContent, '00:03');
    btn().click(); // 정지 → cleanup 으로 clearInterval
    await flushMicrotasks();
    t.mock.timers.tick(5000);
    await flushMicrotasks();
    assert.equal(el.querySelector('.clock').textContent, '00:03');
  });

  test('완료한 일 지우기 버튼은 완료 항목이 있을 때만 보인다', async () => {
    el.querySelector('.clear-done').click();
    await flushMicrotasks();
    assert.equal(el.querySelector('.clear-done'), null);
    assert.equal(titles().length, 3);
  });

  test('저장된 데이터로 복원 / 손상된 데이터는 기본값', () => {
    const saved = memoryStorage({ [STORAGE_KEY]: JSON.stringify([{ id: 9, title: '복원됨', done: false, priority: 'low', createdAt: 1 }]) });
    const el2 = container();
    new FunctionComponent(App, { storage: saved }).mount(el2);
    assert.equal(el2.querySelector('.todo-title').textContent, '복원됨');

    const broken = memoryStorage({ [STORAGE_KEY]: '{not json' });
    const el3 = container();
    new FunctionComponent(App, { storage: broken }).mount(el3);
    assert.equal(el3.querySelectorAll('.todo').length, 4);
  });
});

describe('Phase 2: 저장소가 막힌 환경', () => {
  test('localStorage 를 읽기만 해도 에러가 나는 환경에서도 기본 데이터로 동작', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage blocked'); } });
    try {
      const el = container();
      assert.doesNotThrow(() => new FunctionComponent(App).mount(el));
      assert.equal(el.querySelectorAll('.todo').length, DEFAULT_TODOS.length);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
