// 개념 더 파고들기 페이지 — 실험실 연결 (서버로 열면 이 모듈, 파일로 열면 bundle.js)
import { FunctionComponent, useState, useEffect, useLayoutEffect } from '../src/lib/component.js';
import { h } from '../src/lib/vdom.js';
import { diff, summarizePatches } from '../src/lib/diff.js';
import { devConfig } from '../src/lib/warn.js';
import {
  SnapshotApp, KeyIdentityApp, RaceApp, ImmutableApp, HookOrderApp,
  parseKeys, lisPlan, visiblePatches, naiveMoves, hookSlots, diffCost, humanTime, scoreOrder,
} from './labs.js';

devConfig.warnings = false; // 일부러 규칙을 어기는 실험이 있어서 토스트는 끈다

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n >= 1e15 ? n.toExponential(1) : Math.round(n).toLocaleString('ko-KR'));
const PATCH_KO = { INSERT: '추가', REMOVE: '삭제', REPLACE: '교체', TEXT: '글자', PROPS: '속성', MOVE: '이동' };
const summaryText = (patches) => {
  const s = summarizePatches(patches);
  const parts = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${PATCH_KO[k]} ${v}`);
  return parts.length ? parts.join(' · ') : '변경 없음';
};

function safeMount(id, fn, props = {}, options = {}) {
  const box = document.getElementById(id);
  if (!box) return null;
  try {
    return new FunctionComponent(fn, props, options).mount(box);
  } catch (e) {
    box.innerHTML = `<p class="err">실험을 불러오지 못했습니다: ${esc(e.message)}</p>`;
    return null;
  }
}

// ============================================================ 이해 체크 (진행률 저장)
const STORE = 'mini-react-deepdive:v1';
function loadDone() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
}
function saveDone(d) {
  try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (e) { /* 저장 불가 환경 */ }
}
const done = loadDone();
const checks = $$('input.got-it');
function paintProgress() {
  const n = checks.filter((c) => c.checked).length;
  $('#dd-progress-n').textContent = `${n} / ${checks.length}`;
  $('#dd-progress-bar').style.width = `${checks.length ? (n / checks.length) * 100 : 0}%`;
  checks.forEach((c) => {
    const link = $(`#toc a[href="#${c.dataset.id}"]`);
    if (link) link.classList.toggle('got', c.checked);
  });
}
checks.forEach((c) => {
  c.checked = !!done[c.dataset.id];
  c.addEventListener('change', () => {
    done[c.dataset.id] = c.checked;
    saveDone(done);
    paintProgress();
  });
});
paintProgress();
$('#dd-reset')?.addEventListener('click', () => {
  checks.forEach((c) => { c.checked = false; done[c.dataset.id] = false; });
  saveDone(done);
  paintProgress();
});

// ============================================================ 목차: 지금 읽는 곳 표시
if (typeof IntersectionObserver === 'function') {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      $$('#toc a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`));
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  $$('section.deep').forEach((s) => io.observe(s));
}

// ============================================================ Lab 1. 스냅샷
safeMount('lab-snapshot', SnapshotApp, { delay: 2000 });

// ============================================================ Lab 2. 비교 비용
function makeList(n, shift) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(h('li', { key: i }, `항목 ${(i + shift) % n}`));
  return h('ul', null, ...items);
}
function paintCost() {
  const exp = Number($('#cost-n').value);
  const n = Math.round(10 ** exp);
  const c = diffCost(n);
  $('#cost-n-out').textContent = n.toLocaleString('ko-KR');
  $('#cost-naive').textContent = `${fmt(c.naive)}번 → 약 ${humanTime(c.naiveSec)}`;
  $('#cost-heur').textContent = `${fmt(c.heuristic)}번 → 약 ${humanTime(c.heuristicSec)}`;
  const ratio = c.naive / c.heuristic;
  $('#cost-ratio').textContent = `${fmt(ratio)}배`;
}
$('#cost-n')?.addEventListener('input', paintCost);
if ($('#cost-n')) paintCost();
$('#cost-measure')?.addEventListener('click', () => {
  const n = Math.round(10 ** Number($('#cost-n').value));
  const size = Math.min(n, 20000);
  const a = makeList(size, 0);
  const b = makeList(size, 1);
  const t0 = performance.now();
  const patches = diff(a, b);
  const ms = performance.now() - t0;
  $('#cost-real').innerHTML =
    `miniReact <code>diff()</code> 로 <b>${size.toLocaleString('ko-KR')}</b>개 항목 리스트를 실제로 비교: <b>${ms.toFixed(1)}ms</b>, 패치 ${patches.length.toLocaleString('ko-KR')}개` +
    (size < n ? ` <span class="muted">(브라우저가 멈추지 않도록 20,000개까지만 잼)</span>` : '');
});

