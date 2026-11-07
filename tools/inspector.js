/**
 * Render Inspector (Phase 2, 샌드박스 공용)
 * ------------------------------------------------------------------
 * FunctionComponent 의 onCommit / onEffects 를 받아서 보여준다.
 *   - 숫자: 렌더 횟수, 패치 수, 실제 DOM 변경 수, 노드 수
 *   - 렌더 원인: 어떤 setState 들이 모여 이번 렌더가 됐는지 (Batching)
 *   - 단계 타임라인: render → diff → patch → useLayoutEffect → 화면 그리기 → useEffect
 *   - Hook 저장소: hooks 배열의 각 칸 (이번 렌더에 바뀐 칸 강조)
 *   - 커밋 로그
 * 앱 컴포넌트 바깥에서 일반 DOM 으로 그리므로 앱의 렌더링에 영향을 주지 않는다.
 */
import { summarizePatches } from '../src/lib/diff.js';
import { countNodes } from '../src/lib/vdom.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (n) => (n < 0.05 ? '<0.1' : n.toFixed(1));

/** Hook 칸 하나를 사람이 읽을 수 있는 한 줄로 */
export function describeHook(hook) {
  const show = (v) => preview(v);
  switch (hook.kind) {
    case 'useState':
    case 'useReducer':
      return { value: show(hook.value) };
    case 'useMemo':
      return { value: show(hook.value), deps: show(hook.deps) };
    case 'useCallback':
      return { value: 'ƒ 함수', deps: show(hook.deps) };
    case 'useRef':
      return { value: `{ current: ${show(hook.value.current)} }` };
    case 'useEffect':
    case 'useLayoutEffect':
      return { value: hook.cleanup ? 'cleanup 등록됨' : hook.ran ? '실행됨' : '대기', deps: hook.deps === undefined ? '없음 (매 렌더)' : show(hook.deps) };
    default:
      return { value: show(hook.value) };
  }
}

export function preview(v, depth = 0) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.length > 24 ? v.slice(0, 24) + '…' : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'function') return 'ƒ';
  if (Array.isArray(v)) {
    if (depth > 0) return `Array(${v.length})`;
    const items = v.slice(0, 3).map((x) => preview(x, depth + 1)).join(', ');
    return `[${items}${v.length > 3 ? `, … 총 ${v.length}개` : ''}]`;
  }
  if (typeof v === 'object') {
    if (v.type && v.props && v.children) return `<${typeof v.type === 'string' ? v.type : v.type.name || '컴포넌트'}> VNode`;
    if (depth > 0) return '{…}';
    const keys = Object.keys(v);
    const items = keys.slice(0, 3).map((k) => `${k}: ${preview(v[k], depth + 1)}`).join(', ');
    return `{ ${items}${keys.length > 3 ? ', …' : ''} }`;
  }
  return String(v);
}

