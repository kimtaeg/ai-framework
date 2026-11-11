import { Playground } from './playground.js';
import { PRESETS } from './presets.js';
import { computeMarks, markOfNew, markOfOld, renderTree } from './vtree.js';
import {
  TEXT, createElement, containerToVNode, htmlToVNode, childrenToHTML, vnodeToHTML,
} from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';

const $ = (sel) => document.querySelector(sel);

const actual = $('#actual');
const editor = $('#editor');
const visual = $('#visual');
const overlay = $('#overlay');
const wrap = $('#actual-wrap');

let mode = 'code'; // 테스트 영역: 'code' | 'visual'
let runMode = 'now'; // 예시 케이스 실행 방식: 'now' | 'step' | 'quiz'

// ---------------------------------------------------------------- 테스트 영역

function renderTestArea(vnode) {
  editor.value = childrenToHTML(vnode);
  visual.replaceChildren(...vnode.children.map((c) => createElement(c)));
}

/** 현재 테스트 영역 상태 → Virtual DOM */
function readTestArea() {
  return mode === 'code' ? htmlToVNode(editor.value) : containerToVNode(visual);
}

function setMode(next) {
  if (next === mode) return;
  // 탭 전환 시 편집 중인 내용을 다른 쪽으로 동기화
  renderTestArea(readTestArea());
  mode = next;
  editor.hidden = mode !== 'code';
  visual.hidden = mode !== 'visual';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
}

// ---------------------------------------------------------------- 시각화

const describeNode = (v) => {
  if (!v) return '∅';
  if (v.type === TEXT) return `"${truncate(v.text, 24)}"`;
  return `<${v.type}${v.key != null ? ` key=${v.key}` : ''}>`;
};
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const fmt = (v) => (v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : JSON.stringify(String(v)));
const pathStr = (path) => (path.length ? path.join('›') : 'root');

function describePatch(p) {
  switch (p.type) {
    case 'INSERT': return `${describeNode(p.node)} 를 [${pathStr(p.path)}] 의 ${p.index}번 위치에 추가`;
    case 'REMOVE': return `[${pathStr(p.path)}] 의 ${p.index}번 ${describeNode(p.node)} 삭제`;
    case 'REPLACE': return `[${pathStr(p.path)}] ${describeNode(p.oldNode)} → ${describeNode(p.node)} 교체`;
    case 'TEXT': return `[${pathStr(p.path)}] "${truncate(p.oldText, 20)}" → "${truncate(p.text, 20)}"`;
    case 'PROPS': return `[${pathStr(p.path)}] ` + p.changes.map((c) => `${c.name}: ${fmt(c.oldValue)} → ${fmt(c.value)}`).join(', ');
    case 'MOVE': return `[${pathStr(p.path)}] key=${p.key} 를 ${p.from} → ${p.to} 로 이동`;
    default: return p.type;
  }
}

/** 단계별 모드에서 "이 패치가 왜 이 순서인지" 설명 */
const WHY = {
  REMOVE: '삭제는 뒤에서부터 합니다. 앞을 먼저 지우면 뒤 항목의 번호가 당겨져 주소가 어긋나기 때문입니다.',
  MOVE: '삭제가 끝난 뒤, key 로 찾은 기존 노드를 오른쪽 이웃 앞으로 옮겨 자리를 확정합니다. (LIS 에 속한 노드는 그대로 둠)',
  INSERT: '자리를 확정하는 단계에서 새 노드를 만들어 끼워 넣습니다.',
  REPLACE: '태그(타입)가 달라서 하위를 비교하지 않고 통째로 새로 만들어 교체합니다.',
  TEXT: '자리가 확정된 뒤 자식 안으로 들어와 비교한 결과입니다. 텍스트 노드의 nodeValue 만 바꿉니다.',
  PROPS: '같은 태그라 노드는 그대로 두고 바뀐 속성만 고칩니다. 그다음 이 노드의 자식들을 비교합니다.',
};