// ============================================================ Lab 3. key 와 정체성
let keyComp = null;
function mountKeys() {
  keyComp?.unmount();
  $('#key-log').textContent = '아직 변경 없음';
  keyComp = safeMount('lab-keys', KeyIdentityApp, {}, {
    onCommit: (info) => {
      if (info.type !== 'update') return;
      const moved = info.patches.filter((p) => p.type === 'MOVE').length;
      $('#key-log').textContent = `방금 생긴 패치: ${summaryText(visiblePatches(info.patches))}`;
    },
  });
}
mountKeys();
$('#key-reset')?.addEventListener('click', mountKeys);

// ============================================================ Lab 4. LIS
function paintLis() {
  const oldKeys = parseKeys($('#lis-old').value);
  const newKeys = parseKeys($('#lis-new').value);
  const plan = lisPlan(oldKeys, newKeys);
  const cls = (k) => (plan.inserted.includes(k) ? 'ins' : plan.moved.includes(k) ? 'mov' : 'keep');
  $('#lis-old-row').innerHTML = oldKeys.map((k) => `<span class="chip ${plan.removed.includes(k) ? 'rem' : ''}">${esc(k)}</span>`).join('');
  $('#lis-new-row').innerHTML = newKeys.map((k, i) =>
    `<span class="chip ${cls(k)}"><small>${plan.positions[i] < 0 ? '새' : plan.positions[i]}</small>${esc(k)}</span>`).join('');
  $('#lis-seq').textContent = `[${plan.positions.filter((p) => p >= 0).join(', ')}]`;
  $('#lis-keep').textContent = plan.keep.join(' ') || '없음';
  $('#lis-moved').textContent = plan.moved.join(' ') || '없음';
  // 실제 diff 로도 확인
  const list = (keys) => h('ul', null, ...keys.map((k) => h('li', { key: k }, k)));
  const patches = diff(list(oldKeys), list(newKeys));
  const real = summarizePatches(patches);
  $('#lis-real').innerHTML =
    `실제 <code>diff()</code> 결과: 이동 <b>${real.MOVE}</b> · 추가 <b>${real.INSERT}</b> · 삭제 <b>${real.REMOVE}</b>` +
    ` <span class="muted">— 위치가 바뀐 것을 전부 옮기면 ${naiveMoves(oldKeys, newKeys)}번</span>`;
}
['#lis-old', '#lis-new'].forEach((s) => $(s)?.addEventListener('input', paintLis));
$$('[data-lis]').forEach((b) => b.addEventListener('click', () => {
  const [o, n] = b.dataset.lis.split('|');
  $('#lis-old').value = o;
  $('#lis-new').value = n;
  paintLis();
}));
if ($('#lis-old')) paintLis();

// ============================================================ Lab 5. Hook 순서
let hookComp = null;
let committed = null; // 마지막으로 성공한 렌더의 Hook 호출 목록
let attempt = null;   // 지금 렌더에서 (에러 직전까지) 부른 목록
function paintSlots(prev, next) {
  const rows = prev ? hookSlots(prev, next || []) : (next || []).map((s, slot) => ({ slot, first: null, second: s, status: 'new' }));
  const label = { new: '첫 렌더: 칸 생성', ok: '일치', mismatch: '종류가 다름 → 에러', swapped: '다른 값이 들어옴', missing: '불리지 않음', extra: '남음' };
  $('#hook-slots').innerHTML = `<tr><th>칸</th><th>지난 렌더</th><th>이번 렌더</th><th></th></tr>` +
    rows.map((r) => `<tr class="${r.status}"><td>hooks[${r.slot}]</td><td><code>${esc(r.first ?? '—')}</code></td><td><code>${esc(r.second ?? '—')}</code></td><td>${label[r.status]}</td></tr>`).join('');
}
function mountHooks(fixed) {
  hookComp?.unmount();
  committed = null;
  attempt = null;
  $('#hook-error').textContent = '';
  $('#hook-error').hidden = true;
  hookComp = safeMount('lab-hooks', HookOrderApp, {
    fixed,
    onCalls: (calls) => { attempt = calls; },
  }, {
    onCommit: () => {
      paintSlots(committed, attempt);
      committed = attempt;
    },
    onError: (err) => {
      paintSlots(committed, attempt);
      $('#hook-error').hidden = false;
      $('#hook-error').textContent = `💥 ${err.message}`;
    },
  });
  $$('[data-hook-mode]').forEach((b) => b.classList.toggle('on', (b.dataset.hookMode === 'fixed') === fixed));
}
$$('[data-hook-mode]').forEach((b) => b.addEventListener('click', () => mountHooks(b.dataset.hookMode === 'fixed')));
mountHooks(false);

