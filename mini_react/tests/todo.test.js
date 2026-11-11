import { makeContainer } from './setup.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/core/vdom.js';
import { expand, FunctionComponent } from '../src/core/component.js';
import { createApp, sanitizeTodos, TodoItem, TodoList, FilterBar, TodoInput, TodoFooter } from '../todo/app.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TODOS = [
  { id: 'a', text: '빨래', done: true },
  { id: 'b', text: '청소', done: false },
  { id: 'c', text: '장보기', done: false },
];

function mountApp(initialTodos = TODOS) {
  const container = makeContainer(); // 문서에 붙여야 FormData·이벤트가 실제처럼 동작한다
  const saved = [];
  const renders = [];
  const component = new FunctionComponent(createApp({ initialTodos, storage: { save: (todos) => saved.push(todos) } }), container, {
    onRender: (info) => renders.push(info),
  }).mount();
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  const item = (text) => $$('.todo').find((li) => li.textContent.includes(text));
  return {
    container, component, saved, renders, $,
    texts: () => $$('.todo__text').map((el) => el.textContent),
    item,
    async type(text) {
      const input = $('.todo-input');
      input.value = text;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flush();
    },
    async submit() {
      $('.todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    },
    async toggle(text) {
      item(text).querySelector('input').click();
      await flush();
    },
    async remove(text) {
      item(text).querySelector('.todo__delete').click();
      await flush();
    },
    async filter(key) {
      $(`[data-filter="${key}"]`).click();
      await flush();
    },
  };
}

beforeEach(() => {
  document.title = '';
});

describe('할 일 앱 동작', () => {
  test('첫 화면: 목록, 필터 개수, 남은 개수, 문서 제목', () => {
    const app = mountApp();
    assert.deepEqual(app.texts(), ['빨래', '청소', '장보기']);
    assert.equal(app.$('[data-filter="all"]').textContent, '전체3');
    assert.equal(app.$('.todo-footer__remaining').textContent, '남은 할 일 2개');
    assert.equal(document.title, '할 일 2개 남음 · Mini React');
  });

  test('추가: 제출하면 목록 끝에 붙고 입력창이 비워진다 (공백만은 무시)', async () => {
    const app = mountApp();
    await app.type('   ');
    assert.equal(app.$('.todo-form button').disabled, true);
    await app.submit();
    assert.equal(app.texts().length, 3);

    await app.type('  운동  ');
    assert.equal(app.$('.todo-form button').disabled, false);
    await app.submit();
    assert.deepEqual(app.texts(), ['빨래', '청소', '장보기', '운동']);
    assert.equal(app.$('.todo-input').value, '');
    assert.equal(document.title, '할 일 3개 남음 · Mini React');
  });

  test('완료 토글: 취소선 클래스·체크·남은 개수가 바뀐다', async () => {
    const app = mountApp();
    await app.toggle('청소');
    assert.equal(app.item('청소').className, 'todo is-done');
    assert.equal(app.item('청소').querySelector('input').checked, true);
    assert.equal(app.$('.todo-footer__remaining').textContent, '남은 할 일 1개');
  });

  test('필터: 진행 중 / 완료 / 전체', async () => {
    const app = mountApp();
    await app.filter('active');
    assert.deepEqual(app.texts(), ['청소', '장보기']);
    assert.equal(app.$('[data-filter="active"]').getAttribute('aria-pressed'), 'true');
    await app.filter('done');
    assert.deepEqual(app.texts(), ['빨래']);
    await app.filter('all');
    assert.equal(app.texts().length, 3);
  });

  test('완료 항목 지우기, 모두 끝나면 안내 문구와 제목', async () => {
    const app = mountApp();
    app.$('.todo-footer .btn').click();
    await flush();
    assert.deepEqual(app.texts(), ['청소', '장보기']);
    await app.toggle('청소');
    await app.toggle('장보기');
    assert.equal(app.$('.todo-footer__remaining').textContent, '모두 끝냈어요 🎉');
    assert.equal(document.title, '모두 완료 · Mini React');
  });

  test('빈 목록: 필터에 맞는 안내 문구, 완료 지우기 비활성', async () => {
    const app = mountApp([]);
    assert.equal(app.$('.todo-empty').textContent, '할 일이 없습니다. 위에서 추가해 보세요.');
    assert.equal(app.$('.todo-footer .btn').disabled, true);
    await app.filter('done');
    assert.equal(app.$('.todo-empty').textContent, '완료한 할 일이 없습니다.');
  });
});

describe('patch: 바뀐 곳만', () => {
  test('가운데 항목 삭제 → key 덕분에 그 항목 REMOVE 1개, 뒤 항목 DOM은 재사용', async () => {
    const app = mountApp();
    const last = app.item('장보기');
    await app.remove('청소');
    assert.deepEqual(app.texts(), ['빨래', '장보기']);
    assert.equal(app.item('장보기'), last);
    const { patches } = app.renders.at(-1);
    assert.equal(patches.filter((p) => p.type === 'REMOVE').length, 1);
    assert.equal(patches.filter((p) => p.type === 'REPLACE' || p.type === 'CREATE').length, 0);
  });

  test('한 글자 입력: 핸들러를 고정해 두어 바뀌는 속성은 입력창 value와 추가 버튼 disabled뿐', async () => {
    const app = mountApp();
    await app.type('운');
    const changed = app.renders.at(-1).patches.flatMap((p) => (p.type === 'UPDATE_PROPS' ? Object.keys(p.set) : [p.type]));
    assert.deepEqual(changed.sort(), ['disabled', 'value']);
  });

  test('토글 한 번: 노드를 새로 만들거나 지우지 않는다', async () => {
    const app = mountApp();
    await app.toggle('청소');
    const types = app.renders.at(-1).patches.map((p) => p.type);
    assert.deepEqual(types.filter((t) => ['CREATE', 'REMOVE', 'REPLACE'].includes(t)), []);
  });

  test('마지막 하나를 지우면 목록 대신 안내 문구 (ul → p REPLACE)', async () => {
    const app = mountApp([TODOS[0]]);
    await app.remove('빨래');
    assert.equal(app.$('.todo-list'), null);
    assert.ok(app.$('.todo-empty'));
    assert.ok(app.renders.at(-1).patches.some((p) => p.type === 'REPLACE'));
  });

  test('todos가 바뀔 때만 저장 (입력·필터 변경은 저장 안 함)', async () => {
    const app = mountApp();
    assert.equal(app.saved.length, 1);
    await app.type('운');
    await app.filter('done');
    assert.equal(app.saved.length, 1);
    await app.toggle('빨래');
    assert.equal(app.saved.length, 2);
    assert.equal(app.saved[1].find((t) => t.id === 'a').done, false);
  });
});

describe('빠른 연속 클릭', () => {
  test('같은 틱에 체크를 두 번 누르면 원래대로, 렌더는 한 번', async () => {
    const app = mountApp();
    const box = app.item('청소').querySelector('input');
    box.click();
    box.click();
    await flush();
    assert.equal(app.item('청소').className, 'todo');
    assert.equal(app.component.renderCount, 2);
    assert.equal(app.component.lastBatchSize, 2);
  });

  test('같은 틱에 같은 삭제 버튼을 두 번 눌러도 하나만 지워진다', async () => {
    const app = mountApp();
    const button = app.item('빨래').querySelector('.todo__delete');
    button.click();
    button.click();
    await flush();
    assert.deepEqual(app.texts(), ['청소', '장보기']);
  });

  test('여러 틱에 걸쳐 빠르게 추가해도 순서대로 모두 들어간다', async () => {
    const app = mountApp([]);
    for (const text of ['1', '2', '3', '4', '5']) {
      await app.type(text);
      await app.submit();
    }
    assert.deepEqual(app.texts(), ['1', '2', '3', '4', '5']);
  });
});

describe('저장 데이터 정리 (sanitizeTodos)', () => {
  test('배열이 아니면 null (샘플로 시작)', () => {
    assert.equal(sanitizeTodos(null), null);
    assert.equal(sanitizeTodos({ a: 1 }), null);
  });

  test('깨진 항목은 버리고, 빠진 값은 채우고, 중복 id는 새로 만든다', () => {
    const result = sanitizeTodos([null, 'x', { text: 1 }, { text: '   ' }, { id: 'a', text: '정상', done: true }, { id: 'a', text: '중복 id', done: 'yes' }, { text: 'id 없음' }]);
    assert.deepEqual(result.map(({ text, done }) => ({ text, done })), [
      { text: '정상', done: true },
      { text: '중복 id', done: false },
      { text: 'id 없음', done: false },
    ]);
    assert.equal(new Set(result.map((t) => t.id)).size, 3);
  });
});

describe('자식 컴포넌트는 props만 받는 순수 함수', () => {
  test('Hook 없이 렌더 밖에서 펼쳐도 에러 없음, 같은 props면 같은 VNode', () => {
    const noop = () => {};
    assert.doesNotThrow(() => expand(h('div', null,
      h(TodoInput, { value: '', onInput: noop, onSubmit: noop }),
      h(FilterBar, { filter: 'all', counts: { all: 1, active: 1, done: 0 }, onSelect: noop }),
      h(TodoList, { todos: TODOS, emptyMessage: '', onToggle: noop, onDelete: noop }),
      h(TodoFooter, { remaining: 1, doneCount: 0, onClearDone: noop }))));
    const props = { todo: TODOS[0], onToggle: noop, onDelete: noop };
    assert.deepEqual(expand(h(TodoItem, props)), expand(h(TodoItem, props)));
  });
});
