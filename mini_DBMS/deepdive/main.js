// 미니 DBMS 개념 더 파고들기 — 실험 연결
import { heightFor, fillFactor, indexCost, selectivity, plans, deadlockDemo, poolThroughput } from './labs.js';
import { initProgress, busy, stat, hbar, fmt, esc } from '../../shared/deepdive-ui.js';

const $ = (s, r = document) => r.querySelector(s);
initProgress('mini-dbms-deepdive:v1');

// ============================================================ 차수와 높이
$('#height-run').addEventListener('click', (e) => busy(e.target, () => {
  const n = Number($('#height-n').value);
  const rows = [4, 16, 64, 256].map((o) => heightFor(o, n));
  const max = Math.max(rows[0].binary, ...rows.map((r) => r.height));
  $('#height-out').innerHTML = `<div class="bars">${hbar('이진 트리', rows[0].binary, max, 'miss', `높이 ${rows[0].binary} (이상적으로 균형일 때)`)}${rows.map((r) => hbar(`차수 ${r.order}`, r.height, max, 'hit', `높이 ${r.height} · 검색 때 노드 ${r.visits}개 방문`)).join('')}</div>` +
    `<p class="small">${fmt(n)}건. 노드 하나 = 디스크 한 번 읽기라고 하면, 차수 256 은 ${rows[3].visits}번, 이진 트리는 ${rows[0].binary}번 읽어야 합니다. 실제 DBMS 의 노드는 16KB 페이지라 차수가 수백~천입니다.</p>`;
}));

// ============================================================ 채움률
$('#fill-run').addEventListener('click', (e) => busy(e.target, () => {
  const a = fillFactor(16, 20000, 'sequential');
  const b = fillFactor(16, 20000, 'random');
  $('#fill-out').innerHTML = `<div class="bars">${hbar('순서대로', a.fill * 100, 100, 'miss', `리프 채움 ${fmt(a.fill * 100)}% · 리프 ${fmt(a.leaves)}개`)}${hbar('무작위', b.fill * 100, 100, 'hit', `리프 채움 ${fmt(b.fill * 100)}% · 리프 ${fmt(b.leaves)}개`)}</div>` +
    '<p class="small">자동 증가 id 는 항상 맨 오른쪽 리프에만 들어갑니다. 반으로 쪼개면 왼쪽 반은 다시는 안 채워져서 리프가 <b>반만 찬 채로</b> 남습니다. 실제 DBMS(InnoDB 등)는 맨 끝에 넣는 패턴을 알아채고 "새 키만 오른쪽으로" 쪼개서 거의 꽉 채웁니다. 이 프로젝트에서 개선할 수 있는 지점입니다.</p>';
}));

// ============================================================ 인덱스의 비용
$('#icost-run').addEventListener('click', (e) => busy(e.target, () => {
  const r = indexCost(50_000);
  const max = Math.max(r.withMs, r.withoutMs);
  $('#icost-out').innerHTML = `<div class="bars">${hbar('파일만', r.withoutMs, max, 'hit', `${fmt(r.withoutMs, 1)}ms`)}${hbar('파일 + B+ 트리', r.withMs, max, 'miss', `${fmt(r.withMs, 1)}ms (+${fmt(Math.max(0, r.extraMs), 1)}ms)`)}</div>` +
    stat([['B+ 트리 노드', `${fmt(r.nodes)}개`], ['분할', `${fmt(r.splits)}번`], ['높이', r.height]]) +
    `<p class="small">인덱스 하나가 쓰기를 ${fmt(Math.max(0, (r.withMs / r.withoutMs - 1) * 100))}% 정도 느리게 하고 노드 ${fmt(r.nodes)}개만큼 메모리를 더 씁니다. 인덱스가 다섯 개면 이 일을 다섯 번 합니다.</p>`;
}));

