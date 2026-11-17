// 미니 레디스 예제 페이지 — 실제 MiniRedis 코드로 서비스 기능 4가지
import { MiniRedis } from '../miniredis.js';
import { flags, EXPERIMENTS, SessionStore, RateLimiter, LockService, lockRace, likeBurst } from './apps.js';
import { initLab, stat } from '../../shared/examples-lab.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ============================================================ 1. 로그인 세션
const sRedis = new MiniRedis();
sRedis.start(100);
const sessions = new SessionStore(sRedis, { ttl: 8 });
let devices = [];
const USER = { id: 7, name: '김정글' };
function paintSessions(last) {
  $('#ses-list').innerHTML = devices.length
    ? devices.map((d, i) => {
        const ttl = sessions.ttlOf(d.token);
        const alive = ttl !== -2;
        return `<li class="ses-row"><span class="ses-dev">${esc(d.device)}</span><span class="mono muted small">${esc(d.token.slice(0, 10))}…</span><span class="${alive ? (ttl === -1 ? 'msg bad' : 'msg ok') : 'muted'}">${alive ? (ttl === -1 ? '로그인 · 만료 없음!' : `로그인 · ${ttl}초 남음`) : '로그아웃됨'}</span><span>${alive ? `<button type="button" class="small" data-touch="${i}">페이지 이동</button> <button type="button" class="small ghost" data-out="${i}">로그아웃</button>` : ''}</span></li>`;
      }).join('')
    : '<li class="empty">아직 로그인한 기기가 없습니다. 위 버튼으로 로그인해 보세요.</li>';
  $$('[data-touch]').forEach((b) => b.addEventListener('click', () => {
    const u = sessions.touch(devices[b.dataset.touch].token);
    paintSessions(u ? `${u.name} 님 확인 → EXPIRE 로 8초를 다시 채움 (슬라이딩)` : '세션이 없습니다 → 로그인 화면으로');
  }));
  $$('[data-out]').forEach((b) => b.addEventListener('click', () => { sessions.logout(devices[b.dataset.out].token); paintSessions('DEL session:… → 그 기기만 로그아웃'); }));
  if (last !== undefined) {
    stat('session', `레디스의 세션 키 <b>${sRedis.command(['DBSIZE'])}</b> · 살아 있는 세션 <b>${sessions.count()}</b>${flags.sessionNoTtl ? ' · <span class="err">TTL 없음</span>' : ''}<span class="last">${esc(last)}</span>`);
  }
}
$('#ses-login').addEventListener('click', () => {
  const device = ['노트북 크롬', '휴대폰 앱', '태블릿', '회사 PC'][devices.length % 4];
  devices.push({ token: sessions.login(USER, device), device });
  paintSessions(`${device} 로그인 → SET session:… ${flags.sessionNoTtl ? '(TTL 없음!)' : 'EX 8'} + TAG user:7`);
});
$('#ses-all').addEventListener('click', () => {
  const n = sessions.logoutAll(USER.id);
  paintSessions(`비밀번호 변경 → INVALIDATE user:7 → 세션 ${n}개 한꺼번에 삭제`);
});
setInterval(() => paintSessions(), 1000);
paintSessions('');

// ============================================================ 2. 요청 횟수 제한
const rRedis = new MiniRedis();
rRedis.start(100);
const limiter = new RateLimiter(rRedis, { limit: 5, windowSec: 10 });
let hits = [];
function paintRate(last) {
  $('#rate-bars').innerHTML = hits.length ? hits.slice(-30).map((h) => `<span class="req ${h.allowed ? 'ok' : 'no'}" title="${h.count}번째">${h.allowed ? '200' : '429'}</span>`).join('') : '<span class="muted small">아직 요청이 없습니다.</span>';
  const ttl = rRedis.command(['TTL', 'rate:1.2.3.4']);
  $('#rate-window').innerHTML = `이번 창 요청 <b>${rRedis.command(['GET', 'rate:1.2.3.4']) ?? 0}</b> / 한도 5 · 창이 끝나기까지 <b class="${ttl === -1 ? 'err' : ''}">${ttl === -2 ? '—' : ttl === -1 ? '안 끝남!' : `${ttl}초`}</b>`;
  if (last) stat('rate', `통과 <b>${hits.filter((h) => h.allowed).length}</b> · 차단 <b>${hits.filter((h) => !h.allowed).length}</b><span class="last">${last.allowed ? `200 OK (${last.count}번째)` : `<span class="err">429 Too Many Requests</span> — ${last.ttl === -1 ? '창이 영원히 안 끝남' : `${last.ttl}초 뒤에 다시`}`}</span>`);
}
$('#rate-one').addEventListener('click', () => { const h = limiter.hit('1.2.3.4'); hits.push(h); paintRate(h); });
$('#rate-burst').addEventListener('click', () => { let h; for (let i = 0; i < 12; i++) hits.push((h = limiter.hit('1.2.3.4'))); paintRate(h); });
$('#rate-reset').addEventListener('click', () => { rRedis.command(['FLUSHALL']); hits = []; paintRate(); stat('rate', '초기화했습니다.'); });
setInterval(() => paintRate(), 1000);
paintRate();

