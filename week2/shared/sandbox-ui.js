/**
 * 2주차 샌드박스 화면 (레디스 / DBMS 공용) — 1주차 샌드박스와 같은 화면 구조
 *   틀 막대 · 코드 카드(조각, 줄 번호, 편집기) · 지금 틀 카드 · 콘솔 카드 · 오른쪽 상태 카드
 */
import { createEnv, runCode } from './sandbox-runner.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{ templates: Array<{id,title,desc,try,code}>, snippets: Array<{label, items: Array<[string,string]>}>, storeKey: string, showKeys?: boolean, showTables?: boolean }} opts
 */
export function mountSandbox({ templates, snippets, storeKey, showKeys = true, showTables = true }) {
  const editor = $('#code');
  let env = createEnv();
  let current = templates[0];
  let isRunning = false;
  let autoTimer = null;

  // ---------------------------------------------------------------- 저장
  function load() {
    try { return JSON.parse(localStorage.getItem(storeKey)) || null; } catch { return null; }
  }
  function save() {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ tpl: current.id, code: editor.value }));
      $('#saved').textContent = '자동 저장됨';
    } catch {
      $('#saved').textContent = '저장할 수 없는 환경';
    }
  }

  // ---------------------------------------------------------------- 틀
  function paintTemplates() {
    $('#tpl-list').innerHTML = templates.map((t) => `<button type="button" class="tpl small${t.id === current.id ? ' on' : ''}" data-tpl="${t.id}" title="${esc(t.desc)}">${esc(t.title)}</button>`).join('');
    $('#tpl-desc').textContent = current.desc;
    $('#tpl-try').innerHTML = (current.try ?? []).map((x) => `<li>${esc(x)}</li>`).join('');
  }
  $('#tpl-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]');
    if (!b) return;
    const t = templates.find((x) => x.id === b.dataset.tpl);
    if (editor.value !== current.code && editor.value.trim() && !confirm('지금 코드를 이 틀로 바꿀까요? (지금 코드는 사라집니다)')) return;
    current = t;
    editor.value = t.code;
    paintTemplates();
    paintGutter();
    save();
  });
  $('#reset').addEventListener('click', () => {
    if (editor.value !== current.code && !confirm('이 틀의 처음 코드로 되돌릴까요?')) return;
    editor.value = current.code;
    paintGutter();
    save();
  });

  // ---------------------------------------------------------------- 조각
  $('#snip-list').innerHTML = snippets.map((g, gi) => `<div class="snip-group"><span class="snip-label">${esc(g.label)}</span>${g.items.map(([name], i) => `<button type="button" class="snip" data-snip="${gi}:${i}">${esc(name)}</button>`).join('')}</div>`).join('');
  $('#snip-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-snip]');
    if (!b) return;
    const [gi, i] = b.dataset.snip.split(':').map(Number);
    insertAtCursor(snippets[gi].items[i][1] + '\n');
  });

  function insertAtCursor(text) {
    const s = editor.selectionStart, e = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
    editor.selectionStart = editor.selectionEnd = s + text.length;
    editor.focus();
    onEdit();
  }

  // ---------------------------------------------------------------- 편집기
  function paintGutter(errLine = null) {
    const n = editor.value.split('\n').length;
    $('#gutter').innerHTML = Array.from({ length: n }, (_, i) => `<div${i + 1 === errLine ? ' class="err"' : ''}>${i + 1}</div>`).join('');
    $('#gutter').scrollTop = editor.scrollTop;
  }
  function onEdit() {
    paintGutter();
    save();
    if ($('#auto').checked) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(run, 800);
    }
  }
  editor.addEventListener('input', onEdit);
  editor.addEventListener('scroll', () => { $('#gutter').scrollTop = editor.scrollTop; });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('  '); return; }
    if (e.key === 'Enter') {
      const before = editor.value.slice(0, editor.selectionStart);
      const indent = before.split('\n').pop().match(/^\s*/)[0] + (/[{(\[]\s*$/.test(before) ? '  ' : '');
      e.preventDefault();
      insertAtCursor('\n' + indent);
    }
  });

  // ---------------------------------------------------------------- 콘솔
  let count = 0;
  function log(cls, text) {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    $('#console').append(li);
    $('#console').scrollTop = $('#console').scrollHeight;
    count++;
    $('#console-count').textContent = count;
  }
  function clearConsole() {
    $('#console').innerHTML = '';
    count = 0;
    $('#console-count').textContent = '0';
  }
  $('#clear-console').addEventListener('click', clearConsole);

  // ---------------------------------------------------------------- 실행
  async function run() {
    if (isRunning) return;
    isRunning = true;
    $('#run').disabled = true;
    $('#error').hidden = true;
    if ($('#fresh').checked) env = createEnv();
    clearConsole();
    const r = await runCode(editor.value, env, {
      onLog: (e) => log(e.type === 'error' ? 'error' : e.type === 'time' ? 'warn' : '', e.text),
    });
    log('sys', `— ${r.error ? '에러로 멈춤' : '끝'} (${r.ms.toFixed(0)}ms)`);
    if (r.error) {
      $('#error').hidden = false;
      $('#error').innerHTML = `<b>실행 중 에러${r.error.line > 0 ? ` · ${r.error.line}번째 줄` : ''}</b><div>${esc(r.error.message)}</div>`;
    }
    paintGutter(r.error?.line ?? null);
    paintState();
    isRunning = false;
    $('#run').disabled = false;
  }
  $('#run').addEventListener('click', run);
  $('#wipe').addEventListener('click', () => { env = createEnv(); paintState(); clearConsole(); log('sys', '레디스와 DB 를 비웠습니다.'); });

  // ---------------------------------------------------------------- 상태
  function paintState() {
    if (showKeys) {
      const keys = env.redis.dump();
      const now = Date.now();
      $('#sb-keys').innerHTML = keys.length
        ? keys.slice(0, 50).map((k) => `<tr class="${k.expired ? 'expired' : ''}"><td class="mono">${esc(k.key)}</td><td class="mono">${esc(k.value.length > 24 ? k.value.slice(0, 24) + '…' : k.value)}</td><td>${k.expireAt === null ? '—' : k.expired ? '만료' : `${((k.expireAt - now) / 1000).toFixed(1)}초`}</td></tr>`).join('') + (keys.length > 50 ? `<tr><td colspan="3" class="muted">… 외 ${keys.length - 50}개</td></tr>` : '')
        : '<tr><td colspan="3" class="muted">비어 있음</td></tr>';
    }
    if (showTables) {
      $('#sb-tables').innerHTML = Object.entries(env.db.info()).map(([t, i]) => `<tr><td class="mono">${t}</td><td>${i.rows.toLocaleString()}</td><td>${i.height}</td></tr>`).join('');
    }
  }

  // ---------------------------------------------------------------- 시작
  const saved = load();
  current = templates.find((t) => t.id === saved?.tpl) ?? templates[0];
  editor.value = saved?.code ?? current.code;
  paintTemplates();
  paintGutter();
  paintState();
  return { run, get env() { return env; } };
}
