// 미니 레디스 실습 페이지 — 실험은 모두 이 프로젝트의 MiniRedis 코드로 브라우저 안에서 실제로 실행된다
import { MiniRedis, formatReply } from './miniredis.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isServer = location.protocol.startsWith('http');

// ============================================================ 1. 명령 콘솔
const redis = new MiniRedis();
redis.start(100);
const log = $('#con-log');
const history = [];
let hIdx = 0;

function print(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function runLine(line) {
  if (!line.trim()) return;
  print('in', line);
  history.push(line);
  hIdx = history.length;
  try {
    print('out', formatReply(redis.exec(line)));
  } catch (e) {
    print('err', `(error) ${e.message}`);
  }
  paintKeys();
  paintTable();
}

print('sys', 'MiniRedis 에 연결되었습니다. 아래 버튼을 누르거나 명령을 입력하세요. (↑ ↓ 로 이전 명령)');
$('#con-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runLine($('#con-input').value);
  $('#con-input').value = '';
});
$('#con-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && hIdx > 0) { e.preventDefault(); $('#con-input').value = history[--hIdx]; }
  if (e.key === 'ArrowDown') { e.preventDefault(); hIdx = Math.min(history.length, hIdx + 1); $('#con-input').value = history[hIdx] ?? ''; }
});
$$('[data-cmd]').forEach((b) => b.addEventListener('click', () => b.dataset.cmd.split('|').forEach(runLine)));

