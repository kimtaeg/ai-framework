import { describe, it, expect, beforeEach } from 'vitest';
import { h } from '../src/vdom.js';
import { expand, FunctionComponent } from '../src/component.js';
import { createApp, TodoItem, TodoList, FilterBar, TodoInput, TodoFooter } from '../phase2/app.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TODOS = [
  { id: 'a', text: '빨래', done: true },
  { id: 'b', text: '청소', done: false },
  { id: 'c', text: '장보기', done: false },
];

function mountApp(initialTodos = TODOS) {
  const container = document.createElement('div');
  document.body.replaceChildren(container); // FormData·이벤트가 실제 문서처럼 동작하도록 붙인다
  const saved = [];
  const storage = { save: (todos) => saved.push(todos) };
  const renders = [];
  const component = new FunctionComponent(createApp({ initialTodos, storage }), container, {
    onRender: (info) => renders.push(info),
  }).mount();

  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  return {
    container,
    component,
    saved,
    renders,
    texts: () => $$('.todo__text').map((el) => el.textContent),
    type: async (text) => {
      const input = $('.todo-input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    },
    submit: async () => {
      $('.todo-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    },
    toggle: async (text) => {
      $$('.todo').find((li) => li.textContent.includes(text)).querySelector('input').click();
      await flush();
    },
    remove: async (text) => {
      $$('.todo').find((li) => li.textContent.includes(text)).querySelector('.todo__delete').click();
      await flush();
    },
    filter: async (key) => {
      $(`[data-filter="${key}"]`).click();
      await flush();
    },
    $,
  };
}

beforeEach(() => {
  document.title = '';
});

describe('할 일 앱 동작', () => {
  it('첫 화면: 목록, 필터 개수, 남은 개수, 문서 제목', () => {
    const app = mountApp();
    expect(app.texts()).toEqual(['빨래', '청소', '장보기']);
    expect(app.$('[data-filter="all"]').textContent).toBe('전체3');
    expect(app.$('.todo-footer__remaining').textContent).toBe('남은 할 일 2개');
    expect(document.title).toBe('할 일 2개 남음 · Mini React');
  });

  it('추가: 입력 → 제출하면 목록 끝에 붙고 입력창이 비워진다 (공백만은 무시)', async () => {
    const app = mountApp();
    await app.type('   ');
    expect(app.$('.todo-form button').disabled).toBe(true);
    await app.submit();
    expect(app.texts()).toHaveLength(3);

    await app.type('  운동  ');
    expect(app.$('.todo-form button').disabled).toBe(false);
    await app.submit();

    expect(app.texts()).toEqual(['빨래', '청소', '장보기', '운동']);
    expect(app.$('.todo-input').value).toBe('');
    expect(document.title).toBe('할 일 3개 남음 · Mini React');
  });

  it('완료 토글: 체크하면 취소선 클래스와 개수가 바뀐다', async () => {
    const app = mountApp();
    await app.toggle('청소');
    const item = [...app.container.querySelectorAll('.todo')].find((li) => li.textContent.includes('청소'));
    expect(item.className).toBe('todo is-done');
    expect(item.querySelector('input').checked).toBe(true);
    expect(app.$('.todo-footer__remaining').textContent).toBe('남은 할 일 1개');
  });

  it('삭제', async () => {
    const app = mountApp();
    await app.remove('청소');
    expect(app.texts()).toEqual(['빨래', '장보기']);
  });

  it('필터: 진행 중 / 완료 / 전체', async () => {
    const app = mountApp();
    await app.filter('active');
    expect(app.texts()).toEqual(['청소', '장보기']);
    expect(app.$('[data-filter="active"]').getAttribute('aria-pressed')).toBe('true');

    await app.filter('done');
    expect(app.texts()).toEqual(['빨래']);

    await app.filter('all');
    expect(app.texts()).toHaveLength(3);
  });

  it('완료 항목 지우기, 모두 끝나면 안내 문구와 제목', async () => {
    const app = mountApp();
    await app.$('.todo-footer .btn').click();
    await flush();
    expect(app.texts()).toEqual(['청소', '장보기']);

    await app.toggle('청소');
    await app.toggle('장보기');
    expect(app.$('.todo-footer__remaining').textContent).toBe('모두 끝냈어요 🎉');
    expect(document.title).toBe('모두 완료 · Mini React');
  });

  it('빈 목록이면 필터에 맞는 안내 문구', async () => {
    const app = mountApp([]);
    expect(app.$('.todo-empty').textContent).toBe('할 일이 없습니다. 위에서 추가해 보세요.');
    await app.filter('done');
    expect(app.$('.todo-empty').textContent).toBe('완료한 할 일이 없습니다.');
  });
});

describe('effect와 patch', () => {
  it('todos가 바뀔 때만 저장한다 (입력·필터 변경은 저장 안 함)', async () => {
    const app = mountApp();
    expect(app.saved).toHaveLength(1); // 첫 렌더
    await app.type('운');
    await app.filter('done');
    expect(app.saved).toHaveLength(1);
    await app.toggle('빨래');
    expect(app.saved).toHaveLength(2);
    expect(app.saved[1].find((t) => t.id === 'a').done).toBe(false);
  });

  it('한 글자 입력: 핸들러를 고정해 두어 항목들에는 patch가 없다', async () => {
    const app = mountApp();
    await app.type('운');
    const { patches } = app.renders.at(-1);
    // 입력창 value와 추가 버튼 disabled만 바뀐다 (렌더마다 새 핸들러였다면 항목마다 PROPS가 생김)
    expect(patches.map((p) => p.changes.map((c) => c.key)).flat()).toEqual(['value', 'disabled']);
  });

  it('토글 한 번: 해당 항목의 class·checked와 개수 텍스트만 바뀐다', async () => {
    const app = mountApp();
    await app.toggle('청소');
    const types = app.renders.at(-1).patches.map((p) => p.type);
    expect(types.filter((t) => t === 'CREATE' || t === 'REMOVE' || t === 'REPLACE')).toEqual([]);
    expect(app.renders.at(-1).batchSize).toBe(1);
  });
});

describe('자식 컴포넌트는 props만 받는 순수 함수', () => {
  it('Hook 없이 단독으로 펼칠 수 있다 (렌더 밖에서 호출해도 에러 없음)', () => {
    const noop = () => {};
    expect(() =>
      expand(
        h('div', null,
          h(TodoInput, { value: '', onInput: noop, onSubmit: noop }),
          h(FilterBar, { filter: 'all', counts: { all: 1, active: 1, done: 0 }, onSelect: noop }),
          h(TodoList, { todos: TODOS, emptyMessage: '', onToggle: noop, onDelete: noop }),
          h(TodoFooter, { remaining: 1, doneCount: 0, onClearDone: noop }))
      )
    ).not.toThrow();
  });

  it('같은 props면 같은 VNode', () => {
    const props = { todo: TODOS[0], onToggle: () => {}, onDelete: () => {} };
    expect(expand(h(TodoItem, props))).toEqual(expand(h(TodoItem, props)));
  });
});
