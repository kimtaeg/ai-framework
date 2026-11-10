// 할 일 목록 앱 — 우리 라이브러리(h, useState, useMemo, useEffect)만 사용한다.
//
// 상태는 루트 App에만 있다 (Lifting State Up).
//   App ── useState(todos, input, filter)
//    ├ TodoInput  { value, onInput, onSubmit }      ← props만 받는 순수 함수
//    ├ FilterBar  { filter, counts, onSelect }
//    ├ TodoList   { todos, emptyMessage, onToggle, onDelete }
//    │   └ TodoItem { todo, onToggle, onDelete }
//    └ TodoFooter { remaining, doneCount, onClearDone }
// 데이터는 props로 내려가고, 변경은 App이 내려준 핸들러를 호출해 위로 올라간다.

import { h } from '../src/vdom.js';
import { useState, useMemo, useEffect } from '../src/hooks.js';

export const FILTERS = [
  { key: 'all', label: '전체', matches: () => true },
  { key: 'active', label: '진행 중', matches: (todo) => !todo.done },
  { key: 'done', label: '완료', matches: (todo) => todo.done },
];

const EMPTY_MESSAGES = {
  all: '할 일이 없습니다. 위에서 추가해 보세요.',
  active: '진행 중인 할 일이 없습니다.',
  done: '완료한 할 일이 없습니다.',
};

const MAX_TEXT_LENGTH = 80;

let idSeed = 0;
export function createTodo(text) {
  idSeed += 1;
  return { id: `todo-${Date.now().toString(36)}-${idSeed}`, text, done: false };
}

// localStorage는 사용자가 직접 고치거나 예전 형식이 남아 있을 수 있다.
// 그대로 쓰면 todo.done 같은 접근에서 앱이 시작조차 못 하므로, 올바른 항목만 남기고 빠진 값은 채운다.
export function sanitizeTodos(saved) {
  if (!Array.isArray(saved)) return null;
  const seenIds = new Set();
  return saved
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim() !== '')
    .map((item) => {
      const id = typeof item.id === 'string' && !seenIds.has(item.id) ? item.id : createTodo('').id;
      seenIds.add(id);
      return { id, text: item.text.slice(0, MAX_TEXT_LENGTH), done: item.done === true };
    });
}

// ── 자식 컴포넌트: props → VNode 순수 함수 (Hook 없음) ──────────────

export function TodoInput({ value, onInput, onSubmit }) {
  return h(
    'form',
    { class: 'todo-form', onSubmit },
    h('input', {
      class: 'todo-input',
      name: 'text',
      type: 'text',
      value,
      placeholder: '할 일을 입력하세요',
      'aria-label': '새 할 일',
      maxlength: String(MAX_TEXT_LENGTH),
      autocomplete: 'off',
      onInput,
    }),
    h('button', { class: 'btn btn--primary', type: 'submit', disabled: value.trim() === '' }, '추가')
  );
}

export function FilterBar({ filter, counts, onSelect }) {
  return h(
    'div',
    { class: 'filters', role: 'group', 'aria-label': '필터' },
    FILTERS.map(({ key, label }) =>
      h(
        'button',
        {
          class: key === filter ? 'filter is-active' : 'filter',
          type: 'button',
          'aria-pressed': String(key === filter),
          'data-filter': key,
          onClick: onSelect,
        },
        label,
        h('span', { class: 'filter__count' }, counts[key])
      )
    )
  );
}

export function TodoItem({ todo, onToggle, onDelete }) {
  return h(
    'li',
    { class: todo.done ? 'todo is-done' : 'todo' },
    h(
      'label',
      { class: 'todo__check' },
      h('input', { type: 'checkbox', checked: todo.done, 'data-id': todo.id, onChange: onToggle }),
      h('span', { class: 'todo__text' }, todo.text)
    ),
    h('button', { class: 'todo__delete', type: 'button', 'data-id': todo.id, 'aria-label': `${todo.text} 삭제`, onClick: onDelete }, '✕')
  );
}

