/**
 * 네트워크 지연 주입 — 앱 서버 → 캐시(미니 레디스 · Redis) 구간에만 tc netem 으로 지연을 넣는다.
 *   node experiment/netem.js 1ms          왕복 +1ms (지터 ±0.2ms, 기본은 지연의 20%)
 *   node experiment/netem.js 1ms 0.2ms    지터를 직접 지정
 *   node experiment/netem.js off          지연 없애기
 *   node experiment/netem.js status       지금 설정과 캐시까지 PING 왕복 시간
 *
 *  어떻게: 앱 컨테이너의 eth0 에서 나가는 패킷 중 "목적지가 캐시 컨테이너" 인 것만 지연 칸(netem)으로 보낸다.
 *    - 나가는 쪽에만 걸면 요청 하나가 그 구간을 한 번 지나므로 왕복 시간이 정확히 그만큼 늘어난다
 *    - k6 → 앱 서버 구간은 건드리지 않는다 (목적지 필터) → 캐시 없음(none) 은 영향을 받지 않아야 한다 (대조군)
 *    - 지터가 있으면 netem 이 패킷 순서를 바꿀 수 있어 TCP 재전송이 생긴다 → 안쪽 큐를 pfifo 로 바꿔 순서를 지킨다
 *  미니 DBMS 는 앱 서버 안(워커 스레드)에서 돌기 때문에 DB 구간에는 네트워크가 없다.
 *    → 캐시에만 지연이 붙는 "캐시에 가장 불리한" 경우다. (실제 클라우드에서는 DB 도 원격이라 MISS 비용이 더 크다)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, 'docker-compose.yml');
const TARGETS = ['miniredis', 'redis'];

/** '1ms' · '0.5' · '200us' → ms 숫자 */
export function parseMs(s) {
  if (s == null || s === '' || s === 'off') return 0;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|us|µs|s)?$/i);
  if (!m) throw new Error(`지연 값을 읽을 수 없습니다: ${s} (예: 1ms, 0.5ms, 200us)`);
  const v = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  return unit === 's' ? v * 1000 : unit === 'ms' ? v : v / 1000;
}

/** 컨테이너 안에서 돌릴 셸 스크립트 (테스트에서 내용을 검사할 수 있게 따로 만든다) */
export function netemScript(delayMs, jitterMs = delayMs * 0.2) {
  const lines = ['tc qdisc del dev eth0 root 2>/dev/null || true'];
  if (delayMs > 0) {
    const us = (x) => `${Math.round(x * 1000)}us`;
    lines.push(
      'set -e',
      // 기본: 모든 패킷은 3번 칸(1:3, 지연 없음). 필터에 걸린 패킷만 1번 칸(1:1, 지연)으로
      'tc qdisc add dev eth0 root handle 1: prio bands 3 priomap 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2',
      `tc qdisc add dev eth0 parent 1:1 handle 10: netem delay ${us(delayMs)}${jitterMs > 0 ? ` ${us(jitterMs)} distribution normal` : ''}`,
      'tc qdisc add dev eth0 parent 10:1 pfifo limit 10000',
      ...TARGETS.map((h) => `ip=$(getent hosts ${h} | awk '{print $1}'); [ -n "$ip" ]; tc filter add dev eth0 parent 1: protocol ip prio 1 u32 match ip dst $ip/32 flowid 1:1`),
    );
  }
  return lines.join('\n');
}

function exec(script) {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'app', 'sh', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tc 실패: ${(r.stderr || r.stdout || '').trim()}\n  (docker-compose.yml 의 app 에 cap_add: [NET_ADMIN] 이 있고 이미지가 다시 빌드됐는지 확인하세요)`);
  return r.stdout;
}

/** 지연 설정 (0 이면 끔). 바로 다음 측정에 반영된다 */
export function setDelay(delayMs, jitterMs) { exec(netemScript(delayMs, jitterMs)); }
export function showDelay() { return exec('tc qdisc show dev eth0; tc filter show dev eth0 | grep -c "flowid 1:1" || true'); }

/** 캐시까지 PING 왕복 시간 (앱 서버 안에서 잰다) */
export async function measureRtt(backend = 'redis', n = 300) {
  const r = await fetch(`http://localhost:8080/admin/rtt?backend=${backend}&n=${n}`);
  if (!r.ok) throw new Error(`RTT 측정 실패: HTTP ${r.status}`);
  return r.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (a !== 'status') {
    const d = parseMs(a);
    setDelay(d, b == null ? undefined : parseMs(b));
    console.log(d ? `앱 → 캐시 지연 ${d}ms (지터 ±${b == null ? d * 0.2 : parseMs(b)}ms) 설정` : '지연 없앰');
  }
  console.log(showDelay().trim());
  for (const be of ['redis', 'miniresp', 'mini']) {
    try { const r = await measureRtt(be, 200); console.log(`PING ${be.padEnd(8)} 중앙값 ${r.medianMs.toFixed(3)}ms · p95 ${r.p95Ms.toFixed(3)}ms`); } catch (e) { console.log(`PING ${be}: ${e.message}`); }
  }
}
