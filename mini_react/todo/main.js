// 할 일 앱 마운트 + 디버그 패널
//
// 디버그 패널은 앱 바깥에 둔다. 렌더 횟수를 앱의 상태(useState)에 넣으면
// 그 setState가 또 렌더를 일으켜 끝없이 다시 그려지기 때문이다.
// 앱의 onRender 콜백으로 정보를 받고, 앱 영역만 감시하는 MutationObserver로 바뀐 DOM을 센다.

import { h, createElement } from '../src/core/vdom.js';
import { expand, FunctionComponent } from '../src/core/component.js';
import { OBSERVE_ALL, summarizeDeep } from '../src/utils/domStats.js';
import { createApp, createTodo, sanitizeTodos } from './app.js';

const STORAGE_KEY = 'mini-react-todos';
const RECENT_RENDER_LIMIT = 6;
const SAMPLE_TODOS = ['VNode와 diff/patch 만들기', 'useState로 상태 붙이기', 'Batching 비교하기'];

const appRoot = document.getElementById('app');
const debugRoot = document.getElementById('debug');
const resetButton = document.getElementById('btn-reset');

// ── 저장소 (localStorage가 막혀 있어도 앱은 동작하게) ───────────────

const storage = {
  load() {
    try {
      // 깨진 항목은 버리고 올바른 항목만 남긴다 (배열이 아니면 null → 샘플로 시작)
      return sanitizeTodos(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      return null;
    }
  },
  save(todos) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch {
      // 저장 실패는 앱 동작에 영향을 주지 않는다
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 무시
    }
  },
};

function createSampleTodos() {
  return SAMPLE_TODOS.map((text, i) => ({ ...createTodo(text), done: i === 0 }));
}

// ── 디버그 패널 (순수 함수 컴포넌트, 상태 없음) ─────────────────────

function describePath(tree, path) {
  const names = [];
  let node = tree;
  for (const i of path) {
    node = node?.children?.[i];
    names.push(node ? `${typeof node === 'string' ? '#text' : node.type}[${i}]` : `[${i}]`);
  }
  return names.length === 0 ? (tree?.type ?? 'root') : names.join(' › ');
}

function describeValue(value) {
  if (typeof value === 'function') return '핸들러';
  if (value === undefined) return '없음';
  return JSON.stringify(value);
}

const preview = (vnode) => (typeof vnode === 'string' ? `"${vnode}"` : `<${vnode.type}>`);

// patch가 가리키는 노드의 경로 (이전 트리 기준). CREATE·MOVE는 부모 경로 + 새 위치
function patchPath(patch) {
  return patch.path ?? [...(patch.parentPath ?? []), patch.index];
}

function describePatch(patch) {
  switch (patch.type) {
    case 'CREATE':
      return `+ ${preview(patch.vnode)} (${patch.index}번 자리)`;
    case 'REMOVE':
      return '− 삭제';
    case 'REPLACE':
      return `→ ${preview(patch.vnode)}`;
    case 'UPDATE_TEXT':
      return `"${patch.text}"`;
    case 'UPDATE_PROPS':
      return [
        ...Object.entries(patch.set).map(([key, value]) => `${key} = ${describeValue(value)}`),
        ...patch.remove.map((key) => `${key} 삭제`),
      ].join(', ');
    case 'MOVE':
      return `${patch.from}번 → ${patch.index}번`;
    default:
      return '';
  }
}

const TAG_CLASS = { CREATE: 'create', REMOVE: 'remove', REPLACE: 'replace', UPDATE_TEXT: 'text', UPDATE_PROPS: 'props', MOVE: 'move' };

function Stat({ label, value, hint }) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, label), h('strong', { class: 'stat__value' }, value), hint ? h('span', { class: 'stat__hint' }, hint) : null);
}

function PatchList({ patches, tree }) {
  if (patches.length === 0) return h('p', { class: 'debug-empty' }, '이번 렌더에서는 바뀐 것이 없습니다.');
  return h(
    'ol',
    { class: 'patch-list' },
    patches.map((patch) =>
      h(
        'li',
        { class: 'patch' },
        h('span', { class: `tag tag--${TAG_CLASS[patch.type]}` }, patch.type),
        h('code', { class: 'patch__path' }, describePath(tree, patchPath(patch))),
        h('span', { class: 'patch__detail' }, describePatch(patch))
      )
    )
  );
}

function DebugPanel({ latest, recent }) {
  if (!latest) return h('p', { class: 'debug-empty' }, '렌더 정보를 기다리는 중…');
  const { renderCount, type, batchSize, patches, mutations, tree } = latest;
  return h(
    'div',
    { class: 'debug' },
    h(
      'div',
      { class: 'stats' },
      h(Stat, { label: '렌더 횟수', value: renderCount, hint: type === 'mount' ? '첫 렌더' : `setState ${batchSize}번 묶음` }),
      h(Stat, { label: '이번 patch', value: patches.length }),
      h(Stat, {
        label: '바뀐 DOM 노드',
        value: mutations.total,
        hint: `추가 ${mutations.added} · 삭제 ${mutations.removed} · 속성 ${mutations.attributes} · 텍스트 ${mutations.texts}`,
      })
    ),
    h('h3', { class: 'debug__title' }, '이번 patch 목록'),
    type === 'mount' ? h('p', { class: 'debug-empty' }, '첫 렌더는 diff 없이 전체를 그립니다.') : h(PatchList, { patches, tree }),
    h('h3', { class: 'debug__title' }, '최근 렌더'),
    h(
      'ol',
      { class: 'render-log' },
      recent.map((entry) =>
        h(
          'li',
          null,
          h('span', { class: 'render-log__count' }, `#${entry.renderCount}`),
          h('span', null, entry.type === 'mount' ? 'mount' : `patch ${entry.patches.length}개`),
          h('span', { class: 'render-log__dom' }, `DOM ${entry.mutations.total}`)
        )
      )
    )
  );
}

// ── 연결 ────────────────────────────────────────────────────────

// 콜백은 비워 두고 onRender에서 takeRecords()로만 꺼낸다 (렌더마다 그 렌더의 변경만 세기 위해).
// 앱 영역과 수명이 같은 페이지 단위 객체라 disconnect하지 않는다. 초기화(unmount → mount)해도 같은 appRoot를 계속 본다.
const observer = new MutationObserver(() => {});
observer.observe(appRoot, OBSERVE_ALL);

let component = null;
let recent = [];
let previousTree = null; // patch 경로는 "이전 트리" 기준이라, 경로를 태그 이름으로 풀 때 이전 VNode가 필요하다

function handleRender(info) {
  // onRender는 patch 직후 같은 흐름에서 불리므로 takeRecords로 이번 렌더의 DOM 변경만 꺼낼 수 있다.
  // 붙거나 떨어진 노드는 그 안의 자식까지 센다 (summarizeDeep)
  const mutations = summarizeDeep(observer.takeRecords());
  const latest = { ...info, patches: info.patches ?? [], mutations, tree: previousTree };
  previousTree = component.vnode;
  recent = [latest, ...recent].slice(0, RECENT_RENDER_LIMIT);
  debugRoot.replaceChildren(createElement(expand(h(DebugPanel, { latest, recent }))));
}

function start(initialTodos) {
  recent = [];
  previousTree = null;
  observer.takeRecords();
  component = new FunctionComponent(createApp({ initialTodos, storage }), appRoot, { onRender: handleRender });
  component.mount();
}

resetButton.addEventListener('click', () => {
  component.unmount(); // effect cleanup + 화면 비우기
  storage.clear();
  start(createSampleTodos());
});

start(storage.load() ?? createSampleTodos());
