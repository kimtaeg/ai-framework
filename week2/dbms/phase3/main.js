// 미니 DBMS Phase 3 · API 서버 — 실제 엔진 코드를 브라우저에서 그대로 실행 (저장소만 메모리)
import { planLabel } from '../engine.js';
import { esc, table } from '../view.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const isServer = location.protocol.startsWith('http');

// ============================================================ 1. 스레드 풀 + 락 시뮬레이션
const sim = { workers: 4, queue: [], lanes: [], lock: { readers: 0, writer: false }, nextId: 1, ids: [], log: [] };
const JOB_MS = 700;
let simRunning = 0;

function paintSim() {
  $('#sim-queue').innerHTML = `<span class="small muted">대기열 (${sim.queue.length})</span>` + sim.queue.map((j) => `<span class="job ${j.kind}">${j.label}</span>`).join('');
  $('#sim-lanes').innerHTML = sim.lanes.map((j, i) => `<div class="lane"><span class="lname">워커 ${i}</span><div class="slot">${j ? `<span class="job ${j.kind} ${j.dup ? 'dup' : ''}">${j.label}${j.note ? ' ' + j.note : ''}</span>` : '<span class="muted small">쉬는 중</span>'}</div></div>`).join('');
  const L = sim.lock;
  $('#sim-lock').innerHTML = `<span class="lockbox ${L.writer ? 'w' : L.readers ? 'r' : ''}">users 락: ${L.writer ? '쓰기 중 (혼자)' : L.readers ? `읽기 ${L.readers}개 (같이)` : '비어 있음'}</span>`;
  const dups = sim.ids.filter((x, i) => sim.ids.indexOf(x) !== i);
  $('#sim-ids').innerHTML = sim.ids.length ? `받은 id: ${sim.ids.map((x) => `<b class="${dups.includes(x) ? 'bad' : ''}">${x}</b>`).join(', ')}${dups.length ? ` <span class="bad">← 중복 id ${[...new Set(dups)].join(', ')}!</span>` : ''}` : '';
}

function canRun(job) {
  if (!$('#sim-lockon').checked) return true;
  return job.kind === 'write' ? !sim.lock.writer && sim.lock.readers === 0 : !sim.lock.writer;
}

function pump() {
  for (;;) {
    const free = sim.lanes.findIndex((x) => !x);
    if (free === -1 || !sim.queue.length) break;
    const job = sim.queue[0];
    // 공정성: 맨 앞 작업이 락을 못 잡으면 뒤의 작업도 기다린다 (쓰기 기아 방지)
    if (!canRun(job)) break;
    sim.queue.shift();
    if ($('#sim-lockon').checked) {
      if (job.kind === 'write') sim.lock.writer = true;
      else sim.lock.readers++;
    }
    sim.lanes[free] = job;
    if (job.kind === 'write') job.readId = sim.nextId; // ① 다음 id 를 읽고 …
    simRunning++;
    setTimeout(() => finish(free, job), JOB_MS * (0.7 + Math.random() * 0.6));
  }
  paintSim();
}

function finish(lane, job) {
  if (job.kind === 'write') {
    sim.nextId = job.readId + 1; // ② … 일을 마친 뒤 +1 해서 저장 (락이 없으면 다른 워커도 같은 값을 읽었다)
    sim.ids.push(job.readId);
    job.note = `→ id ${job.readId}`;
    if (sim.ids.filter((x) => x === job.readId).length > 1) job.dup = true;
  }
  if ($('#sim-lockon').checked) {
    if (job.kind === 'write') sim.lock.writer = false;
    else sim.lock.readers = Math.max(0, sim.lock.readers - 1);
  }
  paintSim();
  setTimeout(() => {
    sim.lanes[lane] = null;
    simRunning--;
    pump();
  }, 250);
}

