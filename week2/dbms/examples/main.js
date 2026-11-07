// 미니 DBMS 예제 페이지 — 실제 SQL 처리기 + B+ 트리 (저장소만 메모리)
import { MiniRedis } from '../../redis/miniredis.js';
import { Database, planLabel } from '../engine.js';
import { MemoryStorage } from '../storage.js';
import { seedRows } from '../seed.js';
import { flags, EXPERIMENTS, signup, signupSql, BoardService, keysetPage, offsetPage, EmailIndex } from './apps.js';
import { initLab, stat } from '../../shared/examples-lab.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clone = (o) => JSON.parse(JSON.stringify(o));
const USERS = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
const POSTS = { posts: { columns: [{ name: 'id', type: 'INT' }, { name: 'title', type: 'TEXT' }, { name: 'author', type: 'TEXT' }] } };

// ============================================================ 1. 회원 가입
const sDb = new Database(new MemoryStorage(clone(USERS)), { order: 16 });
sDb.execute("INSERT INTO users (name, age, email) VALUES ('김정글', 25, 'jungle@ex.com')");
function paintUsers() {
  const [r] = sDb.execute('SELECT * FROM users');
  $('#signup-rows').innerHTML = r.rows.map((row) => `<tr>${row.map((v) => `<td class="mono">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('');
}
function previewSql() {
  $('#signup-sql').textContent = signupSql({ name: $('#su-name').value, age: $('#su-age').value, email: $('#su-email').value });
}
['#su-name', '#su-age', '#su-email'].forEach((s) => $(s).addEventListener('input', previewSql));
$('#signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const before = sDb.tables.users.index.size;
  const r = signup(sDb, { name: $('#su-name').value, age: $('#su-age').value, email: $('#su-email').value });
  paintUsers();
  const added = sDb.tables.users.index.size - before;
  stat('signup', r.ok
    ? `가입 완료 · 새 회원 <b class="${added > 1 ? 'err' : ''}">${added}명</b> (id ${r.ids.join(', ')})${added > 1 ? ' · <span class="err">한 번 가입에 여러 행!</span>' : ''}<span class="last">INSERT ${added}건</span>`
    : `<span class="err">✗ ${esc(r.error)}</span><span class="last">저장 안 됨</span>`);
});
$('#su-quote').addEventListener('click', () => { $('#su-name').value = "O'Brien"; previewSql(); });
$('#su-hack').addEventListener('click', () => { $('#su-name').value = "해커', 1, 'h@x'), ('관리자', 99, 'admin@x') -- "; previewSql(); });
paintUsers();
previewSql();

// ============================================================ 2. 게시판 목록 캐시
const bDb = new Database(new MemoryStorage(clone(POSTS)), { order: 32 });
bDb.execute("INSERT INTO posts (title, author) VALUES ('해시 테이블 정리', '김정글'), ('B+ 트리 분할 그림', '이디비'), ('AOF vs RDB', '박레디스'), ('스레드 풀 질문', '최워커'), ('TTL 은 어떻게?', '정만료'), ('캐시 무효화 팁', '한태그')");
const board = new BoardService(bDb, new MiniRedis(), { latencyMs: 120, pageSize: 5 });
async function showBoard(extra = '') {
  const r = await board.latest();
  $('#board-list').innerHTML = r.rows.map(([id, title, author]) => `<li><span class="mono muted">#${id}</span> ${esc(title)} <span class="muted small">— ${esc(author)}</span></li>`).join('');
  stat('board', `이번 응답 <b class="${r.hit ? '' : 'err'}">${r.hit ? 'HIT (캐시)' : 'MISS (DB)'}</b> · ${r.ms.toFixed(0)}ms · DB 조회 누적 <b>${board.dbQueries}</b>${extra}<span class="last">DB 의 글 ${bDb.tables.posts.index.size}개</span>`);
  return r;
}
$('#board-view').addEventListener('click', () => showBoard());
$('#board-write').addEventListener('click', async () => {
  const title = $('#board-title').value.trim() || `새 글 ${bDb.tables.posts.nextId}`;
  const w = await board.write(title, '나');
  $('#board-title').value = '';
  const r = await showBoard();
  const visible = r.rows.some(([id]) => id === w.id);
  stat('board', `#${w.id} 저장 → 캐시 ${w.invalidated}개 무효화 → 새 글이 ${visible ? '<b>보임</b>' : '<b class="err">안 보임 (옛 캐시)</b>'}<span class="last">${r.hit ? 'HIT' : 'MISS'} · DB 조회 누적 ${board.dbQueries}</span>`);
});
showBoard();

