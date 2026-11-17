/**
 * 개념 더 파고들기 페이지 공통 — "이해했어요" 진행률(1주차와 같은 동작) + 실험 결과 그리기 도우미
 */
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const fmt = (n, d = 0) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
export const tick = () => new Promise((r) => setTimeout(r, 20));
/** 1주차 deepdive 의 결과 줄과 같은 모양: <div class="stats"><span>이름 <b>값</b></span>…</div> */
export const stat = (pairs) => `<div class="stats">${pairs.map(([k, v, c]) => `<span>${k} <b class="${c ?? ''}">${v}</b></span>`).join('')}</div>`;
/** 가로 막대 한 줄 */
export const hbar = (label, value, max, cls = 'hit', text = fmt(value)) =>
  `<div class="bar-row"><span>${label}</span><div class="bar ${cls}" style="width:${Math.max(0.5, (value / max) * 100)}%"></div><span>${text}</span></div>`;

/** 버튼을 누르는 동안 "재는 중…" */
export async function busy(btn, fn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '재는 중…';
  await tick();
  try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

/** 주제 끝의 "이해했어요" 체크 → 진행률 막대 + 목차 ✓ (이 브라우저에 저장) */
export function initProgress(storeKey) {
  let done = {};
  try { done = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch { done = {}; }
  const checks = qsa('input.got-it');
  const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(done)); } catch { /* 저장 불가 */ } };
  function paint() {
    const n = checks.filter((c) => c.checked).length;
    qs('#dd-progress-n').textContent = `${n} / ${checks.length}`;
    qs('#dd-progress-bar').style.width = `${checks.length ? (n / checks.length) * 100 : 0}%`;
    checks.forEach((c) => qs(`#toc a[href="#${c.dataset.id}"]`)?.classList.toggle('got', c.checked));
  }
  checks.forEach((c) => {
    c.checked = !!done[c.dataset.id];
    c.addEventListener('change', () => { done[c.dataset.id] = c.checked; save(); paint(); });
  });
  qs('#dd-reset')?.addEventListener('click', () => {
    checks.forEach((c) => { c.checked = false; done[c.dataset.id] = false; });
    save();
    paint();
  });
  paint();

  // 목차: 지금 읽는 곳 표시 (1주차와 같음)
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        qsa('#toc a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`));
      }
    }, { rootMargin: '-30% 0px -60% 0px' });
    qsa('section.deep').forEach((s) => io.observe(s));
  }
}
