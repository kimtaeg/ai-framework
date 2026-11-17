// 2주차 코드 해설 그리기 — 1주차 walkthrough.js 와 같은 모양 (일반 스크립트)
// 먼저 불러온 sections.js 의 window.WALKTHROUGH = { store, sections } 를 그린다.
(function () {
  'use strict';
  function NoopObserver() { return { observe() {}, disconnect() {} }; }
  const data = window.WALKTHROUGH;
  const toc = document.getElementById('wt-toc');
  const root = document.getElementById('wt-content');
  if (!data || !toc || !root) return;
  const SECTIONS = data.sections;

  let group = null;
  for (const s of SECTIONS) {
    if (s.group !== group) {
      group = s.group;
      const g = document.createElement('div');
      g.className = 'wt-group';
      g.textContent = group;
      toc.append(g);
      const part = document.createElement('div');
      part.className = 'wt-part';
      part.textContent = group;
      root.append(part);
    }
    const a = document.createElement('a');
    a.href = `#${s.id}`;
    a.textContent = s.title.split(' — ')[0];
    toc.append(a);

    const sec = document.createElement('section');
    sec.className = 'card wt-sec';
    sec.id = s.id;
    sec.innerHTML = '<div class="wt-head"><h2></h2><code class="wt-file"></code></div><p class="wt-sum"></p><div class="wt-chunks"></div>';
    sec.querySelector('h2').textContent = s.title;
    sec.querySelector('.wt-file').textContent = s.file;
    sec.querySelector('.wt-sum').textContent = s.summary;
    const chunks = sec.querySelector('.wt-chunks');
    s.chunks.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'wt-row';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = c.code;
      pre.append(code);
      const note = document.createElement('div');
      note.className = 'wt-note';
      const num = document.createElement('span');
      num.className = 'wt-num';
      num.textContent = i + 1;
      const text = document.createElement('p');
      text.textContent = c.note;
      note.append(num, text);
      row.append(pre, note);
      chunks.append(row);
    });
    const ex = document.createElement('div');
    ex.className = 'wt-explain';
    ex.innerHTML = '<b>🗣 설명 연습</b><p class="q"></p><textarea placeholder="내 말로 3문장 안에 설명해 보세요. (이 브라우저에 저장됩니다)" aria-label="설명 연습"></textarea><details><summary>모범 답안 보기</summary><p class="a"></p></details>';
    ex.querySelector('.q').textContent = `Q. ${s.explain.q}`;
    ex.querySelector('.a').textContent = s.explain.a;
    const ta = ex.querySelector('textarea');
    const key = `${data.store}:${s.id}`;
    try { ta.value = localStorage.getItem(key) ?? ''; } catch (e) { /* 저장 불가 */ }
    ta.addEventListener('input', () => { try { localStorage.setItem(key, ta.value); } catch (e) { /* 저장 불가 */ } });
    sec.append(ex);
    root.append(sec);
  }

  const links = [...toc.querySelectorAll('a')];
  const io = new (window.IntersectionObserver || NoopObserver)((entries) => {
    for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }, { rootMargin: '-80px 0px -70% 0px' });
  document.querySelectorAll('.wt-sec').forEach((s) => io.observe(s));
})();