function paintKeys() {
  const rows = redis.dump();
  const now = Date.now();
  $('#keys-body').innerHTML = rows.length
    ? rows.slice(0, 60).map((r) => {
        const ttl = r.expireAt === null ? '—' : r.expired ? '만료됨 (아직 메모리에)' : `${((r.expireAt - now) / 1000).toFixed(1)}초`;
        return `<tr class="${r.expired ? 'expired' : ''}"><td class="mono">${esc(r.key)}</td><td class="mono">${esc(r.value.length > 40 ? r.value.slice(0, 40) + '…' : r.value)}</td><td>${ttl}</td><td class="mono">${esc(r.tags.join(', '))}</td></tr>`;
      }).join('')
    : '<tr><td colspan="4" class="muted">비어 있음</td></tr>';
  const info = redis.command(['INFO']);
  $('#con-stats').innerHTML = [
    ['키', info.keys], ['TTL 있는 키', info.keysWithTtl], ['GET 적중', info.hits], ['GET 실패', info.misses],
    ['지연 삭제', info.expiredLazy], ['주기 삭제', info.expiredActive],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}
setInterval(paintKeys, 300);

// ============================================================ 2. 해시 테이블 시각화 (같은 저장소)
let highlight = null;
let seq = 0;
function paintTable() {
  const snap = redis.data.snapshot();
  const renderTable = (t, idx) => {
    if (!t) return '';
    const show = t.buckets.slice(0, 64);
    const cls = (i) => (snap.rehashIdx !== -1 && idx === 0 ? (i < snap.rehashIdx ? 'done' : i === snap.rehashIdx ? 'next' : '') : '');
    return `<div class="ht-table ${idx === 1 ? 'new' : ''}">
      <div class="ht-head">${idx === 0 ? (snap.rehashIdx !== -1 ? '옛 테이블 (옮기는 중)' : '테이블') : '새 테이블 (2배)'} · 버킷 ${t.size}개 · 원소 ${t.used}개${t.size > 64 ? ' · 앞 64개만 표시' : ''}</div>
      <div class="buckets">${show.map((keys, i) => `<div class="bucket ${cls(i)}"><span class="bi">#${i}</span>${keys.map((k) => `<span class="k ${k === highlight ? 'hl' : ''}" title="${esc(k)}">${esc(k)}</span>`).join('')}</div>`).join('')}</div>
    </div>`;
  };
  $('#ht-view').innerHTML = renderTable(snap.tables[0], 0) + renderTable(snap.tables[1], 1);
  const t = snap.tables[1] ?? snap.tables[0];
  $('#ht-stats').innerHTML = [
    ['원소 수', snap.size], ['버킷 수', t.size], ['부하율', snap.loadFactor.toFixed(2)],
    ['리해시', snap.rehashIdx === -1 ? '안 함' : `#${snap.rehashIdx} 까지`], ['충돌', snap.stats.collisions], ['크기 변경', snap.stats.resizes],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
}
const names = ['apple', 'banana', 'cherry', 'grape', 'lemon', 'mango', 'melon', 'peach', 'pear', 'plum', 'kiwi', 'lime'];
const addKey = () => {
  const k = `${names[seq % names.length]}:${Math.floor(seq / names.length)}`;
  seq++;
  redis.command(['SET', k, String(seq)]);
  return k;
};
$('#ht-add1').addEventListener('click', () => { highlight = addKey(); paintTable(); paintKeys(); });
$('#ht-add10').addEventListener('click', () => { for (let i = 0; i < 10; i++) highlight = addKey(); paintTable(); paintKeys(); });
$('#ht-del').addEventListener('click', () => {
  const keys = [...redis.data.keys()];
  for (let i = 0; i < Math.min(5, keys.length); i++) redis.command(['DEL', keys[Math.floor(Math.random() * keys.length)]]);
  paintTable();
  paintKeys();
});
$('#ht-step').addEventListener('click', () => { redis.data.has('\u0000step'); paintTable(); }); // 아무 조회나 하면 버킷 하나를 옮긴다
$('#ht-reset').addEventListener('click', () => { redis.command(['FLUSHALL']); seq = 0; highlight = null; paintTable(); paintKeys(); });
$('#ht-find').addEventListener('input', (e) => {
  const k = e.target.value;
  highlight = k;
  $('#ht-where').textContent = k ? (redis.data.has(k) ? `"${k}" → 해시 ${redis.data.hash(k)} → ${redis.data.isRehashing ? `옛 #${redis.data.indexOf(k, 0)} / 새 #${redis.data.indexOf(k, 1)}` : `버킷 #${redis.data.indexOf(k, 0)}`}` : `"${k}" 는 없음 (해시 ${redis.data.hash(k)} → 버킷 #${redis.data.indexOf(k, redis.data.isRehashing ? 1 : 0)} 을 봤지만 비어 있거나 다른 키)`) : '';
  paintTable();
});
paintTable();
paintKeys();

// ============================================================ 3. 만료 실험
const ttlRedis = new MiniRedis();
let ttlActive = true;
ttlRedis.start(100);
$('#ttl-active').addEventListener('change', (e) => {
  ttlActive = e.target.checked;
  if (ttlActive) ttlRedis.start(100);
  else ttlRedis.stop();
});
$('#ttl-make').addEventListener('click', () => {
  for (let i = 0; i < 50; i++) ttlRedis.command(['SET', `session:${Date.now()}:${i}`, 'x', 'PX', String(1500 + Math.floor(Math.random() * 1000))]);
  for (let i = 0; i < 10; i++) ttlRedis.command(['SET', `config:${i}`, 'forever']);
});
$('#ttl-read').addEventListener('click', () => {
  for (const k of [...ttlRedis.data.keys()]) ttlRedis.command(['GET', k]);
});
$('#ttl-reset').addEventListener('click', () => {
  ttlRedis.command(['FLUSHALL']);
  Object.assign(ttlRedis.stats, { expiredLazy: 0, expiredActive: 0, hits: 0, misses: 0 });
});
setInterval(() => {
  const mem = ttlRedis.data.size;
  const visible = ttlRedis.command(['KEYS', '*']).length;
  $('#ttl-stats').innerHTML = [
    ['메모리에 있는 키 (DBSIZE)', mem], ['보이는 키 (KEYS *)', visible], ['만료됐지만 남은 키', mem - visible],
    ['지연 삭제로 지움', ttlRedis.stats.expiredLazy], ['주기 삭제로 지움', ttlRedis.stats.expiredActive],
  ].map(([k, v], i) => `<div class="stat"><span>${k}</span><b class="${i === 2 && v > 0 ? 'warnc' : ''}">${v}</b></div>`).join('');
}, 200);

// ============================================================ 4. 캐시 실험 (cache-aside)
const cache = new MiniRedis();
const db = new Map([[1, { id: 1, name: '기계식 키보드', price: 89000 }], [2, { id: 2, name: '무선 마우스', price: 32000 }]]);
let dbQueries = 0;
const latency = () => Number($('#cache-lat').value);
$('#cache-lat').addEventListener('input', () => { $('#cache-lat-out').textContent = `${latency()}ms`; });

async function dbGet(id) {
  dbQueries++;
  await sleep(latency());
  return { ...db.get(id) };
}

async function getProduct(id, useCache) {
  const t0 = performance.now();
  if (!useCache) return { v: await dbGet(id), state: 'db', ms: performance.now() - t0 };
  const hit = cache.command(['GET', `product:${id}`]);
  await sleep(1); // 캐시 서버까지의 짧은 왕복
  if (hit !== null) return { v: JSON.parse(hit), state: 'hit', ms: performance.now() - t0 };
  const v = await dbGet(id);
  cache.command(['SET', `product:${id}`, JSON.stringify(v), 'EX', '60']);
  return { v, state: 'miss', ms: performance.now() - t0 };
}

function bars(results, max) {
  return results.map((r, i) => `<div class="bar-row"><span>요청 ${i + 1}</span><div class="bar ${r.state}" style="width:${Math.max(0.5, (r.ms / max) * 100)}%"></div><span>${r.ms.toFixed(0)}ms</span></div>`).join('');
}

const runs = {};
async function runCache(useCache) {
  $$('#cache button').forEach((b) => { b.disabled = true; });
  const before = dbQueries;
  const results = [];
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) results.push(await getProduct(1, useCache));
  const total = performance.now() - t0;
  runs[useCache ? 'on' : 'off'] = total;
  const max = Math.max(latency() + 20, ...results.map((r) => r.ms));
  $('#cache-bars').innerHTML = `<b class="small">${useCache ? '캐시 사용' : '캐시 없이'} — 10번 요청</b>` + bars(results, max);
  const hits = results.filter((r) => r.state === 'hit').length;
  $('#cache-sum').innerHTML =
    `총 <b>${total.toFixed(0)}ms</b> · DB 조회 <b>${dbQueries - before}번</b>${useCache ? ` · 적중 ${hits}/10` : ''}` +
    (runs.on && runs.off ? `<br>캐시 없이 ${runs.off.toFixed(0)}ms → 캐시 사용 ${runs.on.toFixed(0)}ms : <b class="ok">${(runs.off / runs.on).toFixed(1)}배 빠름</b>` : '');
  $$('#cache button').forEach((b) => { b.disabled = false; });
}
$('#cache-off').addEventListener('click', () => runCache(false));
$('#cache-on').addEventListener('click', () => runCache(true));

async function changePrice(invalidate) {
  const p = db.get(1);
  p.price += 1000;
  if (invalidate) cache.command(['DEL', 'product:1']);
  const r = await getProduct(1, true);
  const stale = r.v.price !== p.price;
  $('#cache-sum').innerHTML =
    `DB 가격: <b>${p.price.toLocaleString()}원</b> · 사용자가 받은 가격: <b class="${stale ? 'bad' : 'ok'}">${r.v.price.toLocaleString()}원</b> (${r.state === 'hit' ? '캐시에서' : 'DB 에서'})<br>` +
    (stale ? '✗ 오래된 값(stale)! 원본만 바꾸고 캐시를 안 지우면 TTL 이 끝날 때까지 옛 가격이 나갑니다.' : '✓ 원본을 바꾼 직후 캐시를 지워서(무효화) 다음 요청이 새 값을 다시 캐시했습니다.');
}
$('#cache-update').addEventListener('click', () => changePrice(true));
$('#cache-stale').addEventListener('click', () => changePrice(false));
$('#cache-clear').addEventListener('click', () => { cache.command(['FLUSHALL']); $('#cache-sum').textContent = '캐시를 비웠습니다.'; });

// 실제 서버 API 로 측정 (npm start 로 열었을 때만)
if (isServer) {
  $('#cache-real-box').hidden = false;
  $('#cache-real').addEventListener('click', async () => {
    const btn = $('#cache-real');
    btn.disabled = true;
    try {
      const go = async (q) => {
        const out = [];
        for (let i = 0; i < 8; i++) {
          const t0 = performance.now();
          const r = await fetch(`/api/demo/products/1${q}`);
          await r.json();
          const st = r.headers.get('x-cache');
          out.push({ ms: performance.now() - t0, state: st === 'HIT' ? 'hit' : st === 'MISS' ? 'miss' : 'db' });
        }
        return out;
      };
      const off = await go('?cache=0');
      await fetch('/api/redis/keys/product%3A1', { method: 'DELETE' });
      const on = await go('');
      const sum = (a) => a.reduce((s, r) => s + r.ms, 0);
      const max = Math.max(...off.map((r) => r.ms), ...on.map((r) => r.ms));
      $('#cache-real-out').innerHTML =
        `<b class="small">서버: 캐시 없이 (?cache=0)</b>${bars(off, max)}<b class="small">서버: 미니 레디스 캐시 사용</b>${bars(on, max)}` +
        `<p class="small">총 ${sum(off).toFixed(0)}ms → ${sum(on).toFixed(0)}ms (<b class="ok">${(sum(off) / sum(on)).toFixed(1)}배</b>). 서버의 가짜 DB 는 요청마다 120ms 를 기다립니다.</p>`;
    } catch (e) {
      $('#cache-real-out').innerHTML = `<p class="bad">서버에 연결하지 못했습니다: ${esc(e.message)} — npm start 를 다시 실행했는지 확인하세요.</p>`;
    } finally {
      btn.disabled = false;
    }
  });
}

// ============================================================ 5. 동시성 (경쟁 상태)
const raceRedis = new MiniRedis();
const net = () => sleep(Math.random() * 15); // 네트워크 왕복 시간 (요청마다 다름)
async function raceRun(mode) {
  $$('#race button').forEach((b) => { b.disabled = true; });
  raceRedis.command(['SET', 'likes', '0']);
  const N = Number($('#race-n').value) || 100;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: N }, async () => {
    if (mode === 'naive') {
      await net();
      const v = Number(raceRedis.command(['GET', 'likes'])); // ① 읽고
      await net();                                           //    (이 사이에 다른 클라이언트도 같은 값을 읽음)
      raceRedis.command(['SET', 'likes', String(v + 1)]);    // ② +1 해서 쓰기
    } else {
      await net();
      raceRedis.command(['INCR', 'likes']);                  // 서버 안에서 한 번에
      await net();
    }
  }));
  const got = Number(raceRedis.command(['GET', 'likes']));
  const lost = N - got;
  $('#race-out').innerHTML =
    `<div class="stats"><div class="stat"><span>좋아요 요청</span><b>${N}</b></div><div class="stat"><span>저장된 값</span><b class="${lost ? 'bad' : 'ok'}">${got}</b></div><div class="stat"><span>사라진 증가</span><b class="${lost ? 'bad' : 'ok'}">${lost}</b></div><div class="stat"><span>걸린 시간</span><b>${(performance.now() - t0).toFixed(0)}ms</b></div></div>` +
    (mode === 'naive'
      ? `<p class="small">GET 과 SET 사이에 다른 클라이언트가 끼어들어 같은 옛 값을 읽고 덮어썼습니다 (lost update). 명령 하나하나는 원자적이지만 <b>두 명령을 합친 것은 원자적이지 않습니다.</b></p>`
      : `<p class="small">INCR 은 "읽고 더하고 쓰기" 를 서버 안에서 한 번에 합니다. 미니 레디스는 명령을 한 스레드에서 하나씩 실행하니 중간에 끼어들 틈이 없습니다.</p>`);
  $$('#race button').forEach((b) => { b.disabled = false; });
}
$('#race-naive').addEventListener('click', () => raceRun('naive'));
$('#race-incr').addEventListener('click', () => raceRun('incr'));

