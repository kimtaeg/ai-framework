// 미니 DBMS Phase 1 · SQL 처리기 — 실제 엔진 코드를 브라우저에서 그대로 실행 (저장소만 메모리)
import { tokenize, parse } from '../sql.js';
import { Database, planLabel } from '../engine.js';
import { MemoryStorage } from '../storage.js';
import { esc, table, treeHtml } from '../view.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
};
// 오래된 브라우저에는 structuredClone 이 없어서 JSON 으로 복사
const cloneSchema = () => JSON.parse(JSON.stringify(SCHEMA));

// ============================================================ 1. SQL 콘솔
/** 어떤 줄을 읽었는지 기록하는 메모리 저장소 (화면에 "읽은 줄" 표시) */
class TracingStorage extends MemoryStorage {
  constructor(schema) {
    super(schema);
    this.touched = {};
  }
  read(table, loc) {
    (this.touched[table] ??= new Set()).add(loc);
    return super.read(table, loc);
  }
  *scan(table) {
    for (const [loc, line] of super.scan(table)) {
      (this.touched[table] ??= new Set()).add(loc);
      yield [loc, line];
    }
  }
}

const store = new TracingStorage(cloneSchema());
const db = new Database(store, { order: 4 });
db.execute(`INSERT INTO users (name, age, email) VALUES
  ('김정글', 25, 'jungle@ex.com'), ('이리액트', 31, 'react@ex.com'), ('박레디스', 28, NULL),
  ('최디비', 35, 'db@ex.com'), ('정트리', 22, 'tree@ex.com');
INSERT INTO products (name, price, category) VALUES
  ('기계식 키보드', 89000, '키보드'), ('무선 마우스', 32000, '마우스'), ('27인치 모니터', 259000, '모니터');`);

const EXAMPLES = {
  'id 로 찾기 (인덱스)': 'SELECT * FROM users WHERE id = 3;',
  '다른 열로 찾기 (선형 탐색)': "SELECT name, email FROM users WHERE name = '최디비';",
  'id 범위 (인덱스 범위)': 'SELECT id, name FROM users WHERE id BETWEEN 2 AND 4;',
  '여러 조건 + LIMIT': 'SELECT * FROM users WHERE age >= 25 AND id > 1 LIMIT 2;',
  'INSERT 여러 행': "INSERT INTO users (name, age, email) VALUES ('한해시', 27, 'hash@ex.com'), ('윤스레드', 33, 'thread@ex.com');\nSELECT * FROM users WHERE id >= 6;",
  '열 생략 INSERT': "INSERT INTO products VALUES ('USB 허브', 45000, '케이블');\nSELECT * FROM products;",
  "따옴표·쉼표가 든 값": "INSERT INTO users (name, age, email) VALUES ('O''Brien, Jr.', 40, 'ob@ex.com');\nSELECT * FROM users WHERE name = 'O''Brien, Jr.';",
  '에러: 오타': 'SELEC * FROM users;',
  '에러: 타입': "INSERT INTO users (name, age) VALUES ('나이가 글자', 'twenty');",
  '에러: 없는 열': 'SELECT phone FROM users;',
};

$('#sql-examples').innerHTML = Object.keys(EXAMPLES).map((k) => `<option>${esc(k)}</option>`).join('');
$('#sql-examples').addEventListener('change', (e) => { $('#sql-input').value = EXAMPLES[e.target.value]; });
$('#sql-input').value = EXAMPLES['id 로 찾기 (인덱스)'];


function paintFiles() {
  $('#sql-files').innerHTML = Object.keys(SCHEMA).map((t) => {
    const lines = store.files[t];
    const touched = store.touched[t] ?? new Set();
    return `<b class="small">${t}.tbl <span class="muted">(${lines.length}줄 · B+ 트리 높이 ${db.tables[t].index.height})</span></b>
      <div class="filebox">${lines.map((l, i) => `<div class="${touched.has(i) ? 'hl' : ''}"><span class="off">${i}</span>${esc(l)}</div>`).join('') || '<span class="muted">(비어 있음)</span>'}</div>`;
  }).join('');
}

function runSql() {
  const sql = $('#sql-input').value;
  store.touched = {};
  // 파이프라인: 토큰 → AST → 계획 → 결과
  let tokens = null, ast = null;
  try {
    tokens = tokenize(sql);
    ast = parse(sql);
  } catch { /* 아래 execute 에서 같은 에러를 보여 줌 */ }
  $('#pipe-tokens').innerHTML = tokens ? tokens.slice(0, 60).map((t) => `<span class="tok ${t.type}" title="${t.type}">${esc(t.type === 'eof' ? 'EOF' : t.type === 'string' ? `'${t.value}'` : t.value)}</span>`).join('') : '<span class="bad">토큰화 실패</span>';
  $('#pipe-ast').textContent = ast ? JSON.stringify(ast.map(({ pos, text, ...rest }) => rest), (k, v) => (v && v.kind ? (v.kind === 'string' ? `'${v.value}'` : v.value) : v), 1) : '파싱 실패';
  try {
    const t0 = performance.now();
    const results = db.execute(sql);
    const ms = performance.now() - t0;
    $('#sql-out').innerHTML = results.map((r) => {
      if (r.type === 'insert') return `<div class="result-block"><div class="meta">INSERT → <b>${r.table}</b> ${r.count}건 · 받은 id <b>${r.ids.join(', ')}</b> · B+ 트리에 (id → 줄 위치) 등록</div></div>`;
      return `<div class="result-block"><div class="meta"><span class="plan ${r.plan.type}">${planLabel(r.plan)}</span> ${esc(r.plan.reason)} · 읽은 레코드 <b>${r.plan.scanned}</b>/${r.plan.total} · ${r.rows.length}행</div>${table(r.columns, r.rows)}</div>`;
    }).join('') + `<p class="small muted">전체 ${ms.toFixed(2)}ms</p>`;
    const sel = results.filter((r) => r.type === 'select');
    $('#pipe-plan').innerHTML = sel.length ? sel.map((r) => `<span class="plan ${r.plan.type}">${r.plan.type}</span><br><span class="small">${esc(r.plan.reason)}</span>`).join('<hr>') : '<span class="small">INSERT: 검사 → id 부여 → 파일 끝에 추가 → B+ 트리 등록</span>';
    $('#pipe-result').textContent = results.map((r) => (r.type === 'insert' ? `INSERT ${r.count}건` : `${r.rows.length}행 (읽음 ${r.plan.scanned})`)).join('\n');
  } catch (e) {
    $('#sql-out').innerHTML = `<div class="result-block"><span class="bad">✗ ${esc(e.message)}</span></div>`;
    $('#pipe-plan').textContent = '—';
    $('#pipe-result').textContent = '에러';
  }
  paintFiles();
  paintDbTree();
}
$('#sql-run').addEventListener('click', runSql);
$('#sql-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); }
});

function paintDbTree() {
  $('#sql-tree').innerHTML = treeHtml(db.tables.users.index);
}

runSql();
