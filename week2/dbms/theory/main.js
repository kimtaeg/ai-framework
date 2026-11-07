// DBMS 이론 페이지 — 공통 동작(검색·목차·필터) + 직접 해보는 예제 2개 (실제 처리기 · 엔진)
import { initTheoryPage } from '../../shared/theory-page.js';
import { tokenize, parse } from '../sql.js';
import { Database, planLabel } from '../engine.js';
import { MemoryStorage } from '../storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
initTheoryPage();

// ============================================================ 예제 1: 토큰과 AST
function showParse() {
  const sql = $('#pd-sql').value;
  try {
    const tokens = tokenize(sql);
    $('#pd-tokens').innerHTML = tokens.map((t) => `<span class="tok ${t.type}" title="${t.type} · ${t.pos.line}행 ${t.pos.col}열">${esc(t.type === 'eof' ? 'EOF' : t.type === 'string' ? `'${t.value}'` : t.value)}</span>`).join(' ');
  } catch (e) {
    $('#pd-tokens').innerHTML = `<span class="bad">토큰화 실패: ${esc(e.message)}</span>`;
    $('#pd-ast').textContent = '';
    return;
  }
  try {
    const ast = parse(sql).map(({ pos, text, ...rest }) => rest);
    $('#pd-ast').textContent = JSON.stringify(ast, (k, v) => (v && v.kind ? (v.kind === 'string' ? `'${v.value}'` : v.value) : v), 1);
  } catch (e) {
    $('#pd-ast').textContent = `파싱 실패: ${e.message}`;
  }
}
$('#pd-sql').addEventListener('input', showParse);
$$('#demo-parse [data-sql]').forEach((b) => b.addEventListener('click', () => { $('#pd-sql').value = b.dataset.sql; showParse(); }));
showParse();

// ============================================================ 예제 2: 실행 계획
const db = new Database(new MemoryStorage({ users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } }), { order: 16 });
db.insert({ type: 'insert', table: 'users', columns: null, rows: Array.from({ length: 1000 }, (_, i) => [{ kind: 'string', value: `u${i + 1}` }, { kind: 'number', value: 20 + (i % 40) }, { kind: 'string', value: `u${i + 1}@x` }]), pos: null });
function runPlan() {
  const where = $('#pl-where').value.trim();
  try {
    const [r] = db.execute(`SELECT * FROM users WHERE ${where}`);
    $('#pl-msg').innerHTML = `<span class="plan ${r.plan.type}">${planLabel(r.plan)}</span> ${esc(r.plan.reason)} · 읽은 레코드 <b>${r.plan.scanned.toLocaleString()}</b> / 1,000 · 결과 ${r.rows.length}행`;
  } catch (e) {
    $('#pl-msg').innerHTML = `<span class="bad">✗ ${esc(e.message)}</span>`;
  }
}
$('#pl-run').addEventListener('click', runPlan);
$('#pl-where').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPlan(); });
$$('#demo-plan [data-where]').forEach((b) => b.addEventListener('click', () => { $('#pl-where').value = b.dataset.where; runPlan(); }));
runPlan();
