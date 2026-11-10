import { toVNode } from '../src/domToVNode.js';
import { render } from '../src/vdom.js';
import { diff, patch, CREATE, REMOVE, REPLACE, TEXT, PROPS } from '../src/diff.js';
import { parseHTML } from '../src/parseHTML.js';
import { toHTML } from '../src/toHTML.js';
import { History } from '../src/history.js';
import { OBSERVE_OPTIONS, measureMutations, summarizeMutations } from '../src/mutationStats.js';

const $ = (id) => document.getElementById(id);

const actualRoot = $('actual-root');
const previewRoot = $('preview-root');
const source = $('source');
const sourceError = $('source-error');
const btnPatch = $('btn-patch');
const btnBack = $('btn-back');
const btnForward = $('btn-forward');
const historyIndex = $('history-index');
const historyTotal = $('history-total');
const patchList = $('patch-list');
const patchCount = $('patch-count');
const patchEmpty = $('patch-empty');
const patchSource = $('patch-source');
const changeLog = $('change-log');
const logCount = $('log-count');
const logEmpty = $('log-empty');
const compareSource = $('compare-source');
const compareSummary = $('compare-summary');
const compareBody = $('compare-body');
const barPatch = $('bar-patch');
const barInner = $('bar-inner');
const valuePatch = $('value-patch');
const valueInner = $('value-inner');
const totalPatch = $('total-patch');
const totalInner = $('total-inner');

const PREVIEW_LENGTH = 48;
const PATCH_LABEL = 'Patch';
const FLASH_DURATION_MS = 1200; // 바뀐 노드를 강조하는 애니메이션 길이

// 변경 로그의 종류. TAG_CLASS의 키로도 쓰이므로 오타가 나면 태그 색이 조용히 바뀐다 → 한 곳에서 관리
const LOG_KIND = {
  LOAD: 'LOAD',
  PATCH: 'PATCH',
  SKIP: 'SKIP',
  ERROR: 'ERROR',
  DOM: 'DOM',
  BACK: 'BACK',
  FORWARD: 'FORWARD',
};

const history = new History();

// 뒤로/앞으로 버튼마다 다른 것: 화면 라벨, 로그 종류, History 이동 방향
const MOVES = {
  back: { label: '뒤로가기', logKind: LOG_KIND.BACK, go: () => history.back() },
  forward: { label: '앞으로가기', logKind: LOG_KIND.FORWARD, go: () => history.forward() },
};

// 실제 영역을 계속 감시한다. patch 직후에는 takeRecords()로 바로 꺼내 세고,
// 그 밖의 시점에 생긴 변경만 콜백으로 들어온다.
const actualObserver = new MutationObserver(reportOutsideMutations);

// ── 흐름 ─────────────────────────────────────

function init() {
  const vnode = toVNode(actualRoot.firstElementChild);
  // index.html의 줄바꿈 공백 텍스트 노드는 VNode에 없다.
  // 실제 영역을 VNode로 다시 그려 DOM 자식 인덱스와 VNode 인덱스를 1:1로 맞춘다.
  actualRoot.replaceChildren(render(vnode));
  actualObserver.observe(actualRoot, OBSERVE_OPTIONS);
  history.push(vnode);

  showSource(vnode);
  syncHistoryControls();
  addLog(LOG_KIND.LOAD, '실제 영역을 VNode로 읽어 기록에 저장');
}

function handleSourceInput() {
  try {
    renderPreview(parseHTML(source.value));
    hideError();
  } catch (error) {
    showError(error);
  }
}

function handlePatch() {
  let next;
  try {
    next = parseHTML(source.value);
  } catch (error) {
    showError(error);
    addLog(LOG_KIND.ERROR, `Patch 취소 — ${error.message}`);
    return;
  }

  const prev = history.current();
  const patches = diff(prev, next);
  showPatches(patches, prev, next, PATCH_LABEL);
  compareMutations(prev, next, patches, PATCH_LABEL);

  if (patches.length === 0) {
    addLog(LOG_KIND.SKIP, '변경 없음 — 기록을 추가하지 않음');
    return;
  }

  history.push(next);
  flashPatched(patches);
  syncHistoryControls();
  addLog(LOG_KIND.PATCH, `${patches.length}개 적용 → 기록 ${getPositionText()}`);
}

function handleMove(move) {
  const prev = history.current();
  const next = move.go();
  if (next === prev) return; // 양 끝: 버튼이 비활성이라 보통 오지 않는다

  const patches = diff(prev, next);
  compareMutations(prev, next, patches, move.label);
  flashPatched(patches);

  showSource(next);
  showPatches(patches, prev, next, move.label);
  syncHistoryControls();
  addLog(move.logKind, `${patches.length}개 적용 → 기록 ${getPositionText()}`);
}