function patchItem(p) {
  const li = document.createElement('li');
  const badge = document.createElement('span');
  badge.className = `badge ${p.type}`;
  badge.textContent = p.type;
  const text = document.createElement('span');
  text.textContent = describePatch(p);
  li.append(badge, ' ', text);
  return li;
}

function renderLog(result) {
  const log = $('#patch-log');
  const summary = $('#summary');
  if (!result) {
    summary.innerHTML = '<span class="muted">아직 Patch 하지 않았습니다. 테스트 영역을 수정하거나 예시 케이스를 눌러 보세요.</span>';
    log.replaceChildren();
    return;
  }
  const kindLabel = { patch: 'Patch', back: '뒤로가기', forward: '앞으로가기', go: '히스토리 이동' }[result.kind];
  if (result.patches.length === 0) {
    summary.innerHTML = `<b>${kindLabel}</b> · <span class="muted">변경 사항이 없습니다 (DOM 조작 0회)</span>`;
    log.replaceChildren();
    return;
  }
  const chips = Object.entries(result.summary)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `<span class="badge ${t}">${t} ${n}</span>`)
    .join(' ');
  summary.innerHTML = `
    <div><b>${kindLabel}</b> · 패치 ${result.patches.length}개 ${chips}</div>
    <div class="metrics">
      <span>MutationObserver 기록 <b>${result.mutations}</b>건</span>
      <span>전체 재렌더링 시 <b>${result.totalNodes}</b>개 노드 재생성</span>
      <span>${result.duration.toFixed(2)}ms</span>
      ${result.via ? `<span>${{ delta: '저장된 패치 사용 · diff 없음', 'delta-keep': '입력 중인 줄을 지키려고 diff 다시 계산', keyframe: `키프레임에서 ${result.steps}칸 다시 만듦`, replay: `현재 위치에서 ${result.steps}칸 다시 만듦` }[result.via]} (${result.historyMs.toFixed(2)}ms)</span>` : ''}
    </div>`;
  log.replaceChildren(...result.patches.map(patchItem));
}

function renderHistory() {
  const { entries, index } = pg.history;
  $('#history').replaceChildren(
    ...entries.map((e, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'history-item' + (i === index ? ' current' : '');
      btn.innerHTML = `<span class="mono">#${i}</span> ${e.label} <span class="muted">${new Date(e.time).toLocaleTimeString()}</span>`;
      btn.addEventListener('click', () => !pg.inSteps && pg.go(i));
      li.append(btn);
      return li;
    })
  );
  $('#history-pos').textContent = `${index + 1} / ${entries.length}`;
  $('#btn-back').disabled = !pg.history.canBack || pg.inSteps;
  $('#btn-forward').disabled = !pg.history.canForward || pg.inSteps;
}

function renderVTreeText(vnode) {
  const lines = [];
  const walk = (v, depth) => {
    const pad = '  '.repeat(depth);
    if (v.type === TEXT) {
      lines.push(`${pad}#text "${truncate(v.text.replace(/\n/g, '\\n'), 40)}"`);
      return;
    }
    const props = Object.keys(v.props).length ? ' ' + JSON.stringify(v.props) : '';
    const key = v.key != null ? ` key=${v.key}` : '';
    lines.push(`${pad}${v.type}${key}${props}`);
    v.children.forEach((c) => walk(c, depth + 1));
  };
  walk(vnode, 0);
  $('#vtree').textContent = lines.join('\n');
}

/** 이전 ↔ 새 트리를 나란히 그리고 패치가 닿은 노드에 색칠 */
function renderTreeCompare(prev, next, patches) {
  const marks = computeMarks(patches);
  $('#vt-old').replaceChildren(renderTree(prev, (v) => markOfOld(v, marks)));
  $('#vt-new').replaceChildren(renderTree(next, (v, path) => markOfNew(v, path, marks)));
  $('#vt-hint').textContent = patches.length
    ? `패치 ${patches.length}개가 닿은 노드에 색을 칠했습니다. 왼쪽은 사라지거나 교체된 노드, 오른쪽은 새로 생기거나 바뀐 노드입니다.`
    : '이전과 새 트리가 같습니다. (패치 0개)';
  renderVTreeText(next);
}

