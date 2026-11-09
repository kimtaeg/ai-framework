// 미니 DBMS Phase 2 · B+ 트리 인덱스 — 실제 엔진 코드를 브라우저에서 그대로 실행 (저장소만 메모리)
import { Database } from '../engine.js';
import { MemoryStorage } from '../storage.js';
import { BPlusTree } from '../bptree.js';
import { seedRows } from '../seed.js';
import { treeHtml } from '../view.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
};
// 오래된 브라우저에는 structuredClone 이 없어서 JSON 으로 복사
const cloneSchema = () => JSON.parse(JSON.stringify(SCHEMA));

// ============================================================ 1. B+ 트리 시각화
let tree = new BPlusTree(4);
let lastInserted = null;
let traced = null;


function paintTree(msg) {
  $('#bpt-view').innerHTML = treeHtml(tree, { path: traced?.path, hit: traced?.found ? Number($('#bpt-key').value) : null, fresh: lastInserted });
  $('#bpt-stats').innerHTML = [
    ['차수 (최대 자식)', tree.order], ['노드당 최대 키', tree.maxKeys], ['키 개수', tree.size], ['높이', tree.height], ['분할 횟수', tree.stats.splits],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
  if (msg !== undefined) $('#bpt-msg').innerHTML = msg;
}

function insertKey(k) {
  if (tree.has(k)) return `<span class="warnc">${k} 은(는) 이미 있습니다 (id 는 유일해야 함)</span>`;
  const h0 = tree.height, s0 = tree.stats.splits;
  tree.insert(k, `row${k}`);
  lastInserted = k;
  traced = null;
  const splits = tree.stats.splits - s0;
  return `${k} 삽입${splits ? ` → 노드가 넘쳐서 <b>${splits}번 분할</b>${tree.height > h0 ? ', <b>높이 +1</b> (루트가 쪼개짐)' : ''}` : ' → 자리 있음 (분할 없음)'}`;
}

$('#bpt-order').addEventListener('change', (e) => {
  const keys = [...tree.range()].map(([k]) => k);
  tree = new BPlusTree(Number(e.target.value));
  keys.forEach((k) => tree.insert(k, `row${k}`));
  traced = null;
  paintTree(`차수 ${tree.order} 로 다시 만들었습니다 (같은 키 ${keys.length}개).`);
});
$('#bpt-insert').addEventListener('click', () => {
  const k = Number($('#bpt-key').value);
  if (!Number.isInteger(k)) return paintTree('<span class="warnc">정수를 넣으세요.</span>');
  paintTree(insertKey(k));
});
$('#bpt-search').addEventListener('click', () => {
  const k = Number($('#bpt-key').value);
  traced = tree.trace(k);
  lastInserted = null;
  paintTree(`${k} 찾기: 루트부터 <b>${traced.path.length}개 노드</b>만 지나서 ${traced.found ? '<span class="ok">찾음</span>' : '<span class="bad">없음</span>'} (전체 ${tree.size}개를 다 보지 않음)`);
});
$('#bpt-seq').addEventListener('click', async () => {
  const start = tree.size ? tree.max() + 1 : 1;
  for (let k = start; k < start + 10; k++) {
    paintTree(insertKey(k));
    await sleep(180);
  }
});
$('#bpt-rand').addEventListener('click', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    let k;
    do k = 1 + Math.floor(Math.random() * 99); while (tree.has(k));
    msgs.push(insertKey(k));
  }
  paintTree(`무작위 10개 삽입 (${msgs.filter((m) => m.includes('분할')).length}번은 분할이 일어남)`);
});
$('#bpt-range').addEventListener('click', () => {
  const k = Number($('#bpt-key').value) || 1;
  const got = [...tree.range(k, k + 9)].map(([x]) => x);
  traced = null;
  paintTree(`${k} ~ ${k + 9} 범위: 리프에서 시작해 <b>오른쪽 리프로 이어 가며</b> 읽음 → [${got.join(', ')}]`);
});
$('#bpt-reset').addEventListener('click', () => {
  tree = new BPlusTree(Number($('#bpt-order').value));
  traced = null;
  lastInserted = null;
  paintTree('비웠습니다.');
});
for (let k = 1; k <= 12; k++) tree.insert(k * 5, `row${k * 5}`);
paintTree('5, 10, …, 60 이 들어 있습니다. 숫자를 넣고 삽입/검색해 보세요.');

// ============================================================ 2. 성능 비교 (브라우저 메모리)
$('#bench-run').addEventListener('click', async () => {
  const n = Number($('#bench-n').value);
  const btn = $('#bench-run');
  btn.disabled = true;
  $('#bench-out').innerHTML = `<p class="small">${n.toLocaleString()}건 만드는 중…</p>`;
  await sleep(30);
  const bdb = new Database(new MemoryStorage(cloneSchema()), { order: 64 });
  let t0 = performance.now();
  seedRows(bdb, 'users', n);
  const insertMs = performance.now() - t0;
  await sleep(10);
  const Q = 200, S = 5;
  t0 = performance.now();
  for (let i = 0; i < Q; i++) bdb.execute(`SELECT * FROM users WHERE id = ${1 + Math.floor(Math.random() * n)}`);
  const idx = (performance.now() - t0) / Q;
  t0 = performance.now();
  let scanned = 0;
  for (let i = 0; i < S; i++) scanned += bdb.execute(`SELECT * FROM users WHERE email = 'user${1 + Math.floor(Math.random() * n)}@jungle.test'`)[0].plan.scanned;
  const scan = (performance.now() - t0) / S;
  const max = Math.max(idx, scan);
  $('#bench-out').innerHTML =
    `<div class="stats"><div class="stat"><span>INSERT ${n.toLocaleString()}건</span><b>${(insertMs / 1000).toFixed(2)}초</b></div><div class="stat"><span>B+ 트리 높이</span><b>${bdb.tables.users.index.height}</b></div><div class="stat"><span>id = ? 평균</span><b class="ok">${idx.toFixed(3)}ms</b></div><div class="stat"><span>email = ? 평균</span><b class="warnc">${scan.toFixed(1)}ms</b></div><div class="stat"><span>차이</span><b>${Math.round(scan / idx).toLocaleString()}배</b></div></div>` +
    `<div class="bars"><div class="bar-row"><span>인덱스</span><div class="bar hit" style="width:${Math.max(0.5, (idx / max) * 100)}%"></div><span>${idx.toFixed(3)}ms</span></div><div class="bar-row"><span>선형 탐색</span><div class="bar miss" style="width:100%"></div><span>${scan.toFixed(1)}ms</span></div></div>` +
    `<p class="small">선형 탐색은 한 번에 평균 ${Math.round(scanned / S).toLocaleString()}개 레코드를 읽었고, 인덱스는 <b>1개</b>만 읽었습니다. 데이터가 10배가 되면 선형 탐색은 약 10배 느려지지만 인덱스는 높이가 1 늘어날까 말까입니다.</p>`;
  btn.disabled = false;
});
