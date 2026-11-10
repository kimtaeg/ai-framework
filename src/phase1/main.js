// Phase 1 검증 페이지: 실제 영역 · 테스트 영역 · Patch · 뒤로/앞으로 · 로그
//
// 흐름
//   [로드]   실제 영역 샘플 HTML → domToVNode → (실제 영역을 VNode로 다시 그려 정리) → 테스트 영역에 그림 → History에 저장
//   [Patch]  테스트 영역(textarea) → parseHTML → 새 VNode → diff(이전, 새) → applyPatches(실제 영역) → History에 저장
//   [뒤로]   History의 이전 VNode → diff(지금, 그것) → applyPatches(실제 영역) → 테스트 영역도 그 VNode로

import { createElement, domToVNode } from '../core/vdom.js';
import { diff } from '../core/diff.js';
import { applyPatches } from '../core/patch.js';
import { History } from './history.js';
import { parseHTML, toHTML } from './html.js';

const $ = (id) => document.getElementById(id);

const actual = $('actual');
const editable = $('editable');
const source = $('source');
const sourceError = $('source-error');

const FLASH_DURATION_MS = 900;
const PATCH_TAG = { CREATE: 'create', REMOVE: 'remove', REPLACE: 'replace', UPDATE_PROPS: 'props', UPDATE_TEXT: 'text', MOVE: 'move' };
const COUNT_LABELS = [
  ['created', 'CREATE 노드 추가'],
  ['removed', 'REMOVE 노드 삭제'],
  ['replaced', 'REPLACE 통째 교체'],
  ['propsUpdated', 'UPDATE_PROPS 속성 변경'],
  ['textUpdated', 'UPDATE_TEXT 텍스트 변경'],
  ['moved', 'MOVE 순서 변경'],
];

const history = new History();

// 실제 영역의 DOM 변경을 감시한다. patch 직전·직후에 takeRecords()로 꺼내 "이번 Patch가 만든 변경"만 센다.
const observer = new MutationObserver(() => {});

// ── 테스트 영역: contenteditable ↔ textarea 동기화 ─────────────

function showInTestArea(vnode) {
  editable.replaceChildren(createElement(vnode));
  source.value = toHTML(vnode);
  hideError();
}

// textarea를 고치면: HTML을 읽어 contenteditable을 다시 그린다
function handleSourceInput() {
  try {
    editable.replaceChildren(createElement(parseHTML(source.value)));
    hideError();
  } catch (error) {
    showError(error);
  }
}

// contenteditable을 고치면: 그 DOM을 VNode로 읽어 textarea를 맞춘다
function handleEditableInput() {
  const roots = [...editable.childNodes].map(domToVNode).filter((vnode) => vnode !== null);
  if (roots.length !== 1 || typeof roots[0] === 'string') {
    showError(new Error('테스트 영역에는 루트 요소가 하나 있어야 합니다.'));
    return;
  }
  source.value = toHTML(roots[0]);
  hideError();
}

function showError(error) {
  sourceError.textContent = error.message;
  sourceError.hidden = false;
  source.setAttribute('aria-invalid', 'true');
}

function hideError() {
  sourceError.hidden = true;
  source.removeAttribute('aria-invalid');
}

// ── Patch · 뒤로 · 앞으로 ─────────────────────────────

function handlePatch() {
  let next;
  try {
    next = parseHTML(source.value); // textarea는 항상 contenteditable과 맞춰져 있으므로 이것을 기준으로 삼는다
  } catch (error) {
    showError(error);
    addLog('ERROR', `Patch 취소 — ${error.message}`);
    return;
  }

  const patches = diff(history.current(), next);
  if (patches.length === 0) {
    showResult('Patch', [], null, null);
    addLog('SKIP', '바뀐 것이 없어 기록을 추가하지 않음');
    return;
  }

  const { counts, mutations } = applyAndMeasure(patches);
  history.push(next); // 과거 시점에서 Patch했다면 그 뒤 기록은 History가 지운다
  showResult('Patch', patches, counts, mutations);
  syncHistoryControls();
  addLog('PATCH', `patch ${patches.length}개 적용 → 기록 ${positionText()}`);
}