function renderDomStats() {
  const count = actual.querySelectorAll('*').length;
  $('#dom-stats').textContent = `요소 ${count}개`;
}

/** 변경된 노드 위에 하이라이트 박스를 띄운다. (실제 영역 DOM 은 건드리지 않도록 별도 오버레이 사용) */
function highlight(applied, { keep = false } = {}) {
  if (!$('#opt-highlight').checked) return;
  if (!keep) overlay.replaceChildren();
  const base = wrap.getBoundingClientRect();
  for (const { patch, node } of applied) {
    if (!node) continue;
    let rect;
    if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rect = range.getBoundingClientRect();
    } else if (node.getBoundingClientRect) {
      rect = node.getBoundingClientRect();
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;
    const box = document.createElement('div');
    box.className = `hl ${patch.type}`;
    box.style.left = `${rect.left - base.left + wrap.scrollLeft - 3}px`;
    box.style.top = `${rect.top - base.top + wrap.scrollTop - 3}px`;
    box.style.width = `${rect.width + 6}px`;
    box.style.height = `${rect.height + 6}px`;
    box.dataset.label = patch.type;
    overlay.append(box);
  }
  clearTimeout(highlight.timer);
  highlight.timer = setTimeout(() => overlay.replaceChildren(), keep ? 4000 : 1800);
}

// ---------------------------------------------------------------- 연결

const pg = new Playground({
  actualRoot: actual,
  renderTestArea,
  onCommit(result) {
    renderLog(result);
    renderHistory();
    renderTreeCompare(result.prev, result.next, result.patches);
    renderDomStats();
    highlight(result.applied);
  },
});

pg.init();
renderLog(null);
renderHistory();
renderTreeCompare(pg.current, pg.current, []);
$('#vt-hint').textContent = 'Patch 하면 이전 트리와 새 트리를 나란히 보여주고, 바뀐 노드에 색을 칠합니다.';
renderDomStats();

const doPatch = () => pg.patch(readTestArea(), `Patch ${pg.history.entries.length}`);

// ---------------------------------------------------------------- 단계별 Patch

const stepper = $('#stepper');
const LOCKABLE = ['#btn-patch', '#btn-step', '#btn-reset', '#editor'];

function lock(on) {
  LOCKABLE.forEach((s) => ($(s).disabled = on));
  visual.contentEditable = on ? 'false' : 'true';
  document.querySelectorAll('.preset, .seg-group .seg').forEach((b) => (b.disabled = on));
  renderHistory();
}

function startSteps(next, label) {
  const s = pg.beginSteps(next, label);
  if (s.patches.length === 0) {
    pg.cancelSteps();
    renderLog({ kind: 'patch', patches: [] });
    return;
  }
  lock(true);
  stepper.hidden = false;
  // 테스트 영역은 목표 상태를 보여준다
  renderTestArea(next);
  renderTreeCompare(s.prev, s.next, s.patches);
  renderStepper();
  stepper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#step-next').focus();
}

