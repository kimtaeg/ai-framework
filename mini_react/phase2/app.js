/**
 * Phase 2 데모 — "스터디 플래너"
 * ------------------------------------------------------------------
 * 컴포넌트 구조 (State 는 루트 App 에만 존재, 자식은 props 만 받는 순수 함수)
 *
 *   App (state: todos, draft, priority, filter, sort, query, timer, ...)
 *    ├─ Header        ← 진행률 (useMemo 로 계산된 stats)
 *    ├─ TodoForm      ← 입력값 + 콜백
 *    ├─ Toolbar       ← 필터/정렬/검색
 *    ├─ TodoList
 *    │   └─ TodoItem* ← key 로 식별 → 정렬 변경 시 MOVE 패치
 *    ├─ FocusTimer    ← useEffect + setInterval (cleanup 으로 정리)
 *    └─ BatchDemo     ← setState 3회 → 렌더 1회 (Batching)
 */

import { h } from '../src/lib/vdom.js';
import { useState, useEffect, useMemo, useCallback, useRef } from '../src/lib/component.js';

export const STORAGE_KEY = 'mini-react-planner:v1';

const PRIORITIES = {
  high: { label: '높음', order: 0 },
  mid: { label: '보통', order: 1 },
  low: { label: '낮음', order: 2 },
};

const FILTERS = [
  ['all', '전체'],
  ['active', '진행 중'],
  ['done', '완료'],
];

const SORTS = [
  ['created', '추가 순'],
  ['priority', '중요도 순'],
  ['title', '이름 순'],
];

export const DEFAULT_TODOS = [
  { id: 1, title: 'Virtual DOM 구조 정리하기', done: true, priority: 'high', createdAt: 1 },
  { id: 2, title: 'Diff 알고리즘 5가지 케이스 테스트', done: false, priority: 'high', createdAt: 2 },
  { id: 3, title: 'useEffect cleanup 동작 이해하기', done: false, priority: 'mid', createdAt: 3 },
  { id: 4, title: '실제 React 와 차이점 조사', done: false, priority: 'low', createdAt: 4 },
];

function loadTodos(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TODOS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_TODOS;
  } catch {
    return DEFAULT_TODOS;
  }
}

// ================================================================
// 자식 컴포넌트 — 모두 Stateless (props → VNode 순수 함수)
// ================================================================

export function Header({ stats }) {
  const pct = stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100);
  return h('header', { class: 'app-header' },
    h('div', null,
      h('h1', null, '스터디 플래너'),
      h('p', { class: 'muted' }, `할 일 ${stats.total}개 · 완료 ${stats.done}개 · 남은 일 ${stats.active}개`),
    ),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div', { class: 'progress-bar', style: { width: `${pct}%` } }),
      h('span', { class: 'progress-label' }, `${pct}%`),
    ),
  );
}

export function TodoForm({ draft, priority, onDraft, onPriority, onSubmit }) {
  const empty = draft.trim() === '';
  return h('form', {
    class: 'todo-form',
    onSubmit: (e) => { e.preventDefault(); onSubmit(); },
  },
    h('input', {
      type: 'text',
      class: 'todo-input',
      placeholder: '할 일을 입력하고 Enter',
      value: draft,
      maxlength: 80,
      'aria-label': '새 할 일',
      onInput: (e) => onDraft(e.target.value),
    }),
    h('select', { class: 'priority-select', value: priority, 'aria-label': '중요도', onChange: (e) => onPriority(e.target.value) },
      Object.entries(PRIORITIES).map(([value, p]) => h('option', { key: value, value }, `중요도 ${p.label}`)),
    ),
    h('button', { type: 'submit', class: 'primary', disabled: empty }, '추가'),
  );
}