// ── DOM 변경 측정 ────────────────────────────

// patches를 실제 영역에 적용하고, 같은 변경을 innerHTML로 했을 때와 변경 노드 수를 비교한다
function compareMutations(prev, next, patches, label) {
  // next를 render하는 innerHTML 측정을 patch보다 먼저 한다.
  // next를 그릴 수 없으면 여기서 에러가 나므로, 실제 영역을 건드리기 전에 멈춘다 (일부만 patch된 상태 방지).
  const byInnerHTML = measureInnerHTML(prev, next);

  reportOutsideMutations(actualObserver.takeRecords()); // 이전에 쌓인 기록은 patch와 섞이지 않게 먼저 꺼낸다
  try {
    patch(actualRoot, patches);
  } catch (error) {
    // 실제 DOM이 patch 밖에서 바뀌어 VNode와 어긋난 경우: 새 VNode로 통째로 다시 그려 맞춘다
    actualRoot.replaceChildren(render(next));
    addLog(LOG_KIND.ERROR, `patch 실패 — ${error.message} 실제 영역을 다시 그려 복구했습니다.`);
  }
  const byPatch = summarizeMutations(actualObserver.takeRecords());

  showComparison(byPatch, byInnerHTML, label);
  addLog(
    LOG_KIND.DOM,
    `MutationObserver: 추가 ${byPatch.added} · 삭제 ${byPatch.removed} · 속성 ${byPatch.attributes} · 텍스트 ${byPatch.text}` +
      ` = ${byPatch.total}개 (innerHTML이면 ${byInnerHTML.total}개)`
  );
}

// 화면 밖 복사본에 prev를 그려 두고, next의 HTML을 innerHTML로 통째로 넣었을 때의 변경을 센다
function measureInnerHTML(prev, next) {
  const sandbox = document.createElement('div');
  sandbox.appendChild(render(prev));
  const html = render(next).outerHTML;
  return measureMutations(sandbox, () => {
    sandbox.innerHTML = html;
  });
}

function reportOutsideMutations(records) {
  const summary = summarizeMutations(records);
  if (summary.total > 0) addLog(LOG_KIND.DOM, `patch 밖에서 생긴 DOM 변경 ${summary.total}개 감지`);
}

const COMPARE_ROWS = [
  ['노드 추가', 'added'],
  ['노드 삭제', 'removed'],
  ['속성 변경', 'attributes'],
  ['텍스트 변경', 'text'],
];

function showComparison(byPatch, byInnerHTML, label) {
  compareSource.textContent = `· ${label}`;

  const max = Math.max(byPatch.total, byInnerHTML.total, 1);
  setBar(barPatch, valuePatch, byPatch.total, max, 'patch');
  setBar(barInner, valueInner, byInnerHTML.total, max, 'innerHTML');

  compareBody.replaceChildren(
    ...COMPARE_ROWS.map(([name, key]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = name;
      tr.append(th, createCell(byPatch[key]), createCell(byInnerHTML[key]));
      return tr;
    })
  );
  totalPatch.textContent = byPatch.total;
  totalInner.textContent = byInnerHTML.total;

  compareSummary.replaceChildren(...createSummaryText(byPatch.total, byInnerHTML.total));
}

function setBar(fill, value, count, max, name) {
  fill.style.width = `${(count / max) * 100}%`;
  fill.parentElement.title = `${name}: 변경된 노드 ${count}개`;
  value.textContent = count;
}

function createCell(value) {
  const td = document.createElement('td');
  td.textContent = value;
  return td;
}

function createSummaryText(patchTotal, innerTotal) {
  const strong = (text) => {
    const b = document.createElement('b');
    b.textContent = text;
    return b;
  };
  if (patchTotal === 0) {
    return ['바뀐 것이 없어 patch는 DOM을 ', strong('전혀 건드리지 않았지만'), `, innerHTML은 노드 ${innerTotal}개를 지우고 다시 만듭니다.`];
  }
  const ratio = innerTotal / patchTotal;
  const ratioText = ratio >= 1.05 ? ` (약 ${ratio.toFixed(1)}배)` : '';
  return ['patch는 노드 ', strong(`${patchTotal}개`), '만 바꿨고, innerHTML이었다면 ', strong(`${innerTotal}개`), `를 바꿨습니다${ratioText}.`];
}

// ── 화면 갱신 ────────────────────────────────

function showSource(vnode) {
  source.value = toHTML(vnode);
  renderPreview(vnode);
  hideError();
}

function renderPreview(vnode) {
  previewRoot.replaceChildren(render(vnode));
  previewRoot.classList.remove('is-stale');
}