function handleMove(direction) {
  const prev = history.current();
  const next = direction === 'back' ? history.back() : history.forward();
  if (next === prev) return; // 처음·끝 (버튼이 비활성이라 보통 오지 않음)

  const patches = diff(prev, next);
  const { counts, mutations } = applyAndMeasure(patches);
  showInTestArea(next); // 테스트 영역도 그 시점의 VNode로
  showResult(direction === 'back' ? '뒤로가기' : '앞으로가기', patches, counts, mutations);
  syncHistoryControls();
  addLog(direction === 'back' ? 'BACK' : 'FORWARD', `patch ${patches.length}개 적용 → 기록 ${positionText()}`);
}

// patch를 실제 영역에 적용하면서, 바뀐 노드를 깜빡이고 MutationObserver로 실제 DOM 변경을 센다
function applyAndMeasure(patches) {
  observer.takeRecords(); // 이전에 쌓인 기록은 버린다 (이번 Patch와 섞이지 않게)
  const counts = applyPatches(actual, patches, { onApply: flash });
  const mutations = summarizeMutations(observer.takeRecords());
  return { counts, mutations };
}

// MutationRecord → 실제로 바뀐 노드 수 (같은 노드가 여러 번 바뀌어도 한 번만 센다)
function summarizeMutations(records) {
  const added = new Set();
  const removed = new Set();
  const attributes = new Set();
  const texts = new Set();
  for (const record of records) {
    if (record.type === 'childList') {
      record.addedNodes.forEach((node) => added.add(node));
      record.removedNodes.forEach((node) => removed.add(node));
    } else if (record.type === 'attributes') {
      attributes.add(record.target);
    } else if (record.type === 'characterData') {
      texts.add(record.target);
    }
  }
  const touched = new Set([...added, ...removed, ...attributes, ...texts]);
  return { added: added.size, removed: removed.size, attributes: attributes.size, texts: texts.size, total: touched.size };
}

// 바뀐 노드에 잠깐 노란 테두리. 속성을 건드리지 않도록 Web Animations API로만 그린다
// (class를 붙였다 떼면 그것도 DOM 변경이라 MutationObserver 숫자가 흐려진다)
function flash(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  el?.animate?.(
    [{ outline: '3px solid #f59e0b', outlineOffset: '2px', backgroundColor: 'rgba(245, 158, 11, 0.18)' }, { outline: '3px solid transparent', outlineOffset: '2px' }],
    { duration: FLASH_DURATION_MS, easing: 'ease-out' }
  );
}

// ── 화면 갱신 ─────────────────────────────────────────

function positionText() {
  const { index, total } = history.position();
  return `${index} / ${total}`;
}

function syncHistoryControls() {
  $('btn-back').disabled = !history.canBack();
  $('btn-forward').disabled = !history.canForward();
  $('history-pos').textContent = positionText();
}