function renderStepper(lastMutations) {
  const s = pg.steps;
  $('#step-pos').textContent = `${s.index} / ${s.patches.length}`;
  $('#step-list').replaceChildren(
    ...s.patches.map((p, i) => {
      const li = patchItem(p);
      li.className = i < s.index ? 'done' : i === s.index ? 'current' : 'todo';
      return li;
    })
  );
  const nextPatch = s.patches[s.index];
  const last = s.patches[s.index - 1];
  const now = $('#step-now');
  if (s.index === 0) {
    now.innerHTML = `diff 결과 패치 <b>${s.patches.length}개</b>를 만들었습니다. 아직 실제 영역은 그대로입니다. <b>다음 ▶</b> 으로 첫 패치를 적용하세요.<br><span class="muted">다음: </span>${badge(nextPatch.type)} ${esc(describePatch(nextPatch))}`;
  } else {
    now.innerHTML =
      `<b>${s.index}번째 적용:</b> ${badge(last.type)} ${esc(describePatch(last))} <span class="muted">· DOM 변경 ${lastMutations ?? 0}건</span>` +
      `<br><span class="why">${WHY[last.type] ?? ''}</span>` +
      (nextPatch ? `<br><span class="muted">다음: </span>${badge(nextPatch.type)} ${esc(describePatch(nextPatch))}` : '<br><b>모든 패치를 적용했습니다.</b> 아래 "완료" 를 누르면 히스토리에 기록됩니다.');
  }
  $('#step-next').disabled = !nextPatch;
  $('#step-all').textContent = nextPatch ? '남은 것 모두 적용' : '완료';
  $('#step-list .current')?.scrollIntoView({ block: 'nearest' });
}