export function Toolbar({ filter, sort, query, counts, onFilter, onSort, onQuery }) {
  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': '필터' },
      FILTERS.map(([value, label]) =>
        h('button', {
          key: value,
          type: 'button',
          class: filter === value ? 'seg active' : 'seg',
          'aria-pressed': String(filter === value),
          onClick: () => onFilter(value),
        }, label, h('span', { class: 'count' }, counts[value])),
      ),
    ),
    h('input', {
      type: 'search',
      class: 'search',
      placeholder: '검색',
      value: query,
      'aria-label': '검색',
      onInput: (e) => onQuery(e.target.value),
    }),
    h('select', { class: 'sort-select', value: sort, 'aria-label': '정렬', onChange: (e) => onSort(e.target.value) },
      SORTS.map(([value, label]) => h('option', { key: value, value }, label)),
    ),
  );
}

export function TodoItem({ todo, query, onToggle, onRemove }) {
  return h('li', { class: todo.done ? 'todo done' : 'todo', 'data-id': todo.id },
    h('label', { class: 'todo-main' },
      h('input', { type: 'checkbox', checked: todo.done, onChange: () => onToggle(todo.id) }),
      h('span', { class: 'todo-title' }, highlightText(todo.title, query)),
    ),
    h('span', { class: `chip ${todo.priority}` }, PRIORITIES[todo.priority]?.label ?? todo.priority),
    h('button', { type: 'button', class: 'ghost small danger', 'aria-label': `${todo.title} 삭제`, onClick: () => onRemove(todo.id) }, '삭제'),
  );
}

/** 검색어 부분을 <mark> 로 감싼다 */
export function highlightText(text, query) {
  const q = query.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return [text.slice(0, i), h('mark', null, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

export function TodoList({ todos, query, onToggle, onRemove }) {
  if (todos.length === 0) {
    return h('div', { class: 'empty' }, query ? `"${query}" 에 해당하는 할 일이 없습니다.` : '할 일이 없습니다 🎉');
  }
  return h('ul', { class: 'todo-list' },
    todos.map((todo) => h(TodoItem, { key: todo.id, todo, query, onToggle, onRemove })),
  );
}

export function FocusTimer({ seconds, running, onToggle, onReset }) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return h('section', { class: 'panel timer' },
    h('h2', null, '집중 타이머'),
    h('div', { class: running ? 'clock running' : 'clock' }, `${mm}:${ss}`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onClick: onToggle }, running ? '일시정지' : '시작'),
      h('button', { type: 'button', onClick: onReset, disabled: seconds === 0 && !running }, '초기화'),
    ),
    h('p', { class: 'muted small' }, 'useEffect 로 setInterval 을 등록하고, 멈추면 cleanup 에서 clearInterval 합니다.'),
  );
}

export function BatchDemo({ count, renders, onBatch, onSingle }) {
  return h('section', { class: 'panel batch' },
    h('h2', null, 'Batching 데모'),
    h('div', { class: 'batch-stats' },
      h('div', null, h('b', { class: 'batch-count' }, count), h('span', { class: 'muted' }, '카운트')),
      h('div', null, h('b', { class: 'batch-renders' }, renders), h('span', { class: 'muted' }, '총 렌더 횟수')),
    ),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn-batch', onClick: onBatch }, 'setState × 3'),
      h('button', { type: 'button', class: 'btn-single', onClick: onSingle }, 'setState × 1'),
    ),
    h('p', { class: 'muted small' }, '한 핸들러에서 setState 를 3번 호출해도 microtask 로 모아서 렌더링은 1번만 일어납니다.'),
  );
}

// ================================================================
// 루트 컴포넌트 — 모든 State 와 Hook 은 여기에만 존재
// ================================================================

/**
 * @param {object} props
 * @param {Storage} [props.storage]  localStorage (테스트에서 주입 가능)
 */