function showError(error) {
  sourceError.textContent = error.message;
  sourceError.hidden = false;
  source.setAttribute('aria-invalid', 'true');
  previewRoot.classList.add('is-stale');
}

function hideError() {
  sourceError.hidden = true;
  source.removeAttribute('aria-invalid');
  previewRoot.classList.remove('is-stale');
}

function getPositionText() {
  return `${history.index + 1} / ${history.stack.length}`;
}

function syncHistoryControls() {
  btnBack.disabled = !history.canBack();
  btnForward.disabled = !history.canForward();
  historyIndex.textContent = history.index + 1;
  historyTotal.textContent = history.stack.length;
}

// 바뀐 위치를 잠깐 강조한다. 속성을 건드리지 않도록 Web Animations API만 쓴다.
function flashPatched(patches) {
  const styles = getComputedStyle(document.documentElement);
  const flash = styles.getPropertyValue('--flash').trim();
  const flashBg = styles.getPropertyValue('--flash-bg').trim();
  for (const p of patches) {
    if (p.type === REMOVE) continue;
    let node = actualRoot.firstChild;
    for (const i of p.path) node = node?.childNodes[i];
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    el?.animate?.(
      [{ boxShadow: `0 0 0 3px ${flash}`, backgroundColor: flashBg }, { boxShadow: '0 0 0 3px transparent' }],
      { duration: FLASH_DURATION_MS, easing: 'ease-out' }
    );
  }
}

// ── 패널 ─────────────────────────────────────

function showPatches(patches, prev, next, label) {
  patchSource.textContent = `· ${label}`;
  patchCount.textContent = patches.length;
  patchList.replaceChildren(...patches.map((p) => patchItem(p, p.type === CREATE ? next : prev)));
  patchEmpty.hidden = patches.length > 0;
  if (patches.length === 0) patchEmpty.textContent = '바뀐 부분이 없어 적용할 patch가 없습니다.';
}

function patchItem(p, tree) {
  const li = document.createElement('li');
  li.title = `path: [${p.path.join(', ')}]`;
  li.append(createTag(p.type), createSpan('patch__path', describePath(tree, p.path)), createSpan('patch__detail', describePatch(p)));
  return li;
}

function describePath(root, path) {
  const names = [getNodeName(root)];
  let node = root;
  for (const i of path) {
    node = node.children[i];
    names.push(`${getNodeName(node)}[${i}]`);
  }
  return names.join(' › ');
}

function getNodeName(vnode) {
  return typeof vnode === 'string' ? '#text' : vnode.type;
}

function describePatch(p) {
  switch (p.type) {
    case CREATE:
      return `+ ${formatSnippet(p.vnode)}`;
    case REMOVE:
      return `− ${formatSnippet(p.vnode)}`;
    case REPLACE:
      return `${formatSnippet(p.from)} → ${formatSnippet(p.vnode)}`;
    case TEXT:
      return `"${truncate(p.from)}" → "${truncate(p.to)}"`;
    case PROPS:
      return p.changes
        .map(({ key, from, to }) => {
          if (from === undefined) return to === '' ? `+${key}` : `+${key}="${to}"`;
          if (to === undefined) return `−${key}`;
          return `${key}: "${from}" → "${to}"`;
        })
        .join(', ');
    default:
      return '';
  }
}

function formatSnippet(vnode) {
  return truncate(toHTML(vnode).replace(/\n\s*/g, ''));
}

function truncate(text) {
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

function addLog(kind, message) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  li.append(createSpan('log__time', time), createTag(kind), createSpan('log__message', message));
  changeLog.prepend(li);
  logCount.textContent = changeLog.children.length;
  logEmpty.hidden = true;
}

const TAG_CLASS = {
  [CREATE]: 'create', [REMOVE]: 'remove', [REPLACE]: 'replace', [TEXT]: 'text', [PROPS]: 'props',
  [LOG_KIND.PATCH]: 'create', [LOG_KIND.LOAD]: 'text', [LOG_KIND.BACK]: 'props', [LOG_KIND.FORWARD]: 'props',
  [LOG_KIND.SKIP]: 'muted', [LOG_KIND.ERROR]: 'remove', [LOG_KIND.DOM]: 'dom',
};

function createTag(kind) {
  return createSpan(`tag tag--${TAG_CLASS[kind] ?? 'muted'}`, kind);
}

function createSpan(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

// ── 이벤트 ───────────────────────────────────

source.addEventListener('input', handleSourceInput);
source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    handlePatch();
  }
});
btnPatch.addEventListener('click', handlePatch);
btnBack.addEventListener('click', () => handleMove(MOVES.back));
btnForward.addEventListener('click', () => handleMove(MOVES.forward));

init();
