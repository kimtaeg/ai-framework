// 학습 도우미 챗봇 (화면 쪽, 모든 페이지 공용). 실제 Gemini 호출은 서버의 /api/chat 이 한다 — API 키는 브라우저에 없음.
(function () {
  'use strict';
  const STORE = 'mini-react-guide-chat:v1';
  const MAX_SEND = 16; // 서버로 보내는 최근 메시지 수
  const SUGGESTIONS = [
    '지금 진행 상황에서 다음에 뭘 보면 돼?',
    'Diff 5가지 케이스를 쉽게 설명해줘',
    'key 는 왜 필요해?',
    'Hooks 는 상태를 어떻게 유지해?',
    'setState 를 3번 해도 렌더가 1번인 이유는?',
    '발표 예상 질문 하나 내줘',
  ];

  // ---------------------------------------------------------------- DOM
  const fab = document.createElement('button');
  fab.className = 'chat-fab';
  fab.type = 'button';
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = '🤖 <span>학습 도우미</span>';

  const panel = document.createElement('section');
  panel.className = 'chat-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', '학습 도우미 챗봇');
  panel.innerHTML = `
    <div class="chat-head">
      <b>🤖 학습 도우미</b>
      <span class="chat-status" data-status>확인 중…</span>
      <span class="chat-spacer"></span>
      <button type="button" class="ghost small" data-clear title="대화 지우기">지우기</button>
      <button type="button" class="ghost small" data-close aria-label="닫기">✕</button>
    </div>
    <div class="chat-log" data-log aria-live="polite"></div>
    <div class="chat-chips" data-chips></div>
    <form class="chat-form" data-form>
      <textarea data-input rows="2" placeholder="이 페이지나 miniReact 에 대해 물어보세요 (Enter 보내기, Shift+Enter 줄바꿈)" aria-label="질문"></textarea>
      <button type="submit" class="primary" data-send>보내기</button>
    </form>
    <p class="chat-note">답변은 AI 가 만든 것이라 틀릴 수 있어요. 중요한 내용은 이론 페이지와 코드로 확인하세요.</p>`;
  document.body.append(fab, panel);

  const q = (s) => panel.querySelector(s);
  const log = q('[data-log]');
  const input = q('[data-input]');
  const status = q('[data-status]');
  let messages = [];
  let busy = false;
  let enabled = false;

  try {
    messages = JSON.parse(localStorage.getItem(STORE)) || [];
  } catch (e) {
    messages = [];
  }
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(messages.slice(-40))); } catch (e) { /* 저장 불가 */ }
  };

  // ---------------------------------------------------------------- 안전한 마크다운 → HTML
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // ---------------------------------------------------------------- 사이트 탭 (답변 속 링크/이름 → 바로 가기)
  // [경로, 화면에 보일 이름, 답변에서 이 탭을 가리키는 표현들]
  const TABS = [
    ['/guide/index.html', '학습 가이드', ['학습 가이드']],
    // 'Phase 1' 만으로는 너무 흔하므로, 1주차 페이지를 가리키는 표현만 센다
    ['/phase1/index.html', 'Phase 1 · Diff', ['Phase 1 · Diff', 'Diff Playground', 'Phase 1 페이지']],
    ['/phase2/index.html', 'Phase 2 · Hooks', ['Phase 2 · Hooks', '스터디 플래너', 'Phase 2 페이지']],
    ['/examples/index.html', '예제', ['예제 모음', '예제 페이지', '예제 탭']],
    ['/sandbox/index.html', '샌드박스', ['샌드박스']],
    ['/walkthrough/index.html', '코드 해설', ['코드 해설']],
    ['/theory/index.html', 'React 이론', ['React 이론', '이론 페이지', '이론 탭']],
    ['/deepdive/index.html', '개념 더 파고들기', ['개념 더 파고들기', '더 파고들기']],
    ['/cheatsheet/index.html', '한 장 요약', ['한 장 요약']],
    ['/docs/index.html', '설명서', ['설명서']],
  ];
  const DIRS = TABS.map(([p]) => p.split('/')[1]);

  /**
   * 모델이 쓴 주소를 이 사이트 경로로 맞춘다. 사이트 밖(https 제외) 주소면 null.
   *  guide/index.html, ./guide/, ../guide/index.html#x, http://localhost:5200/guide/index.html, /guide → /guide/index.html
   */
  function normalizeUrl(raw) {
    let url = String(raw).trim();
    const local = url.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i);
    if (local) url = local[1] || '/';
    if (/^https:\/\//i.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null; // javascript:, data:, http:// 외부 등
    if (url.startsWith('#')) return url;
    url = url.replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '');
    const m = url.match(/^([a-z0-9-]+)(?:\/(?:index\.html)?)?(#[\w-]*)?$/i);
    if (m && DIRS.includes(m[1].toLowerCase())) return `/${m[1].toLowerCase()}/index.html${m[2] || ''}`;
    if (/^(index\.html)?$/.test(url)) return '/index.html';
    return '/' + url.replace(/\/(#|$)/, '/index.html$1'); // guide/ → /guide/index.html
  }

  /** 답변에 나온 탭 목록 (링크든 이름이든, 나온 순서대로) */
  function mentionedTabs(src) {
    const found = new Map(); // 탭 경로 → { url (#위치 포함 가능), at (처음 나온 위치) }
    const add = (base, url, at) => {
      const f = found.get(base);
      if (!f) found.set(base, { url, at });
      else {
        f.at = Math.min(f.at, at);
        if (!f.url.includes('#') && url.includes('#')) f.url = url; // #위치가 있는 쪽을 쓴다
      }
    };
    const plain = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    for (const m of plain.matchAll(/\]\(([^)\s]+)\)/g)) {
      const url = normalizeUrl(m[1]);
      const tab = url && TABS.find(([p]) => url.split('#')[0] === p);
      if (tab) add(tab[0], url, m.index);
    }
    for (const [path, , names] of TABS) {
      const week1 = !path.startsWith('/week2/');
      for (const n of names) {
        // "2주차 설명서" 의 '설명서' 를 1주차 설명서로 세지 않는다
        for (let i = plain.indexOf(n); i >= 0; i = plain.indexOf(n, i + 1)) {
          if (week1 && /2주차\s*(?:의\s*)?$/.test(plain.slice(Math.max(0, i - 6), i))) continue;
          add(path, path, i);
          break;
        }
      }
    }
    return [...found.values()].sort((a, b) => a.at - b.at).map((f) => f.url);
  }

  function tabLinks(src) {
    const here = location.pathname.replace(/\/$/, '/index.html');
    const paths = mentionedTabs(src).slice(0, 5);
    if (!paths.length) return '';
    const links = paths.map((url) => {
      const tab = TABS.find(([p]) => url.startsWith(p));
      const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
      const current = here.endsWith(tab[0]) ? ' (지금 페이지)' : '';
      return `<a class="chat-tab" href="${esc(url)}">${esc(tab[1])}${hash ? ` <small>${esc(hash)}</small>` : ''}${current}</a>`;
    });
    return `<div class="chat-tabs"><span>바로 가기</span>${links.join('')}</div>`;
  }

  /** 모델 답변 = 본문 + 답변에 나온 탭 바로 가기 */
  const answer = (src) => markdown(src) + tabLinks(src);

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        // 이 사이트 안의 주소와 https 만 링크로 (상대 경로·localhost 주소는 사이트 경로로 맞춘다)
        const fixed = normalizeUrl(url.replace(/&amp;/g, '&'));
        if (!fixed) return label;
        if (/^https:\/\//.test(fixed)) return `<a href="${esc(fixed)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        return `<a href="${esc(fixed)}">${label}</a>`;
      });
  }
  function markdown(src) {
    const out = [];
    const blocks = src.split(/```/);
    blocks.forEach((block, i) => {
      if (i % 2 === 1) {
        const code = block.replace(/^[a-z]*\n/i, '');
        out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
        return;
      }
      let list = null;
      for (const raw of block.split('\n')) {
        const line = raw.trimEnd();
        const ul = line.match(/^\s*[-*]\s+(.*)/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
        if (ul || ol) {
          const tag = ul ? 'ul' : 'ol';
          if (!list || list.tag !== tag) {
            if (list) out.push(`</${list.tag}>`);
            list = { tag };
            out.push(`<${tag}>`);
          }
          out.push(`<li>${inline((ul || ol)[1])}</li>`);
          continue;
        }
        if (list) {
          out.push(`</${list.tag}>`);
          list = null;
        }
        if (!line.trim()) continue;
        const h = line.match(/^#{1,4}\s+(.*)/);
        out.push(h ? `<p><b>${inline(h[1])}</b></p>` : `<p>${inline(line)}</p>`);
      }
      if (list) out.push(`</${list.tag}>`);
    });
    return out.join('');
  }

  // 테스트에서 확인할 수 있도록 (화면 동작에는 쓰지 않음)
  window.__miniChat = { normalizeUrl, mentionedTabs };

  // ---------------------------------------------------------------- 화면 그리기
  function bubble(role, html, cls = '') {
    const div = document.createElement('div');
    div.className = `chat-msg ${role} ${cls}`.trim();
    div.innerHTML = html;
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function renderAll() {
    log.replaceChildren();
    if (!messages.length) {
      bubble('model', markdown('안녕하세요! miniReact 학습 도우미예요. 어느 페이지에서든 물어보세요. **지금 보고 있는 페이지**와 학습 가이드 진행 상황을 보고 다음에 볼 것을 추천하거나, 개념을 쉽게 풀어 설명하고, 내 설명을 **채점**해 드릴 수 있어요. 아래 버튼으로 시작해 보세요.'), 'intro');
    }
    for (const m of messages) bubble(m.role, m.role === 'user' ? `<p>${esc(m.text).replace(/\n/g, '<br>')}</p>` : answer(m.text));
  }

  q('[data-chips]').replaceChildren(...SUGGESTIONS.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-chip';
    b.textContent = s;
    b.addEventListener('click', () => ask(s));
    return b;
  }), (() => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-chip';
    b.textContent = '✍️ 내 설명 채점해줘';
    b.addEventListener('click', () => {
      input.value = '내 설명 채점해줘: ';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return b;
  })());

  function setupHelp(reason) {
    const fileMode = location.protocol === 'file:';
    const text = fileMode
      ? '챗봇은 **서버로 열었을 때만** 동작해요. 터미널에서 `npm start` 를 실행한 뒤 터미널에 나오는 `http://localhost:...` 주소로 열어 주세요.'
      : `챗봇이 꺼져 있어요${reason ? ` (${reason})` : ''}. 설정 방법:\n1. 프로젝트 폴더에 \`.env\` 파일을 만들고 한 줄 적기: \`GEMINI_API_KEY=발급받은키\`\n2. 터미널에서 서버를 껐다가 \`npm start\` 로 다시 실행\n3. 이 페이지 새로고침\n키는 서버에만 있고 브라우저로 보내지 않아요. \`.env\` 는 이 사이트에서 열리지 않도록 막아 두었습니다.`;
    bubble('model', markdown(text), 'system');
  }

  function setStatus(on, label) {
    enabled = on;
    status.textContent = label;
    status.className = `chat-status ${on ? 'on' : 'off'}`;
    q('[data-send]').disabled = !on;
  }

  async function checkStatus() {
    if (location.protocol === 'file:') {
      setStatus(false, '서버 필요');
      setupHelp();
      return;
    }
    try {
      const r = await fetch('/api/chat', { method: 'GET' });
      const data = await r.json();
      if (data.enabled) setStatus(true, `사용 가능 · ${data.model}`);
      else {
        setStatus(false, '꺼짐');
        setupHelp('API 키 없음');
      }
    } catch (e) {
      setStatus(false, '연결 안 됨');
      setupHelp('서버에 연결하지 못함');
    }
  }

  /** 학습 가이드에서 체크한 단계 (가이드 페이지가 아니면 저장된 체크 기록에서 읽는다) */
  const STEP_LABELS = {
    1: '1. 큰 그림', 2: '2. Virtual DOM', 3: '3. Diff 5가지 케이스', 4: '4. key', 5: '5. Patch',
    6: '6. Hooks 원리', 7: '7. setState 와 Batching', 8: '8. useEffect, useRef', 9: '9. 제어 컴포넌트',
    10: '10. 성능', sandbox: '11. 직접 만들어 보기', 11: '12. 발표 준비',
  };
  function progress() {
    const onPage = document.querySelectorAll('#road li');
    if (onPage.length) return [...document.querySelectorAll('#road li.done .st')].map((el) => el.textContent.trim());
    try {
      const saved = JSON.parse(localStorage.getItem('mini-react-guide:v1')) || {};
      return Object.keys(STEP_LABELS).filter((k) => saved[k]).map((k) => STEP_LABELS[k]);
    } catch (e) {
      return [];
    }
  }

  /** 지금 보고 있는 페이지 (챗봇이 이 페이지에 맞춰 안내하도록) */
  function currentPage() {
    const nav = document.querySelector('.topbar nav a[aria-current="page"]');
    const name = (nav ? nav.textContent : document.title).trim();
    return `${name} (${location.pathname}${location.hash})`.slice(0, 100);
  }

  // ---------------------------------------------------------------- 질문 보내기
  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    if (!enabled) {
      setupHelp();
      return;
    }
    busy = true;
    q('[data-send]').disabled = true;
    input.value = '';
    messages.push({ role: 'user', text });
    save();
    bubble('user', `<p>${esc(text).replace(/\n/g, '<br>')}</p>`);
    const wait = bubble('model', '<span class="dots"><i></i><i></i><i></i></span>', 'pending');
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages.slice(-MAX_SEND), progress: progress(), page: currentPage() }),
      });
      const data = await r.json().catch(() => ({}));
      wait.remove();
      if (!r.ok || !data.text) {
        if (data.error === 'NO_KEY') {
          setStatus(false, '꺼짐');
          setupHelp('API 키 없음');
        } else {
          bubble('model', `<p>⚠ ${esc(data.error || data.message || `오류 (HTTP ${r.status})`)}</p>`, 'error');
        }
        messages.pop(); // 실패한 질문은 대화 기록에서 뺀다 (다시 보낼 수 있게)
        save();
        input.value = text;
        return;
      }
      messages.push({ role: 'model', text: data.text });
      save();
      const msg = bubble('model', answer(data.text));
      if (data.fallback) {
        const note = document.createElement('p');
        note.className = 'chat-fallback';
        note.textContent = `기본 모델이 바빠서 ${data.model} 로 대신 답했어요.`;
        msg.append(note);
      }
    } catch (e) {
      wait.remove();
      bubble('model', `<p>⚠ 서버에 연결하지 못했습니다: ${esc(e.message)}</p>`, 'error');
      messages.pop();
      save();
      input.value = text;
    } finally {
      busy = false;
      q('[data-send]').disabled = !enabled;
    }
  }

  // ---------------------------------------------------------------- 이벤트
  let checked = false;
  function open(on) {
    panel.hidden = !on;
    fab.setAttribute('aria-expanded', String(on));
    fab.classList.toggle('open', on);
    if (on) {
      if (!checked) {
        checked = true;
        renderAll();
        checkStatus();
      }
      input.focus();
    }
  }
  fab.addEventListener('click', () => open(panel.hidden));
  q('[data-close]').addEventListener('click', () => open(false));
  q('[data-clear]').addEventListener('click', () => {
    messages = [];
    save();
    renderAll();
    if (!enabled) checkStatus();
  });
  q('[data-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  // 챗봇 입력 중의 키는 페이지 단축키(Phase 1 의 Ctrl+Enter = Patch 등)로 전달하지 않는다
  panel.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    } else if (e.key === 'Escape') open(false);
  });
  window.__guideChat = { open, ask, markdown };
})();