// ============================================================ 3. 페이지 넘기기
const pDb = new Database(new MemoryStorage(clone(POSTS)), { order: 64 });
pDb.insert({ type: 'insert', table: 'posts', columns: null, rows: Array.from({ length: 20000 }, (_, i) => [{ kind: 'string', value: `게시글 ${i + 1}` }, { kind: 'string', value: `작성자${i % 50}` }]), pos: null });
let feedLast = 0, feedPage = 0;
$('#page-go').addEventListener('click', () => {
  const page = Math.max(1, Math.min(2000, Number($('#page-n').value) || 1));
  const off = offsetPage(pDb, page);
  const ks = keysetPage(pDb, (page - 1) * 10);
  const same = off.rows.map((r) => r[0]).join() === ks.rows.map((r) => r[0]).join();
  $('#page-out').innerHTML = `<div class="cmp-row"><span>앞에서부터 건너뛰기</span><div class="bar miss" style="width:100%"></div><b>${off.scanned.toLocaleString()}개 읽음</b></div><div class="cmp-row"><span>id 기준 (id &gt; ${(page - 1) * 10})</span><div class="bar hit" style="width:${Math.max(0.5, (ks.scanned / off.scanned) * 100)}%"></div><b>${ks.scanned}개 읽음</b></div>`;
  stat('paging', `${page}쪽 · 같은 결과 ${same ? '✓' : '✗'} (#${ks.rows[0]?.[0]} ~ #${ks.rows.at(-1)?.[0]})<span class="last">${(off.scanned / ks.scanned).toFixed(0)}배 덜 읽음</span>`);
});
$('#page-next').addEventListener('click', () => {
  const r = keysetPage(pDb, feedLast);
  feedPage++;
  $('#page-feed').innerHTML = `${feedPage}쪽 · <span class="mono">WHERE id &gt; ${feedLast} LIMIT 10</span> · ${planLabel({ type: r.plan })} · 읽은 레코드 <b>${r.scanned}</b><br>${r.rows.map((x) => `#${x[0]}`).join(' ')}`;
  feedLast = r.nextLast;
});

// ============================================================ 4. 이메일로 찾기
const eDb = new Database(new MemoryStorage(clone(USERS)), { order: 64 });
seedRows(eDb, 'users', 50000);
const emails = new EmailIndex(eDb, new MiniRedis());
const t0 = performance.now();
const indexed = emails.rebuild();
$('#email-built').textContent = `기존 회원 ${indexed.toLocaleString()}명의 email → id 를 미니 레디스에 저장 (${(performance.now() - t0).toFixed(0)}ms, 서버 시작 시 1회)`;
$('#email-find').addEventListener('click', () => {
  const email = $('#email-q').value.trim();
  const a0 = performance.now(); const a = emails.scan(email); const aMs = performance.now() - a0;
  const b0 = performance.now(); const b = emails.find(email); const bMs = performance.now() - b0;
  $('#email-out').innerHTML = `<div class="cmp-row"><span>선형 탐색</span><div class="bar miss" style="width:100%"></div><b>${aMs.toFixed(2)}ms · ${a.scanned.toLocaleString()}개</b></div><div class="cmp-row"><span>레디스 보조 인덱스</span><div class="bar hit" style="width:${Math.max(0.5, (bMs / aMs) * 100)}%"></div><b>${bMs.toFixed(3)}ms · ${b.scanned}개</b></div>`;
  stat('email', b.row ? `찾음: #${b.row[0]} ${esc(b.row[1])} (${esc(b.row[3])})<span class="last">${(aMs / Math.max(bMs, 0.001)).toFixed(0)}배 빠름</span>` : '없는 이메일');
});
$('#email-signup').addEventListener('click', () => {
  const email = $('#email-new').value.trim();
  if (!email) return;
  const r = emails.signUp('새회원', email);
  const n = emails.countEmail(email);
  stat('email', r.ok ? `가입 완료 #${r.id} — DB 에 INSERT + 레디스에 SET email:… ${r.id} · 이 이메일 회원 <b class="${n > 1 ? 'err' : ''}">${n}명</b>${n > 1 ? ' <span class="err">(중복 가입!)</span>' : ''}` : `<span class="err">거절: ${r.reason}</span> (SET NX 실패 = 이미 있는 키)<span class="last">이 이메일 회원 ${n}명</span>`);
});

// ============================================================ 실험실
initLab({ experiments: EXPERIMENTS, flags, onChange: (app) => { if (app === 'signup' || app === null) previewSql(); } });