const badge = (t) => `<span class="badge ${t}">${t}</span>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function stepOnce() {
  if (!pg.inSteps) return;
  const r = pg.stepNext();
  if (!r) return;
  highlight([{ patch: r.patch, node: r.node }], { keep: true });
  renderDomStats();
  renderStepper(r.mutations);
}

function endSteps(apply) {
  if (!pg.inSteps) return;
  stepper.hidden = true;
  if (apply) pg.finishSteps();
  else {
    pg.cancelSteps();
    renderTreeCompare(pg.current, pg.current, []);
    renderDomStats();
    overlay.replaceChildren();
  }
  lock(false);
}

$('#btn-step').addEventListener('click', () => startSteps(readTestArea(), `단계별 ${pg.history.entries.length}`));
$('#step-next').addEventListener('click', stepOnce);
$('#step-all').addEventListener('click', () => endSteps(true));
$('#step-cancel').addEventListener('click', () => endSteps(false));

// ---------------------------------------------------------------- 예측 퀴즈

const quiz = $('#quiz');
const TYPES = ['INSERT', 'REMOVE', 'REPLACE', 'TEXT', 'PROPS', 'MOVE'];
const TYPE_KO = { INSERT: '추가', REMOVE: '삭제', REPLACE: '교체', TEXT: '텍스트', PROPS: '속성', MOVE: '이동' };
const score = { right: 0, total: 0 };
let quizTarget = null; // { preset, next }

function openQuiz(preset, next) {
  quizTarget = { preset, next };
  $('#quiz-title').textContent = `· ${preset.label}`;
  $('#quiz-opts').replaceChildren(
    ...TYPES.map((t) => {
      const label = document.createElement('label');
      label.className = 'quiz-opt';
      label.innerHTML = `<input type="checkbox" value="${t}"> <span class="badge ${t}">${t}</span> ${TYPE_KO[t]}`;
      return label;
    })
  );
  $('#quiz-result').hidden = true;
  $('#quiz-submit').disabled = false;
  quiz.hidden = false;
  quiz.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function submitQuiz() {
  if (!quizTarget) return;
  const picked = new Set([...document.querySelectorAll('#quiz-opts input:checked')].map((i) => i.value));
  const answer = new Set(diff(pg.current, quizTarget.next).map((p) => p.type));
  const correct = picked.size === answer.size && [...picked].every((t) => answer.has(t));
  score.total++;
  if (correct) score.right++;
  const list = (set) => (set.size ? [...set].map(badge).join(' ') : '<span class="muted">없음</span>');
  const result = $('#quiz-result');
  result.hidden = false;
  result.className = `quiz-result ${correct ? 'ok' : 'bad'}`;
  result.innerHTML =
    `<b>${correct ? '정답!' : '아쉬워요'}</b> 내 예측: ${list(picked)} · 실제: ${list(answer)}` +
    `<p>${esc(quizTarget.preset.desc)}</p>`;
  document.querySelectorAll('#quiz-opts input').forEach((i) => {
    i.disabled = true;
    i.closest('label').classList.toggle('should', answer.has(i.value));
  });
  $('#quiz-submit').disabled = true;
  $('#quiz-score').hidden = false;
  $('#quiz-score').textContent = `맞힌 문제 ${score.right} / ${score.total}`;
  pg.patch(quizTarget.next, quizTarget.preset.label);
  quizTarget = null;
}

$('#quiz-submit').addEventListener('click', submitQuiz);
$('#quiz-skip').addEventListener('click', () => {
  quiz.hidden = true;
  quizTarget = null;
});

// ---------------------------------------------------------------- 예시 케이스

const presetDesc = $('#preset-desc');
function renderPresets() {
  $('#preset-list').replaceChildren(
    ...PRESETS.map((p) => {
      const btn = document.createElement('button');
      btn.className = 'preset small';
      // 퀴즈 모드에서는 정답이 보이지 않도록 패치 종류 배지를 숨긴다
      btn.innerHTML = runMode === 'quiz' ? `❓ ${p.label}` : `<span class="badge ${p.type}">${p.type}</span> ${p.label}`;
      const describe = () => {
        presetDesc.textContent = runMode === 'quiz' ? `${p.label}: 어떤 패치가 생길지 예측해 보세요.` : `${p.label}: ${p.desc}`;
      };
      btn.addEventListener('mouseenter', describe);
      btn.addEventListener('focus', describe);
      btn.addEventListener('click', () => {
        // 시각 편집 중이었다면 그 내용을 기준으로
        const base = mode === 'code' ? pg.current : readTestArea();
        const next = p.apply(base);
        if (!next) {
          presetDesc.textContent = `${p.label}: 대상 요소를 찾지 못했습니다. "초기 상태로" 를 눌러 샘플을 복원한 뒤 다시 시도하세요.`;
          return;
        }
        describe();
        if (runMode === 'step') startSteps(next, p.label);
        else if (runMode === 'quiz') openQuiz(p, next);
        else pg.patch(next, p.label);
      });
      return btn;
    })
  );
}
renderPresets();

document.querySelectorAll('[data-run]').forEach((b) =>
  b.addEventListener('click', () => {
    runMode = b.dataset.run;
    document.querySelectorAll('[data-run]').forEach((x) => x.classList.toggle('on', x === b));
    if (runMode !== 'quiz') quiz.hidden = true;
    renderPresets();
    presetDesc.textContent = {
      now: '버튼을 누르면 바로 Patch 합니다.',
      step: '버튼을 누르면 패치를 하나씩 적용하는 단계별 모드로 들어갑니다.',
      quiz: '버튼을 누르면 먼저 어떤 패치가 생길지 예측하고, 정답을 확인한 뒤 적용합니다.',
    }[runMode];
  })
);

// ---------------------------------------------------------------- 트리 보기 탭
document.querySelectorAll('.vt-tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.vt-tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    $('#vt-compare').hidden = t.dataset.view !== 'compare';
    $('#vtree').hidden = t.dataset.view !== 'text';
  })
);

// ---------------------------------------------------------------- 버튼 / 단축키

$('#btn-patch').addEventListener('click', doPatch);
$('#btn-back').addEventListener('click', () => pg.back());
$('#btn-forward').addEventListener('click', () => pg.forward());
$('#btn-reset').addEventListener('click', () => pg.go(0));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

document.addEventListener('keydown', (e) => {
  if (pg.inSteps) {
    if ((e.key === 'n' || e.key === 'ArrowRight') && !e.altKey && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      stepOnce();
    } else if (e.key === 'Escape') endSteps(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    doPatch();
  } else if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    pg.back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    pg.forward();
  }
});

// Tab 키로 들여쓰기
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: end, value } = editor;
  editor.value = value.slice(0, s) + '  ' + value.slice(end);
  editor.selectionStart = editor.selectionEnd = s + 2;
});

// 디버깅용
window.__playground = { pg, vnodeToHTML };
