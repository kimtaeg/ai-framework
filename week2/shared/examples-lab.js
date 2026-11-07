/**
 * 예제 페이지의 "🧪 일부러 망가뜨리기" 막대와 설명 패널 — 1주차 예제 페이지와 같은 모양
 *   각 예제 카드: <section class="ex card" id="ex-{app}"> 안의 <div class="lab" id="lab-{app}">
 *   맨 위: #lab-count (모두 정상 / 망가뜨린 예제 n개), #lab-reset-all
 */
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function initLab({ experiments, flags, onChange = () => {} }) {
  const apps = [...new Set(experiments.map((e) => e.app))];
  const activeOf = (app) => experiments.find((e) => e.app === app && flags[e.id]);

  function toggle(exp) {
    const on = !flags[exp.id];
    // 한 예제에서는 실험 하나만 켠다 (무엇 때문에 망가졌는지 헷갈리지 않게)
    for (const e of experiments) if (e.app === exp.app) flags[e.id] = false;
    flags[exp.id] = on;
    render(exp.app);
    summary();
    onChange(exp.app, exp, on);
  }

  function render(app) {
    const lab = document.getElementById(`lab-${app}`);
    const card = document.getElementById(`ex-${app}`);
    if (!lab) return;
    const active = activeOf(app);
    card?.classList.toggle('broken', !!active);
    const bar = document.createElement('div');
    bar.className = 'lab-bar';
    bar.innerHTML = '<span class="lab-label">🧪 일부러 망가뜨리기</span>';
    for (const exp of experiments.filter((e) => e.app === app)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = flags[exp.id] ? 'lab-btn on' : 'lab-btn';
      btn.dataset.flag = exp.id;
      btn.textContent = flags[exp.id] ? `↩ 복구하기 (${exp.title})` : exp.title;
      btn.setAttribute('aria-pressed', String(!!flags[exp.id]));
      btn.addEventListener('click', () => toggle(exp));
      bar.append(btn);
    }
    if (!active) {
      const hint = document.createElement('span');
      hint.className = 'lab-hint muted';
      hint.textContent = '정상 상태 · 버튼을 누르면 이 예제만 망가진 코드로 바뀝니다';
      bar.append(hint);
      lab.replaceChildren(bar);
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'lab-panel';
    panel.innerHTML = `
      <div class="lab-status">
        <b>지금 망가진 상태: ${escHtml(active.title)}</b>
        <span class="lab-concept">${escHtml(active.concept)}</span>
        <a href="${active.theory}">이론 보기 →</a>
      </div>
      <div class="lab-code">
        <div><span class="tag ok">정상 코드</span><pre>${escHtml(active.before)}</pre></div>
        <div><span class="tag bad">망가진 코드</span><pre>${escHtml(active.after)}</pre></div>
      </div>
      <div class="lab-steps">
        <div><b>① 해보기</b><p>${escHtml(active.try)}</p></div>
        <div><b>② 예측하기</b><p>누르기 전에 어떻게 될지 먼저 말해보세요.</p></div>
      </div>
      <details class="lab-answer"><summary>③ 관찰할 것 (예측한 뒤에 열기)</summary><p>${escHtml(active.watch)}</p></details>
      <details class="lab-answer"><summary>④ 왜 그럴까?</summary><p>${escHtml(active.why)}</p></details>`;
    lab.replaceChildren(bar, panel);
  }

  function summary() {
    const n = experiments.filter((e) => flags[e.id]).length;
    const count = document.getElementById('lab-count');
    if (count) {
      count.textContent = n ? `망가뜨린 예제 ${n}개` : '모두 정상';
      count.classList.toggle('on', n > 0);
    }
    const all = document.getElementById('lab-reset-all');
    if (all) all.disabled = n === 0;
  }

  document.getElementById('lab-reset-all')?.addEventListener('click', () => {
    for (const e of experiments) flags[e.id] = false;
    apps.forEach(render);
    summary();
    onChange(null, null, false);
  });
  apps.forEach(render);
  summary();
  return { render, summary };
}

/** 예제 아래 막대(ex-stat) 갱신 + 반짝임 */
export function stat(id, html) {
  const el = document.getElementById(`stat-${id}`);
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}