export function createInspector(panel, { observe, title = 'Render Inspector', maxLog = 30 } = {}) {
  panel.classList.add('insp');
  panel.innerHTML = `
    <div class="card-head">
      ${esc(title)} <span class="sub">setState → render → diff → patch → effect</span>
      <span class="spacer"></span>
      <label class="toggle"><input type="checkbox" data-opt="flash" checked /> 변경 노드 깜빡임</label>
    </div>
    <div class="card-body">
      <div class="insp-metrics">
        <div><b data-m="renders">0</b><span>렌더 횟수</span></div>
        <div><b data-m="patches">0</b><span>이번 패치 수</span></div>
        <div><b data-m="mutations">0</b><span>DOM 변경</span></div>
        <div><b data-m="nodes">0</b><span>전체 노드</span></div>
      </div>

      <div class="insp-sec">
        <div class="insp-h">이번 렌더의 원인 <span class="muted">(Batching)</span></div>
        <div class="insp-reason" data-reason><span class="muted">아직 업데이트가 없습니다.</span></div>
      </div>

      <div class="insp-sec">
        <div class="insp-h">단계 타임라인 <span class="muted">(이번 렌더)</span></div>
        <div class="insp-bar" data-bar></div>
        <ol class="insp-steps" data-steps></ol>
      </div>

      <div class="insp-sec">
        <div class="insp-h">Hook 저장소 <span class="muted">(컴포넌트의 hooks 배열 · 노란 칸 = 이번에 바뀜)</span></div>
        <div class="insp-hooks" data-hooks></div>
      </div>

      <div class="insp-sec">
        <div class="insp-h">커밋 로그</div>
        <ol class="insp-log" data-log></ol>
      </div>
    </div>`;

  const q = (s) => panel.querySelector(s);
  const observer = observe ? new MutationObserver(() => {}) : null;
  if (observer) observer.observe(observe, { subtree: true, childList: true, attributes: true, characterData: true });

  let last = null; // 마지막 커밋 정보 (effect 시간 덧붙이기용)
  let prevHookText = [];
  const log = [];

  function renderHooks(component) {
    const rows = component.hooks.map((hook, i) => {
      const d = describeHook(hook);
      const text = `${hook.kind}|${d.value}|${d.deps ?? ''}`;
      const changed = prevHookText[i] !== undefined && prevHookText[i] !== text;
      prevHookText[i] = text;
      return `<div class="hk${changed ? ' changed' : ''}">
        <span class="hk-i">[${i}]</span><span class="hk-kind ${hook.kind}">${hook.kind}</span>
        <span class="hk-v" title="${esc(d.value)}">${esc(d.value)}</span>
        ${d.deps !== undefined ? `<span class="hk-d" title="의존성 배열">deps ${esc(d.deps)}</span>` : ''}
      </div>`;
    });
    prevHookText.length = component.hooks.length;
    q('[data-hooks]').innerHTML = rows.join('') || '<span class="muted">Hook 을 쓰지 않는 컴포넌트입니다.</span>';
  }

  function renderTimeline() {
    if (!last) return;
    const t = last.timings;
    const stages = [
      ['render', '렌더 (함수 실행)', t.render],
      ['diff', 'diff (비교)', t.diff],
      ['patch', 'patch (DOM 반영)', t.patch],
      ['layout', 'useLayoutEffect', t.layout],
    ];
    const effects = last.effects;
    const total = stages.reduce((s, [, , v]) => s + v, 0) + (effects?.duration ?? 0) || 1;
    const seg = (cls, v) => `<span class="seg ${cls}" style="flex-grow:${Math.max(v / total, 0.02)}" title="${ms(v)}ms"></span>`;
    q('[data-bar]').innerHTML =
      stages.map(([k, , v]) => seg(k, v)).join('') + '<span class="seg paint" title="브라우저가 화면을 그림"></span>' + (effects ? seg('effect', effects.duration) : '');
    q('[data-steps]').innerHTML =
      stages.map(([k, label, v]) => `<li class="${k}"><span>${label}</span><b>${ms(v)}ms</b></li>`).join('') +
      `<li class="paint"><span>브라우저가 화면 그리기</span><b class="muted">—</b></li>` +
      `<li class="effect"><span>useEffect ${effects ? `${effects.count}개` : ''}</span><b>${effects ? ms(effects.duration) + 'ms' : effects === null ? '<span class="muted">없음</span>' : '<span class="muted">대기 중…</span>'}</b></li>`;
  }

  function renderReason(info) {
    const el = q('[data-reason]');
    if (info.type === 'mount') {
      el.innerHTML = '<b>최초 마운트</b> <span class="muted">— setState 없이 처음 그림</span>';
      return;
    }
    const reasons = info.reasons ?? [];
    if (!reasons.length) {
      el.innerHTML = '<span class="muted">외부에서 update() 호출</span>';
      return;
    }
    const byIndex = new Map();
    for (const r of reasons) byIndex.set(r.index, { kind: r.kind, n: (byIndex.get(r.index)?.n ?? 0) + 1 });
    const parts = [...byIndex].map(([i, { kind, n }]) => `<code>hooks[${i}]</code> ${kind === 'useReducer' ? 'dispatch' : 'setState'}${n > 1 ? ` ×${n}` : ''}`);
    el.innerHTML = `${parts.join(', ')} <span class="arrow">→</span> <b>렌더 1회</b>` +
      (reasons.length > 1 ? ` <span class="batch">${reasons.length}번의 변경을 모아서 한 번에 (Batching)</span>` : '');
  }

  function flash(mutations) {
    if (!q('[data-opt=flash]').checked) return;
    const targets = new Set();
    for (const m of mutations) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => targets.add(n.nodeType === 1 ? n : n.parentElement));
      else targets.add(m.target.nodeType === 1 ? m.target : m.target.parentElement);
    }
    for (const el of targets) {
      if (!el || !el.isConnected || !el.animate) continue;
      el.animate([{ boxShadow: '0 0 0 2px rgba(240, 160, 0, .9)' }, { boxShadow: '0 0 0 2px rgba(240, 160, 0, 0)' }], { duration: 700, easing: 'ease-out' });
    }
  }

  function onCommit(info) {
    const { type, patches, renderCount, component } = info;
    const mutations = observer ? observer.takeRecords() : [];
    const real = patches.filter((p) => !(p.type === 'PROPS' && p.changes.every((c) => typeof c.value === 'function' || typeof c.oldValue === 'function')));
    q('[data-m=renders]').textContent = renderCount;
    q('[data-m=patches]').textContent = patches.length;
    q('[data-m=mutations]').textContent = mutations.length;
    q('[data-m=nodes]').textContent = countNodes(component.vnode).toLocaleString();

    // 이 커밋에서 실행될 useEffect 가 없으면 effects 는 null (없음), 있으면 undefined (대기 중)
    const pending = component.pendingPassive.length > 0;
    last = { renderCount, timings: info.timings, effects: pending ? undefined : null };
    renderReason(info);
    renderTimeline();
    renderHooks(component);

    const chips = Object.entries(summarizePatches(real)).filter(([, n]) => n).map(([t, n]) => `<span class="badge ${t}">${t} ${n}</span>`).join(' ');
    const handlerOnly = patches.length - real.length;
    log.unshift(
      `<li><span class="mono">#${renderCount}</span> <b>${type}</b> ` +
        (type === 'mount' ? '' : chips || '<span class="muted">DOM 변경 없음</span>') +
        (handlerOnly ? ` <span class="muted">(+핸들러 교체 ${handlerOnly})</span>` : '') +
        ` <span class="muted">· mutation ${mutations.length} · ${ms(info.duration)}ms</span></li>`
    );
    log.length = Math.min(log.length, maxLog);
    q('[data-log]').innerHTML = log.join('');
    if (type === 'update') flash(mutations);
  }

  function onEffects(info) {
    if (last && info.renderCount === last.renderCount) {
      last.effects = info;
      renderTimeline();
    }
    renderHooks(info.component); // effect 가 cleanup 을 등록했는지 반영
  }

  function reset() {
    observer?.takeRecords();
    last = null;
    prevHookText = [];
    log.length = 0;
    q('[data-log]').innerHTML = '';
    q('[data-hooks]').innerHTML = '';
    q('[data-bar]').innerHTML = '';
    q('[data-steps]').innerHTML = '';
    q('[data-reason]').innerHTML = '<span class="muted">아직 업데이트가 없습니다.</span>';
  }

  return { onCommit, onEffects, reset, disconnect: () => observer?.disconnect() };
}