// ============================================================ Lab 6. 이벤트 루프 순서 맞히기
const LOOP_ITEMS = ['동기 코드 끝', 'Promise.then', 'miniReact 리렌더', 'useLayoutEffect', 'setTimeout 0', 'useEffect'];
// 화면에는 섞어서 보여 준다 (정답 순서는 실행해 봐야 안다)
const LOOP_SHOWN = ['useEffect', 'setTimeout 0', 'miniReact 리렌더', '동기 코드 끝', 'useLayoutEffect', 'Promise.then'];
let guess = [];
function LoopProbe({ log, expose }) {
  const [n, setN] = useState(0);
  expose(setN);
  if (n) log('miniReact 리렌더');
  useLayoutEffect(() => { if (n) log('useLayoutEffect'); }, [n]);
  useEffect(() => { if (n) log('useEffect'); }, [n]);
  return h('span', { class: 'muted small' }, `probe n=${n}`);
}
let probeSet = null;
let loopLog = null;
safeMount('loop-probe', LoopProbe, { log: (m) => loopLog?.(m), expose: (s) => { probeSet = s; } });

function paintGuess() {
  $('#loop-cards').innerHTML = LOOP_SHOWN.map((it) => {
    const i = guess.indexOf(it);
    return `<button type="button" class="card-btn ${i >= 0 ? 'picked' : ''}" data-item="${esc(it)}">${i >= 0 ? `<b>${i + 1}</b>` : ''}${esc(it)}</button>`;
  }).join('');
  $$('#loop-cards .card-btn').forEach((b) => b.addEventListener('click', () => {
    const it = b.dataset.item;
    guess = guess.includes(it) ? guess.filter((g) => g !== it) : [...guess, it];
    paintGuess();
  }));
  $('#loop-run').disabled = guess.length !== LOOP_ITEMS.length;
  $('#loop-run').textContent = guess.length === LOOP_ITEMS.length ? '실행해서 확인' : `순서대로 ${LOOP_ITEMS.length - guess.length}개 더 고르세요`;
}
paintGuess();
$('#loop-clear')?.addEventListener('click', () => { guess = []; paintGuess(); $('#loop-result').innerHTML = ''; });
$('#loop-run')?.addEventListener('click', () => {
  const order = [];
  const t0 = performance.now();
  loopLog = (m) => {
    if (!order.some((o) => o.m === m)) order.push({ m, t: performance.now() - t0 });
    if (order.length === LOOP_ITEMS.length) finish();
  };
  const finish = () => {
    loopLog = null;
    const actual = order.map((o) => o.m);
    const hit = scoreOrder(guess, actual);
    $('#loop-result').innerHTML =
      `<p><b>${hit} / ${actual.length}</b> 자리를 맞혔어요.</p><ol class="loop-actual">` +
      order.map((o, i) => `<li class="${guess[i] === o.m ? 'hit' : 'miss'}"><span>${esc(o.m)}</span><small>${o.t.toFixed(2)}ms${guess[i] === o.m ? '' : ` · 내 예측: ${esc(guess[i])}`}</small></li>`).join('') +
      '</ol>';
  };
  // ↓ 실제로 이 순서로 코드를 실행한다
  setTimeout(() => loopLog?.('setTimeout 0'), 0);
  Promise.resolve().then(() => loopLog?.('Promise.then'));
  probeSet?.((v) => v + 1);  // miniReact 는 queueMicrotask 로 리렌더 예약
  loopLog('동기 코드 끝');
  setTimeout(() => { if (loopLog) finish(); }, 1500); // 안전장치
});