function describePatch(patch) {
  const path = (p) => `[${p.join(', ')}]`;
  const preview = (vnode) => (typeof vnode === 'string' ? `"${vnode}"` : `<${vnode.type}${vnode.key ? ` key="${vnode.key}"` : ''}>`);
  switch (patch.type) {
    case 'CREATE': return [`부모 ${patch.parentPath ? path(patch.parentPath) : '컨테이너'}의 ${patch.index}번에`, `+ ${preview(patch.vnode)}`];
    case 'REMOVE': return [path(patch.path), '− 삭제'];
    case 'REPLACE': return [path(patch.path), `→ ${preview(patch.vnode)}로 교체`];
    case 'UPDATE_PROPS': return [path(patch.path), [
      ...Object.entries(patch.set).map(([k, v]) => `${k} = ${typeof v === 'function' ? '핸들러' : JSON.stringify(v)}`),
      ...patch.remove.map((k) => `${k} 삭제`),
    ].join(', ')];
    case 'UPDATE_TEXT': return [path(patch.path), `"${patch.text}"`];
    case 'MOVE': return [`부모 ${path(patch.parentPath)}`, `key="${patch.key}" ${patch.from}번 → ${patch.index}번`];
    default: return ['', ''];
  }
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function row(label, value, isTotal = false) {
  const tr = document.createElement('tr');
  if (isTotal) tr.className = 'is-total';
  const th = document.createElement('td');
  th.textContent = label;
  const td = document.createElement('td');
  td.textContent = value;
  tr.append(th, td);
  return tr;
}

function showResult(label, patches, counts, mutations) {
  $('patch-source').textContent = `· ${label}`;
  $('patch-count').textContent = patches.length;
  $('patch-list').replaceChildren(...patches.map((patch) => {
    const [where, what] = describePatch(patch);
    const li = document.createElement('li');
    li.append(span(`tag tag--${PATCH_TAG[patch.type]}`, patch.type), span('patch__path', where), span('patch__detail', what));
    return li;
  }));
  $('patch-empty').hidden = patches.length > 0;
  $('patch-empty').textContent = '바뀐 것이 없어 적용할 patch가 없습니다.';

  const c = counts ?? { created: 0, removed: 0, replaced: 0, propsUpdated: 0, textUpdated: 0, moved: 0 };
  const total = Object.values(c).reduce((sum, n) => sum + n, 0);
  $('apply-counts').replaceChildren(...COUNT_LABELS.map(([key, text]) => row(text, c[key])), row('합계', total, true));

  const m = mutations ?? { added: 0, removed: 0, attributes: 0, texts: 0, total: 0 };
  $('mutation-counts').replaceChildren(
    row('노드 추가', m.added), row('노드 삭제', m.removed), row('속성이 바뀐 노드', m.attributes), row('텍스트가 바뀐 노드', m.texts),
    row('실제로 바뀐 노드 (중복 제외)', m.total, true)
  );
}

let logCount = 0;
function addLog(kind, message) {
  const li = document.createElement('li');
  const tagClass = { PATCH: 'create', BACK: 'move', FORWARD: 'move', LOAD: 'text', ERROR: 'remove' }[kind] ?? 'muted';
  li.append(span('log__time', new Date().toLocaleTimeString('ko-KR', { hour12: false })), span(`tag tag--${tagClass}`, kind), document.createTextNode(message));
  $('change-log').prepend(li);
  $('log-count').textContent = ++logCount;
}

// ── 탭 ───────────────────────────────────────────────

function selectTab(tabId) {
  for (const tab of document.querySelectorAll('.tab')) {
    const isActive = tab.id === tabId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    $(tab.getAttribute('aria-controls')).hidden = !isActive;
  }
}

// ── 시작 ─────────────────────────────────────────────

function init() {
  const vnode = domToVNode(actual.firstElementChild);
  // index.html의 들여쓰기 공백 텍스트 노드는 VNode에 없다.
  // 실제 영역을 VNode로 다시 그려, DOM 자식 위치와 VNode 자식 위치를 1:1로 맞춘다 (patch 경로가 정확히 가리키도록)
  actual.replaceChildren(createElement(vnode));
  observer.observe(actual, { subtree: true, childList: true, attributes: true, characterData: true });

  history.push(vnode);
  showInTestArea(vnode);
  showResult('—', [], null, null);
  $('patch-empty').textContent = '아직 Patch를 실행하지 않았습니다. 테스트 영역을 고친 뒤 Patch를 눌러 보세요.';
  syncHistoryControls();
  addLog('LOAD', '실제 영역을 VNode로 읽어 첫 기록으로 저장');
}

source.addEventListener('input', handleSourceInput);
editable.addEventListener('input', handleEditableInput);
$('btn-patch').addEventListener('click', handlePatch);
$('btn-back').addEventListener('click', () => handleMove('back'));
$('btn-forward').addEventListener('click', () => handleMove('forward'));
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => selectTab(tab.id));

init();
