// React 이론 페이지 스크립트 (일반 스크립트라 파일을 더블클릭해서 열어도 동작)
(function () {
  'use strict';
  // IntersectionObserver 가 없는 환경에서도 나머지 기능은 동작하도록
  function NoopObserver() { return { observe() {}, disconnect() {} }; }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sections = $$('#content section');
  const parts = $$('#content .part');
  const tocLinks = $$('#toc a');
  const toc = $('#toc');

  // ============================================================ 보기 필터 (전체 / 과제 핵심만)
  let filter = 'all';
  $$('.seg-group .seg').forEach((btn) =>
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      $$('.seg-group .seg').forEach((b) => b.classList.toggle('on', b === btn));
      applyVisibility();
    })
  );

  // ============================================================ 검색
  const search = $('#search');
  const empty = $('#empty-search');
  let timer;
  search.addEventListener('input', () => {
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
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.toLowerCase().includes(q)) hits.push(n);
    }
    for (const node of hits) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0;
      let j;
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
    const q = search.value.trim().toLowerCase();
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
        $$('details', s).forEach((d) => {
          if (d.textContent.toLowerCase().includes(q)) d.open = true;
        });
      }
    });
    // 소제목(part)은 그 아래 보이는 섹션이 있을 때만
    parts.forEach((p) => {
      let el = p.nextElementSibling;
      let any = false;
      while (el && !el.classList.contains('part')) {
        if (el.tagName === 'SECTION' && !el.classList.contains('hidden-by-search') && !el.classList.contains('hidden-by-filter')) any = true;
        el = el.nextElementSibling;
      }
      p.classList.toggle('hidden-by-search', !any);
    });
    tocLinks.forEach((a) => {
      const s = document.querySelector(a.getAttribute('href'));
      const hidden = !s || s.classList.contains('hidden-by-search') || s.classList.contains('hidden-by-filter');
      a.classList.toggle('hidden-by-search', hidden);
    });
    $$('#toc .group').forEach((g) => {
      let el = g.nextElementSibling;
      let any = false;
      while (el && !el.classList.contains('group')) {
        if (el.tagName === 'A' && !el.classList.contains('hidden-by-search')) any = true;
        el = el.nextElementSibling;
      }
      g.classList.toggle('hidden-by-search', !any);
    });
    empty.style.display = shown ? 'none' : 'block';
  }

  // ============================================================ 목차 현재 위치 / 진행 바 / 맨 위로
  const io = new (window.IntersectionObserver || NoopObserver)(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        tocLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
        const active = $('a.active', toc);
        if (active && getComputedStyle(toc).position === 'sticky') {
          toc.scrollTo({ top: active.offsetTop - toc.clientHeight / 2, behavior: 'smooth' });
        }
      }
    },
    { rootMargin: '-80px 0px -70% 0px' }
  );
  sections.forEach((s) => io.observe(s));

  const progress = $('#progress');
  const toTop = $('#to-top');
  function onScroll() {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    progress.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    toTop.classList.toggle('show', h.scrollTop > 600);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  onScroll();

  // Q&A
  $('#qa-open').addEventListener('click', () => $$('details.qa').forEach((d) => (d.open = true)));
  $('#qa-close').addEventListener('click', () => $$('details.qa').forEach((d) => (d.open = false)));

  // ============================================================ 데모 1: Reflow / Repaint
  (function reflowDemo() {
    const box = $('#rr-box');
    const msg = $('#rr-msg');
    const stages = $$('#demo-reflow .stages span');
    const plans = {
      size: {
        run: ['style', 'layout', 'paint', 'composite'],
        apply: () => { box.style.width = box.style.width === '160px' ? '70px' : '160px'; },
        msg: '크기가 바뀌면 위치·크기 계산(Reflow)부터 다시 합니다. 네 단계 모두 실행되어 가장 비쌉니다.',
      },
      color: {
        run: ['style', 'paint', 'composite'],
        apply: () => { box.style.background = box.style.background ? '' : '#1f9d6b'; },
        msg: '색만 바뀌면 크기·위치는 그대로라 Layout 을 건너뛰고 다시 칠하기(Repaint)만 합니다.',
      },
      move: {
        run: ['style', 'composite'],
        apply: () => { box.style.transform = box.style.transform ? '' : 'translateX(120px)'; },
        msg: 'transform 은 레이어를 GPU 로 옮기기만 해서 Layout 과 Paint 를 모두 건너뜁니다. 애니메이션에 쓰는 이유입니다.',
      },
    };
    let busy = false;
    $$('#demo-reflow [data-change]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const plan = plans[btn.dataset.change];
        stages.forEach((s) => s.classList.remove('on', 'skip'));
        msg.textContent = plan.msg;
        plan.apply();
        for (const s of stages) {
          if (plan.run.includes(s.dataset.stage)) s.classList.add('on');
          else s.classList.add('skip');
          await sleep(220);
        }
        busy = false;
      })
    );
  })();

  // ============================================================ 데모 2: key = index vs key = id
  (function keyDemo() {
    const initial = () => [
      { id: 1, name: '사과' },
      { id: 2, name: '바나나' },
      { id: 3, name: '포도' },
    ];
    const extra = ['딸기', '수박', '참외', '망고', '키위'];
    let items = initial();
    let nextId = 4;
    const listIndex = $('#key-index');
    const listId = $('#key-id');

    function makeRow(item) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = item.name + ' 메모';
      input.setAttribute('aria-label', item.name + ' 메모');
      li.append(name, input);
      li.dataset.owner = item.name; // 이 입력값이 원래 누구의 메모인지
      return li;
    }

    function setName(li, item) {
      li.querySelector('.name').textContent = item.name;
    }

    // key = index: 같은 "자리"의 DOM 을 재사용하고 글자만 바꾼다 → 입력칸은 자리에 남는다
    function renderByIndex() {
      let created = 0;
      let updated = 0;
      items.forEach((item, i) => {
        let li = listIndex.children[i];
        if (!li) {
          li = makeRow(item);
          listIndex.append(li);
          created++;
        } else if (li.querySelector('.name').textContent !== item.name) {
          updated++;
          li.classList.remove('flash');
          void li.offsetWidth;
          li.classList.add('flash');
        }
        setName(li, item);
        li.classList.toggle('mismatch', li.dataset.owner !== item.name);
      });
      return { created, updated };
    }

    // key = id: id 로 같은 DOM 을 찾아 순서만 옮긴다 → 입력칸이 항목을 따라간다
    const byId = new Map();
    function renderById() {
      let created = 0;
      items.forEach((item) => {
        let li = byId.get(item.id);
        if (!li) {
          li = makeRow(item);
          byId.set(item.id, li);
          created++;
          li.classList.add('flash');
        }
        setName(li, item);
        listId.append(li); // 이미 있으면 이동
      });
      return { created };
    }

    function render(first) {
      const a = renderByIndex();
      const b = renderById();
      if (first) {
        $('#key-index-stat').textContent = '';
        $('#key-id-stat').textContent = '';
        return;
      }
      const bad = $$('.mismatch', listIndex).length;
      $('#key-index-stat').innerHTML =
        `새로 만든 행 ${a.created}개, 글자를 바꾼 행 ${a.updated}개 · ` +
        (bad ? `<b style="color:var(--danger)">메모가 엉뚱한 항목에 붙은 행 ${bad}개</b>` : '');
      $('#key-id-stat').innerHTML = `새로 만든 행 ${b.created}개, 나머지는 그대로 이동 · <b style="color:var(--ok)">메모가 항목을 따라감</b>`;
    }

    $('#key-add').addEventListener('click', () => {
      const name = extra[(nextId - 4) % extra.length];
      items = [{ id: nextId++, name }, ...items];
      render(false);
    });
    $('#key-reset').addEventListener('click', () => {
      items = initial();
      nextId = 4;
      listIndex.replaceChildren();
      listId.replaceChildren();
      byId.clear();
      render(true);
    });
    render(true);
  })();

  // ============================================================ 데모 3: Hooks 사물함
  (function hooksDemo() {
    const names = ['철수', '영희', '민수', '지은'];
    const state = { hooks: [0, '철수', { value: 0, deps: [0] }], renders: 1, nameIdx: 0 };
    const pending = {};
    const lines = $$('#demo-hooks .ln');
    const slots = $$('#demo-hooks .slot');
    const msg = $('#hd-msg');
    const btns = [$('#hd-inc'), $('#hd-name')];
    const fmt = (v) => (typeof v === 'string' ? `'${v}'` : String(v));

    function show() {
      $('#slot0').textContent = fmt(state.hooks[0]);
      $('#slot1').textContent = fmt(state.hooks[1]);
      $('#slot2').textContent = fmt(state.hooks[2].value);
      $('#hd-renders').textContent = state.renders;
    }
    function highlight(line, slot) {
      lines.forEach((l) => l.classList.toggle('on', Number(l.dataset.line) === line));
      slots.forEach((s) => s.classList.toggle('on', Number(s.dataset.slot) === slot));
    }
    function tag(slotEl, text, re) {
      slotEl.querySelector('.tag')?.remove();
      const t = document.createElement('span');
      t.className = 'tag' + (re ? ' re' : '');
      t.textContent = text;
      slotEl.querySelector('.v').before(t);
    }

    async function rerender(reason) {
      btns.forEach((b) => (b.disabled = true));
      slots.forEach((s) => s.querySelector('.tag')?.remove());
      msg.textContent = `${reason} → 값을 사물함에 저장하고 리렌더 예약. 이제 함수를 처음부터 다시 실행합니다.`;
      // 대기 중인 값 반영
      if ('count' in pending) state.hooks[0] = pending.count;
      if ('name' in pending) state.hooks[1] = pending.name;
      delete pending.count;
      delete pending.name;
      show();
      await sleep(500);

      highlight(0, -1);
      $('#hd-index').textContent = '0';
      await sleep(450);

      highlight(1, 0);
      $('#hd-index').textContent = '0 → 1';
      tag(slots[0], '꺼냄');
      msg.textContent = '1번째 Hook 호출 → 0번 사물함을 열어 count 를 꺼냄';
      await sleep(800);

      highlight(2, 1);
      $('#hd-index').textContent = '1 → 2';
      tag(slots[1], '꺼냄');
      msg.textContent = '2번째 Hook 호출 → 1번 사물함을 열어 name 을 꺼냄';
      await sleep(800);

      highlight(3, 2);
      $('#hd-index').textContent = '2 → 3';
      const memo = state.hooks[2];
      const count = state.hooks[0];
      if (memo.deps[0] !== count) {
        memo.value = count * 2;
        memo.deps = [count];
        tag(slots[2], '다시 계산', true);
        msg.textContent = `3번째 Hook 호출 → 의존성 count 가 바뀜 → count × 2 를 다시 계산 (${memo.value})`;
      } else {
        tag(slots[2], '캐시 사용');
        msg.textContent = '3번째 Hook 호출 → 의존성 count 가 그대로 → 계산하지 않고 저장된 값을 그대로 씀 (useMemo)';
      }
      show();
      await sleep(1000);

      highlight(4, -1);
      state.renders++;
      show();
      $('#hd-out').textContent = `${state.hooks[1]}: ${state.hooks[0]} × 2 = ${state.hooks[2].value}`;
      await sleep(500);
      highlight(-1, -1);
      $('#hd-index').textContent = '-';
      msg.textContent = '렌더 끝. 함수 안의 변수는 사라졌지만 사물함(hooks 배열)의 값은 남아 있습니다.';
      btns.forEach((b) => (b.disabled = false));
    }

    $('#hd-inc').addEventListener('click', () => {
      pending.count = state.hooks[0] + 1;
      rerender(`setCount(${pending.count})`);
    });
    $('#hd-name').addEventListener('click', () => {
      state.nameIdx = (state.nameIdx + 1) % names.length;
      pending.name = names[state.nameIdx];
      rerender(`setName('${pending.name}')`);
    });
    show();
  })();

  // ============================================================ 데모 4: Batching
  (function batchDemo() {
    let n = 0;
    let renders = 0;
    const log = $('#bt-log');
    const add = (text, cls) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (cls) li.className = cls;
      log.append(li);
      log.scrollTop = log.scrollHeight;
    };
    const show = () => {
      $('#bt-n').textContent = n;
      $('#bt-renders').textContent = renders;
    };

    function run(functional) {
      const noBatch = $('#bt-nobatch').checked;
      const snapshot = n; // 이번 렌더에서 핸들러가 보는 n
      log.replaceChildren();
      add(`클릭! 이번 렌더의 n 스냅샷 = ${snapshot}`);
      let value = n;
      for (let i = 1; i <= 3; i++) {
        if (functional) {
          const prev = value;
          value = prev + 1;
          add(`${i}) setN(p => p + 1) → 큐: p=${prev} 를 받아 ${value}`);
        } else {
          value = snapshot + 1;
          add(`${i}) setN(n + 1) → 스냅샷 n=${snapshot} 이라 항상 ${value}`);
        }
        if (noBatch) {
          renders++;
          add(`   → 바로 렌더링 (렌더 #${renders})`, 'render');
        }
      }
      n = value;
      if (!noBatch) {
        renders++;
        add(`핸들러 끝 → 모아 둔 업데이트로 렌더링 1번 (렌더 #${renders})`, 'render');
      }
      add(`결과: n = ${n}` + (functional ? '' : '  (3이 아니라 1만 늘어남!)'));
      show();
    }
    $('#bt-value').addEventListener('click', () => run(false));
    $('#bt-fn').addEventListener('click', () => run(true));
    $('#bt-reset').addEventListener('click', () => {
      n = 0;
      renders = 0;
      log.replaceChildren();
      show();
    });
    show();
  })();
})();