// ============================================================ Lab 7. 경쟁 상태
let raceComp = null;
function mountRace() {
  raceComp?.unmount();
  raceComp = safeMount('lab-race', RaceApp, {});
}
mountRace();
$('#race-reset')?.addEventListener('click', mountRace);
$('#race-auto')?.addEventListener('click', async () => {
  const input = $('#lab-race input.q');
  if (!input) return;
  for (const q of ['r', 're', 'rea', 'reac', 'react']) {
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 90));
  }
});

// ============================================================ Lab 8. 불변성
let immComp = null;
function mountImm() {
  immComp?.unmount();
  $('#imm-memory').textContent = '1';
  immComp = safeMount('lab-immut', ImmutableApp, { onMemory: (n) => { $('#imm-memory').textContent = String(n); } });
}
mountImm();
$('#imm-reset')?.addEventListener('click', mountImm);

// ============================================================ Lab 9. 시간 쪼개기 (Time slicing)
const ball = $('#slice-ball');
let frames = [];
let anim = 0;
let lastFrame = 0;
function frame(t) {
  if (lastFrame) frames.push(t - lastFrame);
  lastFrame = t;
  if (ball) ball.style.transform = `translateX(${((Math.sin(t / 300) + 1) / 2) * Math.max(0, ball.parentElement.clientWidth - 34)}px)`;
  anim = requestAnimationFrame(frame);
}
if (ball && typeof requestAnimationFrame === 'function') anim = requestAnimationFrame(frame);

function busy(ms) {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
}
const WORK_MS = 1200;
// setTimeout(0) 은 연달아 쓰면 4ms 씩 늦춰지므로, React 스케줄러처럼 MessageChannel 로 양보한다
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const waiting = [];
if (channel) channel.port1.onmessage = () => waiting.shift()?.();
function yieldToBrowser() {
  return new Promise((r) => {
    if (!channel) { setTimeout(r, 0); return; }
    waiting.push(r);
    channel.port2.postMessage(0);
  });
}
async function runSlice(mode) {
  $$('#slice-box button').forEach((b) => { b.disabled = true; });
  frames = [];
  lastFrame = 0;
  // 메인 스레드가 얼마나 오래 막혔는지: 10ms 마다 울리는 타이머 사이 간격 중 가장 긴 것
  const gaps = [];
  let lastBeat = performance.now();
  const beat = setInterval(() => {
    const t = performance.now();
    gaps.push(t - lastBeat);
    lastBeat = t;
  }, 10);
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  if (mode === 'block') {
    busy(WORK_MS);
  } else {
    let left = WORK_MS;
    while (left > 0) {
      const slice = Math.min(5, left);
      busy(slice);
      left -= slice;
      await yieldToBrowser(); // 브라우저에게 양보 → 그 사이에 그리기/입력 처리
    }
  }
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(beat);
  const longest = gaps.length ? Math.max(...gaps) : total;
  const janky = gaps.filter((f) => f > 50).length;
  $('#slice-result').innerHTML =
    `<b>${mode === 'block' ? '한 번에 처리' : '5ms 씩 쪼개서 처리'}</b> — 일 ${WORK_MS}ms, 끝날 때까지 ${total.toFixed(0)}ms<br>` +
    `메인 스레드가 가장 길게 막힌 시간: <b class="${longest > 100 ? 'bad' : 'good'}">${longest.toFixed(0)}ms</b> · 50ms 넘게 막힌 횟수 ${janky}번` +
    (frames.length ? ` · 그사이 그린 프레임 ${frames.length}개` : '') +
    `<br><span class="muted">${longest > 100 ? '그동안 공도, 타이핑도, 클릭도 멈춰 있었어요.' : '막힌 시간이 한 프레임(16.7ms) 근처라 공이 계속 움직이고 타이핑도 됩니다.'}</span>`;
  $$('#slice-box button').forEach((b) => { b.disabled = false; });
}
$$('[data-slice]').forEach((b) => b.addEventListener('click', () => runSlice(b.dataset.slice)));
window.addEventListener('pagehide', () => cancelAnimationFrame(anim));
