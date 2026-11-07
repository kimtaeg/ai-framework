// 레디스 이론 페이지 — 공통 동작(검색·목차·필터) + 직접 해보는 예제 2개 (실제 HashTable · MiniRedis)
import { initTheoryPage } from '../../shared/theory-page.js';
import { HashTable } from '../hashtable.js';
import { MiniRedis } from '../miniredis.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
initTheoryPage();

// ============================================================ 예제 1: 버킷 8개 해시 테이블
const make8 = () => {
  const t = new HashTable({ initialSize: 8 });
  t.resizable = false; // 예제에서는 8칸 고정
  return t;
};
let table = make8();
let last = null;
function paintBuckets() {
  const snap = table.snapshot().tables[0];
  $('#hd-buckets').innerHTML = snap.buckets.map((keys, i) => `<div class="bucket"><span class="bi">#${i}</span>${keys.map((k) => `<span class="k ${k === last ? 'hl' : ''}">${esc(k)}</span>`).join('')}</div>`).join('');
}
function add(key) {
  if (!key) return;
  const h = table.hash(key);
  const i = table.indexOf(key);
  const before = table.snapshot().tables[0].buckets[i].length;
  table.set(key, true);
  last = key;
  $('#hd-msg').innerHTML = `<code>${esc(key)}</code> → FNV-1a <b>${h}</b> → ${h} &amp; 7 = 버킷 <b>#${i}</b>${before ? ` · 이미 ${before}개가 있어서 <b>체인</b>으로 이어짐 (충돌)` : ''}`;
  paintBuckets();
}
$('#hd-add').addEventListener('click', () => add($('#hd-key').value.trim()));
$('#hd-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') add($('#hd-key').value.trim()); });
$('#hd-many').addEventListener('click', () => {
  for (let i = 0; i < 10; i++) table.set(`user:${i}`, true);
  last = null;
  $('#hd-msg').textContent = '키 10개 → 버킷 8개. 어떤 버킷에는 둘 이상이 들어가 체인이 생깁니다(피할 수 없음).';
  paintBuckets();
});
$('#hd-clear').addEventListener('click', () => {
  table = make8();
  last = null;
  $('#hd-msg').textContent = '비웠습니다.';
  paintBuckets();
});
paintBuckets();

// ============================================================ 예제 2: 만료
const redis = new MiniRedis();
$('#td-active').addEventListener('change', (e) => (e.target.checked ? redis.start(100) : redis.stop()));
$('#td-set').addEventListener('click', () => {
  redis.exec('SET otp 1234 PX 2000');
  $('#td-msg').textContent = 'SET otp 1234 PX 2000 → 2초 뒤 만료. 기다렸다가 GET 을 눌러 보세요.';
});
$('#td-get').addEventListener('click', () => {
  const before = redis.data.size;
  const v = redis.exec('GET otp');
  $('#td-msg').innerHTML = v === null
    ? `GET otp → <b>(nil)</b>${before > redis.data.size ? ' · 이 순간 만료를 확인해서 <b>지연 삭제</b>했습니다' : ''}`
    : `GET otp → <b>"${v}"</b> (아직 살아 있음)`;
});
setInterval(() => {
  const ttl = redis.exec('PTTL otp');
  $('#td-stats').innerHTML = `<span>메모리의 키 (DBSIZE) <b>${redis.data.size}</b></span><span>보이는 키 (KEYS *) <b>${redis.exec('KEYS *').length}</b></span><span>남은 시간 <b>${ttl === -2 ? '—' : `${(Math.max(0, ttl) / 1000).toFixed(1)}초`}</b></span><span>지연 / 주기 삭제 <b>${redis.stats.expiredLazy} / ${redis.stats.expiredActive}</b></span>`;
}, 200);
