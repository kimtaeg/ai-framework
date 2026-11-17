/**
 * 이론 페이지 공통 동작 — 1주차 theory.js 의 "보기 필터 · 검색 · 목차 · 진행 바 · 맨 위로 · 질문 펼치기" 와 같음
 * (1주차 theory.js 는 React 데모 요소가 꼭 있어야 해서, 공통 부분만 따로 옮김)
 */
export function initTheoryPage() {
  function NoopObserver() { return { observe() {}, disconnect() {} }; }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sections = $$('#content section');
  const parts = $$('#content .part');
  const tocLinks = $$('#toc a');
  const toc = $('#toc');
  let filter = 'all';

  $$('.seg-group .seg[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      $$('.seg-group .seg[data-filter]').forEach((b) => b.classList.toggle('on', b === btn));
      applyVisibility();
    })
  );

  const search = $('#search');
  const empty = $('#empty-search');
  let timer;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(applyVisibility, 120);
  });

  function clearMarks(root) {
    $$('mark.hit', root).forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    root.normalize();
  }
  function markText(root, q) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('.demo') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(q)) hits.push(n);
    for (const node of hits) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0, j;
      while ((j = lower.indexOf(q, i)) !== -1) {
        frag.append(text.slice(i, j));
        const m = document.createElement('mark');
        m.className = 'hit';
        m.textContent = text.slice(j, j + q.length);
        frag.append(m);
        i = j + q.length;
      }
      frag.append(text.slice(i));
      node.replaceWith(frag);
    }
  }

  function applyVisibility() {
    const q = (search?.value ?? '').trim().toLowerCase();
    let shown = 0;
    sections.forEach((s) => {
      clearMarks(s);
      const levelOk = filter === 'all' || s.dataset.level !== 'deep';
      const textOk = !q || s.textContent.toLowerCase().includes(q);
      s.classList.toggle('hidden-by-filter', !levelOk);
      s.classList.toggle('hidden-by-search', !textOk);
      const visible = levelOk && textOk;
      if (visible) shown++;
      if (q && visible) {
        markText(s, q);
        $$('details', s).forEach((d) => { if (d.textContent.toLowerCase().includes(q)) d.open = true; });
      }
    });
    parts.forEach((p) => {
      let el = p.nextElementSibling, any = false;
      while (el && !el.classList.contains('part')) {
        if (el.tagName === 'SECTION' && !el.classList.contains('hidden-by-search') && !el.classList.contains('hidden-by-filter')) any = true;
        el = el.nextElementSibling;
      }
      p.classList.toggle('hidden-by-search', !any);
    });
    tocLinks.forEach((a) => {
      const s = document.querySelector(a.getAttribute('href'));
      a.classList.toggle('hidden-by-search', !s || s.classList.contains('hidden-by-search') || s.classList.contains('hidden-by-filter'));
    });
    $$('#toc .group').forEach((g) => {
      let el = g.nextElementSibling, any = false;
      while (el && !el.classList.contains('group')) {
        if (el.tagName === 'A' && !el.classList.contains('hidden-by-search')) any = true;
        el = el.nextElementSibling;
      }
      g.classList.toggle('hidden-by-search', !any);
    });
    if (empty) empty.style.display = shown ? 'none' : 'block';
  }

  const io = new (window.IntersectionObserver || NoopObserver)((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      tocLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
      const active = $('a.active', toc);
      if (active && toc && getComputedStyle(toc).position === 'sticky') toc.scrollTo?.({ top: active.offsetTop - toc.clientHeight / 2, behavior: 'smooth' });
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  sections.forEach((s) => io.observe(s));

  const progress = $('#progress');
  const toTop = $('#to-top');
  function onScroll() {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    if (progress) progress.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    toTop?.classList.toggle('show', h.scrollTop > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  toTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  onScroll();

  $('#qa-open')?.addEventListener('click', () => $$('details.qa').forEach((d) => (d.open = true)));
  $('#qa-close')?.addEventListener('click', () => $$('details.qa').forEach((d) => (d.open = false)));
  return { applyVisibility };
}