/** localStorage 는 사이트 데이터 차단·일부 프라이빗 모드에서 "읽기만 해도" 에러가 난다 → 안전하게 가져오기 */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function App({ storage = defaultStorage() } = {}) {
  const [todos, setTodos] = useState(() => loadTodos(storage));
  const [draft, setDraft] = useState('');
  const [priority, setPriority] = useState('mid');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('created');
  const [query, setQuery] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const renders = useRef(0);
  renders.current += 1;

  // ---- useMemo: todos 가 바뀔 때만 통계를 다시 계산 ----
  const stats = useMemo(() => {
    const done = todos.filter((t) => t.done).length;
    return { total: todos.length, done, active: todos.length - done };
  }, [todos]);

  // ---- useMemo: 필터/검색/정렬 결과. 타이머가 매초 리렌더해도 재계산하지 않는다 ----
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = todos.filter((t) => {
      if (filter === 'active' && t.done) return false;
      if (filter === 'done' && !t.done) return false;
      return !q || t.title.toLowerCase().includes(q);
    });
    const cmp = {
      created: (a, b) => a.createdAt - b.createdAt,
      priority: (a, b) => PRIORITIES[a.priority].order - PRIORITIES[b.priority].order || a.createdAt - b.createdAt,
      title: (a, b) => a.title.localeCompare(b.title, 'ko'),
    }[sort];
    return list.slice().sort(cmp);
  }, [todos, filter, sort, query]);

  // ---- useEffect: todos 가 바뀌면 localStorage 에 저장 ----
  useEffect(() => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch {
      /* 저장 공간 부족 / 프라이빗 모드 → 무시 */
    }
  }, [todos]);

  // ---- useEffect: 남은 일 개수를 탭 제목에 표시 ----
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = stats.active > 0 ? `(${stats.active}) 스터디 플래너` : '스터디 플래너';
    }
  }, [stats.active]);

  // ---- useEffect + cleanup: 타이머 ----
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // ---- 이벤트 핸들러 (useCallback 으로 참조 유지) ----
  const addTodo = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    setTodos((list) => {
      const id = list.reduce((m, t) => Math.max(m, t.id), 0) + 1;
      const createdAt = list.reduce((m, t) => Math.max(m, t.createdAt), 0) + 1;
      return [...list, { id, title, done: false, priority, createdAt }];
    });
    setDraft(''); // 여러 setState → batching 으로 렌더 1회
  }, [draft, priority]);

  const toggleTodo = useCallback((id) => {
    setTodos((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }, []);

  const removeTodo = useCallback((id) => {
    setTodos((list) => list.filter((t) => t.id !== id));
  }, []);

  const clearDone = () => setTodos((list) => list.filter((t) => !t.done));

  const counts = useMemo(() => ({ all: stats.total, active: stats.active, done: stats.done }), [stats]);

  return h('div', { class: 'app' },
    h(Header, { stats }),
    h('div', { class: 'layout' },
      h('section', { class: 'panel main' },
        h(TodoForm, { draft, priority, onDraft: setDraft, onPriority: setPriority, onSubmit: addTodo }),
        h(Toolbar, { filter, sort, query, counts, onFilter: setFilter, onSort: setSort, onQuery: setQuery }),
        h(TodoList, { todos: visible, query, onToggle: toggleTodo, onRemove: removeTodo }),
        stats.done > 0 &&
          h('div', { class: 'footer' },
            h('button', { type: 'button', class: 'ghost small clear-done', onClick: clearDone }, `완료한 일 ${stats.done}개 지우기`),
          ),
      ),
      h('aside', { class: 'side' },
        h(FocusTimer, {
          seconds,
          running,
          onToggle: () => setRunning((r) => !r),
          onReset: () => { setRunning(false); setSeconds(0); },
        }),
        h(BatchDemo, {
          count,
          renders: renders.current,
          onBatch: () => { setCount((c) => c + 1); setCount((c) => c + 1); setCount((c) => c + 1); },
          onSingle: () => setCount((c) => c + 1),
        }),
      ),
    ),
  );
}