// ============================================================ 3. 분산 락
const lRedis = new MiniRedis();
const locks = new LockService(lRedis);
const LOCK_SCENARIOS = {
  normal: { workMs: [250, 250], ttlMs: 600, label: '정상: 작업 250ms < TTL 600ms' },
  crash: { workMs: [250, 250], ttlMs: 600, crash: 0, label: '워커 0 이 락을 쥔 채 죽음' },
  slow: { workMs: [900, 300, 300], ttlMs: 400, label: '작업 900ms 가 TTL 400ms 보다 김' },
};
const LOCK_LABEL = { acquire: '🔒 락 잡음 → 작업 시작', release: '🔓 작업 끝, 내 락 해제', 'release-failed': '✋ 해제하려 했지만 이미 남의 락이라 안 지움 (안전)', 'release-other': '<b class="err">🔥 남의 락을 지움! (그 워커는 아직 작업 중)</b>', crash: '💥 락을 쥔 채 죽음', 'give-up': '⌛ 1.5초 기다렸지만 못 잡고 포기' };
$('#lock-run').addEventListener('click', async () => {
  const sc = LOCK_SCENARIOS[$('#lock-scenario').value];
  $('#lock-run').disabled = true;
  lRedis.command(['FLUSHALL']);
  $('#lock-log').innerHTML = '';
  const r = await lockRace(locks, { ...sc, onEvent: (e) => $('#lock-log').insertAdjacentHTML('beforeend', `<li><span class="mono muted">${String(e.t).padStart(4)}ms</span> 워커 ${e.worker}: ${LOCK_LABEL[e.event]}</li>`) });
  const gaveUp = r.events.some((e) => e.event === 'give-up');
  const stolen = r.events.filter((e) => e.event === 'release-other').length;
  stat('lock', `동시에 작업한 워커 최대 <b class="${r.maxInside > 1 ? 'err' : ''}">${r.maxInside}명</b>${gaveUp ? ' · <span class="err">교착: 락이 안 풀림</span>' : ''}${stolen ? ` · <span class="err">남의 락을 ${stolen}번 지움</span>` : ''}<span class="last">${esc(sc.label)}</span>`);
  $('#lock-run').disabled = false;
});

// ============================================================ 4. 좋아요 카운터
const kRedis = new MiniRedis();
async function like(n) {
  $$('#ex-likes button').forEach((b) => { b.disabled = true; });
  const r = await likeBurst(kRedis, n);
  $('#likes-n').textContent = r.total.toLocaleString();
  stat('likes', `누름 <b>${r.pressed}</b> · 늘어난 수 <b>${r.added}</b> · 사라진 좋아요 <b class="${r.lost ? 'err' : ''}">${r.lost}</b><span class="last">${flags.likesNaive ? 'GET → +1 → SET' : 'INCR'}</span>`);
  $$('#ex-likes button').forEach((b) => { b.disabled = false; });
}
$('#likes-one').addEventListener('click', () => like(1));
$('#likes-burst').addEventListener('click', () => like(100));
$('#likes-reset').addEventListener('click', () => { kRedis.command(['FLUSHALL']); $('#likes-n').textContent = '0'; stat('likes', '초기화했습니다.'); });

// ============================================================ 실험실
initLab({ experiments: EXPERIMENTS, flags });