export function TodoList({ todos, emptyMessage, onToggle, onDelete }) {
  if (todos.length === 0) return h('p', { class: 'todo-empty' }, emptyMessage);
  return h(
    'ul',
    { class: 'todo-list' },
    todos.map((todo) => h(TodoItem, { todo, onToggle, onDelete }))
  );
}

export function TodoFooter({ remaining, doneCount, onClearDone }) {
  return h(
    'footer',
    { class: 'todo-footer' },
    h('span', { class: 'todo-footer__remaining' }, remaining === 0 ? '모두 끝냈어요 🎉' : `남은 할 일 ${remaining}개`),
    h('button', { class: 'btn btn--ghost', type: 'button', disabled: doneCount === 0, onClick: onClearDone }, '완료 항목 지우기')
  );
}

// ── 루트 컴포넌트: 상태와 Hook은 여기에만 ─────────────────────────

// FunctionComponent는 루트 함수를 인자 없이 부르므로, 초기 목록과 저장소는 클로저로 넘긴다.
export function createApp({ initialTodos = [], storage } = {}) {
  return function App() {
    const [todos, setTodos] = useState(initialTodos);
    const [input, setInput] = useState('');
    const [filter, setFilter] = useState('all');

    // 입력창에 한 글자 칠 때마다 App 전체가 다시 실행되지만, todos·filter가 그대로면 다시 계산하지 않는다
    const visibleTodos = useMemo(() => {
      const { matches } = FILTERS.find(({ key }) => key === filter);
      return todos.filter(matches);
    }, [todos, filter]);

    const counts = useMemo(() => {
      const done = todos.filter((todo) => todo.done).length;
      return { all: todos.length, active: todos.length - done, done };
    }, [todos]);

    // 이벤트 핸들러는 useMemo([])로 한 번만 만든다.
    // 렌더마다 새 함수를 만들면 모든 항목에 onChange·onClick PROPS patch가 생기기 때문이다.
    // 어느 항목인지는 클로저 대신 data-id로 전달하고, 값은 setState(prev => next)로 최신 상태를 받는다.
    const handlers = useMemo(
      () => ({
        input: (event) => setInput(event.currentTarget.value),
        submit: (event) => {
          event.preventDefault();
          const text = (new FormData(event.currentTarget).get('text') ?? '').trim();
          if (text === '') return;
          setTodos((list) => [...list, createTodo(text)]);
          setInput('');
        },
        toggle: (event) => {
          const { id } = event.currentTarget.dataset;
          setTodos((list) => list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
        },
        remove: (event) => {
          const { id } = event.currentTarget.dataset;
          setTodos((list) => list.filter((todo) => todo.id !== id));
        },
        selectFilter: (event) => setFilter(event.currentTarget.dataset.filter),
        clearDone: () => setTodos((list) => list.filter((todo) => !todo.done)),
      }),
      []
    );

    // 화면이 바뀐 뒤에 하는 바깥세상 일
    useEffect(() => {
      document.title = counts.active === 0 ? '모두 완료 · Mini React' : `할 일 ${counts.active}개 남음 · Mini React`;
    }, [counts.active]);

    // storage는 deps에 없다: createApp이 만든 클로저에 고정돼 App이 사는 동안 바뀌지 않기 때문이다
    useEffect(() => {
      storage?.save(todos);
    }, [todos]);

    return h(
      'section',
      { class: 'todo-app' },
      h(TodoInput, { value: input, onInput: handlers.input, onSubmit: handlers.submit }),
      h(FilterBar, { filter, counts, onSelect: handlers.selectFilter }),
      h(TodoList, {
        todos: visibleTodos,
        emptyMessage: EMPTY_MESSAGES[filter],
        onToggle: handlers.toggle,
        onDelete: handlers.remove,
      }),
      h(TodoFooter, { remaining: counts.active, doneCount: counts.done, onClearDone: handlers.clearDone })
    );
  };
}