let jobSeq = 0;
function enqueue(kind, n) {
  for (let i = 0; i < n; i++) sim.queue.push({ kind, label: `${kind === 'write' ? 'INSERT' : 'SELECT'} #${++jobSeq}` });
  pump();
}
function resetSim() {
  sim.lanes = Array(Number($('#sim-workers').value)).fill(null);
  sim.queue = [];
  sim.lock = { readers: 0, writer: false };
  sim.nextId = 1;
  sim.ids = [];
  jobSeq = 0;
  paintSim();
}
$('#sim-reads').addEventListener('click', () => enqueue('read', 8));
$('#sim-writes').addEventListener('click', () => enqueue('write', 4));
$('#sim-mix').addEventListener('click', () => { enqueue('read', 3); enqueue('write', 2); enqueue('read', 3); });
$('#sim-reset').addEventListener('click', () => { if (!simRunning) resetSim(); });
$('#sim-workers').addEventListener('change', () => { if (!simRunning) resetSim(); });
$('#sim-lockon').addEventListener('change', () => { if (!simRunning) resetSim(); });
resetSim();

// ============================================================ 2. 실제 서버
if (isServer) {
  $('#srv-live').hidden = false;
  $('#srv-file').hidden = true;
  const post = (sql, delayMs = 0) => fetch('/api/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, delayMs }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  $('#srv-send').addEventListener('click', async () => {
    const t0 = performance.now();
    try {
      const r = await post($('#srv-sql').value);
      if (r.status !== 200) {
        $('#srv-out').innerHTML = `<p class="bad">HTTP ${r.status} · ${esc(r.body.message)}</p>`;
        return;
      }
      $('#srv-out').innerHTML = `<p class="small">워커 <b>${r.body.workerId}</b> 가 처리 · 락 대기 ${r.body.lockMs.toFixed(1)}ms · 풀 대기 ${r.body.waitedMs.toFixed(1)}ms · 실행 ${r.body.execMs.toFixed(1)}ms · 왕복 ${(performance.now() - t0).toFixed(0)}ms</p>` +
        r.body.results.map((x) => (x.type === 'insert' ? `<div class="result-block">INSERT ${x.count}건 → id ${x.ids.join(', ')}</div>` : `<div class="result-block"><div class="meta"><span class="plan ${x.plan.type}">${planLabel(x.plan)}</span> 읽은 레코드 ${x.plan.scanned}/${x.plan.total}${x.plan.built ? ` · 이번에 인덱스를 만드느라 ${x.plan.built}줄을 먼저 읽음` : ''}</div>${table(x.columns, x.rows.slice(0, 50))}${x.rows.length > 50 ? `<p class="small muted">… ${x.rows.length}행 중 50행만 표시</p>` : ''}</div>`)).join('');
    } catch (e) {
      $('#srv-out').innerHTML = `<p class="bad">서버에 연결하지 못했습니다: ${esc(e.message)} — npm start 를 다시 실행했는지 확인하세요.</p>`;
    }
  });
  $('#srv-burst').addEventListener('click', async () => {
    const btn = $('#srv-burst');
    btn.disabled = true;
    try {
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post(`SELECT id FROM users WHERE id = ${i + 1}`, 400)));
      const ms = performance.now() - t0;
      const by = {};
      rs.forEach((r) => { by[r.body.workerId] = (by[r.body.workerId] ?? 0) + 1; });
      $('#srv-out').innerHTML = `<p>400ms 걸리는 조회 8개를 동시에 → <b>${ms.toFixed(0)}ms</b> 에 끝남 (순서대로면 3,200ms)</p><p class="small">워커별 처리: ${Object.entries(by).map(([w, n]) => `워커 ${w}: ${n}개`).join(' · ')}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
  $('#srv-inserts').addEventListener('click', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`INSERT INTO users (name, age, email) VALUES ('동시${i}', 20, 'c${i}@ex.com')`)));
    const ids = rs.flatMap((r) => r.body.results?.[0]?.ids ?? []);
    $('#srv-out').innerHTML = `<p>INSERT 20개를 동시에 → 받은 id: ${ids.sort((a, b) => a - b).join(', ')}</p><p class="small ${new Set(ids).size === ids.length ? 'ok' : 'bad'}">${new Set(ids).size === ids.length ? '✓ 중복 없음 — 쓰기 락이 한 번에 하나씩만 쓰게 했습니다.' : '✗ 중복 발생'}</p>`;
  });
  $('#srv-status').addEventListener('click', async () => {
    const st = await (await fetch('/api/sql/status')).json();
    const tb = await (await fetch('/api/sql/tables')).json();
    $('#srv-out').innerHTML = `<pre class="aof" style="height:auto">${esc(JSON.stringify({ tables: tb.tables, ...st }, null, 2))}</pre>`;
  });
}