// ============================================================ 선택도
$('#sel-run').addEventListener('click', (e) => busy(e.target, () => {
  const rows = selectivity(20_000);
  const max = Math.max(...rows.map((r) => Math.max(r.indexMs, r.scanMs)));
  const cross = rows.find((r) => r.indexMs > r.scanMs);
  $('#sel-out').innerHTML = `<table class="cost-table"><tr><th>읽는 비율</th><th>인덱스 (임의 읽기)</th><th>전체 읽기 (순차)</th><th>나은 쪽</th></tr>${rows.map((r) => `<tr><td>${r.pct}% · ${fmt(r.rows)}행</td><td>${fmt(r.indexReads)}건 → ${fmt(r.indexMs, 1)}ms</td><td>${fmt(r.scanReads)}건 → ${fmt(r.scanMs, 1)}ms</td><td class="${r.indexMs <= r.scanMs ? 'good' : 'bad'}"><b>${r.indexMs <= r.scanMs ? '인덱스' : '전체 읽기'}</b></td></tr>`).join('')}</table>` +
    `<div class="bars">${rows.map((r) => hbar(`${r.pct}%`, r.indexMs, max, r.indexMs <= r.scanMs ? 'hit' : 'miss', `인덱스 ${fmt(r.indexMs, 1)}ms vs 전체 ${fmt(r.scanMs, 1)}ms`)).join('')}</div>` +
    `<p class="small">${cross ? `전체의 약 ${cross.pct}% 부터는 처음부터 쭉 읽는 게 낫습니다.` : ''} 이 비율은 디스크 종류와 행 크기에 따라 달라서, 실제 최적화기는 통계를 보고 정합니다.</p>`;
}));

// ============================================================ 실행 계획기
$('#plan-run').addEventListener('click', () => {
  const rows = plans();
  const label = { 'index-lookup': 'B+ 트리 조회', 'index-range': 'B+ 트리 범위', 'full-scan': '전체 읽기' };
  $('#plan-out').innerHTML = `<table class="cost-table"><tr><th>질의</th><th>계획</th><th>읽은 레코드</th><th>결과</th></tr>${rows.map((r) => `<tr><td class="mono small">${esc(r.sql.replace('SELECT * FROM users ', ''))}</td><td class="${r.plan === 'full-scan' ? 'bad' : 'good'}"><b>${label[r.plan]}</b></td><td>${fmt(r.scanned)} / 1,000</td><td>${r.rows}행</td></tr>`).join('')}</table>` +
    '<p class="small"><code>name = … AND id = 500</code> 처럼 조건 순서가 달라도 id 로 좁힙니다. <code>id != 500</code> 은 인덱스로 좁힐 수 없어 전체 읽기, <code>id = 3 AND id = 4</code> 는 읽기 전에 0건으로 끝납니다.</p>';
});

// ============================================================ 교착 상태
$('#dead-run').addEventListener('click', (e) => busy(e.target, async () => {
  const sorted = $('#dead-sorted').checked;
  const r = await deadlockDemo({ sorted });
  $('#dead-out').innerHTML = `<ul class="log">${r.log.map((l) => `<li><span class="mono">${String(l.t).padStart(4)}ms</span> ${l.who}: ${esc(l.what)}</li>`).join('')}</ul>` +
    `<p class="${r.deadlocked ? 'bad' : 'good'}">${r.deadlocked ? '✗ 교착 상태: 둘 다 상대가 쥔 락을 기다려서 영원히 못 끝납니다 (여기서는 시간 제한으로 포기).' : `✓ ${r.finished.join(', ')} 모두 완료 — 모두가 같은 순서(이름순)로 잡으면 원을 그리며 기다릴 수 없습니다.`}</p>`;
}));

// ============================================================ 스레드 수
function runThreads() {
  const io = Number($('#thr-io').value);
  $('#thr-io-out').textContent = `${io}ms`;
  const rows = [1, 2, 4, 8, 16, 32].map((w) => poolThroughput({ workers: w, cores: 4, cpuMs: 10, ioMs: io, jobs: 200 }));
  const max = Math.max(...rows.map((r) => r.perSec));
  $('#thr-out').innerHTML = `<div class="bars">${rows.map((r) => hbar(`워커 ${r.workers}`, r.perSec, max, r.workers > 4 && r.perSec <= rows[2].perSec * 1.05 ? 'miss' : 'hit', `초당 ${fmt(r.perSec)}건`)).join('')}</div>` +
    `<p class="small">CPU 코어 4개, 작업 하나 = 계산 10ms + 대기 ${io}ms. ${io === 0 ? '계산만 하는 작업은 코어 수(4)를 넘기면 더 빨라지지 않습니다 — 워커끼리 코어를 번갈아 쓸 뿐.' : '기다리는 시간이 길수록 그동안 코어가 놀아서, 워커를 코어보다 많이 두면 처리량이 늘어납니다.'}</p>`;
}
$('#thr-io').addEventListener('input', runThreads);
runThreads();