// ============================================================ 6. 영속성 (AOF) + 서버 다운
let aofDisk = [];     // 디스크에 확정된 줄
let aofBuffer = [];   // 아직 메모리 버퍼에 있는 줄
let lostLines = [];
let aofTimer = null;
let aofRedis = null;
let alive = true;
const policy = () => $('#aof-policy').value;

function flushAof() {
  aofDisk.push(...aofBuffer);
  aofBuffer = [];
  paintAof();
}

function bootAof(fromDisk) {
  clearInterval(aofTimer);
  aofRedis = new MiniRedis({
    onWrite: (args) => {
      const line = JSON.stringify(args);
      if (policy() === 'always') aofDisk.push(line);
      else {
        aofBuffer.push(line);
        if (policy() === 'no' && aofBuffer.length >= 8) flushAof(); // 운영체제가 알아서 내려 쓸 때까지
      }
    },
  });
  const r = fromDisk ? aofRedis.loadAof(aofDisk.join('\n')) : null;
  aofTimer = setInterval(() => { if (alive && policy() === 'everysec' && aofBuffer.length) flushAof(); }, 1000);
  alive = true;
  return r;
}
bootAof(false);

function paintAof() {
  $('#aof-view').innerHTML =
    aofDisk.map((l) => `<div>${esc(l)}</div>`).join('') +
    aofBuffer.map((l) => `<div class="buf">${esc(l)}   ← 버퍼 (아직 디스크 아님)</div>`).join('') +
    lostLines.map((l) => `<div class="lost">${esc(l)}   ← 서버가 죽어서 잃음</div>`).join('') || '<span class="muted">(비어 있음)</span>';
  const keys = alive ? aofRedis.command(['KEYS', '*']) : [];
  $('#aof-state').innerHTML = alive
    ? `서버 <b class="ok">동작 중</b> · 메모리의 키 ${keys.length}개 · 디스크 ${aofDisk.length}줄 · 버퍼 ${aofBuffer.length}줄`
    : `서버 <b class="bad">다운</b> — 메모리의 데이터는 모두 사라졌습니다. "다시 켜기" 를 누르면 디스크의 AOF 로 복원합니다.`;
  $('#aof-crash').disabled = !alive;
  $('#aof-restart').disabled = alive;
  $('#aof-write').disabled = !alive;
  $('#aof-rewrite').disabled = !alive;
}
let aofSeq = 0;
$('#aof-write').addEventListener('click', () => {
  for (let i = 0; i < 3; i++) {
    aofSeq++;
    aofRedis.command(['SET', `order:${aofSeq}`, `주문${aofSeq}`]);
  }
  aofRedis.command(['INCR', 'orders:count']);
  paintAof();
});
$('#aof-crash').addEventListener('click', () => {
  lostLines = [...aofBuffer];
  aofBuffer = [];
  alive = false;
  aofRedis.stop();
  $('#aof-result').textContent = lostLines.length ? `버퍼에 있던 ${lostLines.length}줄을 잃었습니다 (fsync=${policy()}).` : '버퍼가 비어 있어서 잃은 것이 없습니다.';
  paintAof();
});
$('#aof-restart').addEventListener('click', () => {
  const r = bootAof(true);
  const count = aofRedis.command(['GET', 'orders:count']) ?? '0';
  $('#aof-result').innerHTML = `AOF ${r.applied}줄을 다시 실행해 복원 → 키 ${aofRedis.command(['KEYS', '*']).length}개, orders:count = <b>${count}</b>${lostLines.length ? ` <span class="bad">(잃은 ${lostLines.length}줄의 변경은 없음)</span>` : ' <span class="ok">(빠짐없이 복원)</span>'}`;
  lostLines = [];
  paintAof();
});
$('#aof-rewrite').addEventListener('click', () => {
  flushAof();
  const before = aofDisk.length;
  aofDisk = aofRedis.rewriteAof().trim().split('\n').filter(Boolean);
  $('#aof-result').textContent = `재작성: ${before}줄 → ${aofDisk.length}줄 (지금 상태를 만드는 데 필요한 줄만 남김)`;
  paintAof();
});
$('#aof-reset').addEventListener('click', () => {
  aofDisk = []; aofBuffer = []; lostLines = []; aofSeq = 0;
  bootAof(false);
  $('#aof-result').textContent = '';
  paintAof();
});
$('#aof-policy').addEventListener('change', paintAof);
paintAof();

// ============================================================ 7. 실제 서버 API
if (isServer) {
  $('#api-live').hidden = false;
  $('#api-file').hidden = true;
  $('#api-send').addEventListener('click', async () => {
    const method = $('#api-method').value;
    const path = $('#api-path').value;
    const body = $('#api-body').value.trim();
    const t0 = performance.now();
    try {
      const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: method === 'GET' || method === 'DELETE' ? undefined : body || undefined });
      const text = await r.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 그대로 */ }
      $('#api-out').textContent = `HTTP ${r.status}  (${(performance.now() - t0).toFixed(0)}ms)\n${pretty}`;
    } catch (e) {
      $('#api-out').textContent = `연결 실패: ${e.message}`;
    }
  });
  $$('[data-api]').forEach((b) => b.addEventListener('click', () => {
    const [m, p, body] = b.dataset.api.split('|');
    $('#api-method').value = m;
    $('#api-path').value = p;
    $('#api-body').value = body ?? '';
  }));
}
