// 미니 레디스 개념 더 파고들기 — 실험 연결
import { HASHES, makeKeys, distribution, measureLoad, rehashLatency, blockingCost, simulateActiveExpire, stampede, aofGrowth } from './labs.js';
import { initProgress, busy, stat, hbar, fmt, esc } from '../../shared/deepdive-ui.js';

const $ = (s, r = document) => r.querySelector(s);
initProgress('mini-redis-deepdive:v1');

// ============================================================ 1. 해시 함수
$('#hash-fn').innerHTML = Object.entries(HASHES).map(([k, h]) => `<option value="${k}">${esc(h.label)}</option>`).join('');
function runHash() {
  const keys = makeKeys($('#hash-keys').value, 2000);
  const d = distribution(HASHES[$('#hash-fn').value].fn, keys, 64);
  const max = Math.max(...d.counts, 1);
  $('#hash-hist').innerHTML = `<div class="hist">${d.counts.map((c) => `<i style="height:${(c / max) * 100}%" title="${c}개"></i>`).join('')}</div>`;
  $('#hash-out').innerHTML = stat([
    ['가장 긴 체인', `${d.max}개`, d.max > 80 ? 'bad' : 'good'],
    ['빈 버킷', `${d.empty} / 64`],
    ['조회 1번에 평균 비교', `${fmt(d.probes, 1)}번`, d.probes > 40 ? 'bad' : 'good'],
    ['이상적인 값', `${fmt(1 + 2000 / 64 / 2, 1)}번`],
  ]);
}
['#hash-fn', '#hash-keys'].forEach((s) => $(s).addEventListener('change', runHash));
runHash();

// ============================================================ 2. 부하율
$('#load-run').addEventListener('click', () => {
  const rows = [0.25, 0.5, 1, 2, 4, 8].map((a) => measureLoad(a, 4096));
  const max = Math.max(...rows.map((r) => r.probes));
  $('#load-out').innerHTML = `<div class="bars">${rows.map((r) => hbar(`부하율 ${r.alpha}`, r.probes, max, r.alpha > 1 ? 'miss' : 'hit', `비교 ${fmt(r.probes, 2)}번 · 버킷 ${fmt(r.buckets)}개`)).join('')}</div>` +
    `<p class="small">이론값(체이닝, 성공한 조회) 1 + α/2: ${rows.map((r) => fmt(r.theory, 2)).join(' · ')} — 측정값과 거의 같습니다.</p>`;
});

// ============================================================ 3. 리해시 방식
$('#rehash-run').addEventListener('click', (e) => busy(e.target, () => {
  const n = 200_000;
  const a = rehashLatency(n, 'incremental');
  const b = rehashLatency(n, 'stop-the-world');
  $('#rehash-out').innerHTML = `<table class="cost-table"><tr><th></th><th>연산 한 번에 옮긴 원소 (최대)</th><th>가장 느린 SET</th><th>전체</th></tr>
    <tr><td>점진적 (사용 중)</td><td class="good"><b>${fmt(a.maxMoved)}개</b></td><td>${fmt(a.maxMs, 2)}ms</td><td>${fmt(a.totalMs)}ms</td></tr>
    <tr><td>한 번에</td><td class="bad"><b>${fmt(b.maxMoved)}개</b></td><td>${fmt(b.maxMs, 2)}ms</td><td>${fmt(b.totalMs)}ms</td></tr></table>
    <p class="small">${fmt(n)}개를 넣는 동안 크기를 ${a.resizes}번 바꿨습니다. 한 번에 하면 <b>그 연산 하나가 ${fmt(b.maxMoved)}개를 옮기는 동안 다른 요청이 전부 멈춥니다.</b> (시간은 GC 등으로 흔들릴 수 있어 옮긴 개수를 함께 봅니다)</p>`;
}));

// ============================================================ 4. 긴 명령
$('#block-run').addEventListener('click', (e) => busy(e.target, () => {
  const r = blockingCost(100_000);
  $('#block-out').innerHTML = stat([
    ['KEYS * (10만 키)', `${fmt(r.keysMs, 1)}ms`, 'bad'],
    ['GET 한 번', `${fmt(r.getUs, 2)}µs`, 'good'],
    ['그동안 처리할 수 있었던 GET', `${fmt(r.couldServe)}개`],
  ]) + '<p class="small">한 스레드라서 KEYS * 가 도는 동안 다른 모든 클라이언트가 기다립니다. 실제 Redis 에서 운영 중 KEYS 를 금지하고 SCAN(조금씩 나눠 훑기)을 쓰는 이유입니다.</p>';
}));

// ============================================================ 5. 표본 크기
$('#sample-run').addEventListener('click', (e) => busy(e.target, () => {
  const series = [5, 20, 100].map((s) => ({ s, r: simulateActiveExpire({ n: 2000, expiredRatio: 0.5, sample: s, cycles: 15 }) }));
  $('#sample-out').innerHTML = `<div class="bars">${series.map(({ s, r }) => hbar(`표본 ${s}`, r.left.at(-1), r.expiredN, s === 20 ? 'hit' : 'miss', `15번 뒤 남은 만료 키 ${fmt(r.left.at(-1))} / ${fmt(r.expiredN)} · 한 번에 최대 ${fmt(Math.max(...r.work))}개 삭제`)).join('')}</div>` +
    '<p class="small">표본이 크면 빨리 치우지만 한 번의 청소가 길어지고(그동안 명령 처리가 멈춤), 작으면 짧지만 메모리에 만료 키가 오래 남습니다. 지연 삭제가 있으니 남아 있어도 <b>틀린 값이 나가지는 않습니다</b> — 메모리만 차지할 뿐.</p>';
}));

// ============================================================ 6. 스탬피드
$('#stamp-run').addEventListener('click', (e) => busy(e.target, async () => {
  const a = await stampede({ clients: 100, protect: false });
  const b = await stampede({ clients: 100, protect: true });
  $('#stamp-out').innerHTML = `<div class="bars">${hbar('보호 없음', a.dbQueries, 100, 'lost', `DB 조회 ${a.dbQueries}번 · ${fmt(a.ms)}ms`)}${hbar('SET NX 락', b.dbQueries, 100, 'hit', `DB 조회 ${b.dbQueries}번 · ${fmt(b.ms)}ms`)}</div>` +
    '<p class="small">인기 키가 만료되는 순간 동시에 온 100명이 모두 "캐시에 없네" → 모두 DB 로. 한 명만 락을 잡고 채우고 나머지는 잠깐 기다리면 DB 조회가 1번. 다른 방법: 만료 시간에 무작위 값 더하기, 만료 전에 미리 갱신.</p>';
}));

// ============================================================ 7. AOF 크기
$('#aof-run').addEventListener('click', () => {
  const r = aofGrowth(5000, 50);
  $('#aof-out').innerHTML = stat([
    ['쓰기 명령', fmt(r.ops)],
    ['AOF', `${fmt(r.lines)}줄 (${fmt(r.bytes / 1024, 1)}KB)`, 'bad'],
    ['재작성 후', `${fmt(r.compactLines)}줄 (${fmt(r.compactBytes / 1024, 1)}KB)`, 'good'],
    ['복원 시간', `${fmt(r.replayFull, 2)} → ${fmt(r.replayCompact, 2)}ms`],
  ]) + `<p class="small">키가 ${r.keys}개뿐이어도 명령마다 한 줄씩 쌓입니다. 재작성은 "지금 상태를 만드는 최소 명령"(키당 SET 한 줄)만 남깁니다.</p>`;
});
