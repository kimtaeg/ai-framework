/**
 * 미니 레디스 예제 — 실제 서비스에서 매일 쓰는 기능 4가지
 *  1. 로그인 세션       SET session:… EX + 접속할 때마다 EXPIRE(슬라이딩), 태그로 "모든 기기 로그아웃"
 *  2. 요청 횟수 제한    INCR + 첫 요청에 EXPIRE (고정 윈도)
 *  3. 분산 락           SET lock NX PX + 내 토큰일 때만 해제
 *  4. 좋아요 카운터     INCR (동시에 눌러도 정확)
 *
 *  flags 를 true 로 바꾸면 "일부러 망가뜨린" 버전 (예제 페이지의 🧪 버튼). EXPERIMENTS 에 설명이 있다.
 */

export const flags = {
  sessionNoTtl: false,      // 세션을 TTL 없이 저장 → 영원히 쌓임
  limiterNoExpire: false,   // 카운터에 EXPIRE 를 안 붙임 → 한 번 막히면 영원히 막힘
  lockNoTtl: false,         // 락에 TTL 없음 → 잡은 워커가 죽으면 아무도 못 잡음
  lockUnsafeRelease: false, // 남의 락도 지움 → 늦게 끝난 워커가 다른 워커의 락을 지움
  likesNaive: false,        // GET → +1 → SET 으로 나눠서 → 동시에 누르면 증가분을 잃음
};

export function resetFlags() {
  for (const k of Object.keys(flags)) flags[k] = false;
}

let tokenSeq = 0;
const token = () => `t${Date.now().toString(36)}${(++tokenSeq).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ 1. 로그인 세션
export class SessionStore {
  /** @param {import('../miniredis.js').MiniRedis} redis */
  constructor(redis, { ttl = 30 } = {}) {
    this.redis = redis;
    this.ttl = ttl;
  }

  login(user, device = 'web') {
    const t = token();
    const key = `session:${t}`;
    const value = JSON.stringify({ ...user, device, at: this.redis.now() });
    if (flags.sessionNoTtl) this.redis.command(['SET', key, value]);
    else this.redis.command(['SET', key, value, 'EX', String(this.ttl)]);
    this.redis.command(['TAG', key, `user:${user.id}`]); // 이 사용자의 모든 세션을 한꺼번에 지우기 위해
    return t;
  }

  /** 요청이 올 때마다: 세션 확인 + 만료 시간 연장(슬라이딩). 없거나 만료면 null */
  touch(t) {
    const key = `session:${t}`;
    const v = this.redis.command(['GET', key]);
    if (v === null) return null;
    if (!flags.sessionNoTtl) this.redis.command(['EXPIRE', key, String(this.ttl)]);
    return JSON.parse(v);
  }

  ttlOf(t) {
    return this.redis.command(['TTL', `session:${t}`]);
  }

  logout(t) {
    return this.redis.command(['DEL', `session:${t}`]) === 1;
  }

  /** 비밀번호를 바꿨을 때: 이 사용자의 모든 기기 로그아웃 */
  logoutAll(userId) {
    return this.redis.command(['INVALIDATE', `user:${userId}`]);
  }

  count() {
    return this.redis.command(['KEYS', 'session:*']).length;
  }
}

// ================================================================ 2. 요청 횟수 제한
export class RateLimiter {
  constructor(redis, { limit = 5, windowSec = 10 } = {}) {
    this.redis = redis;
    this.limit = limit;
    this.windowSec = windowSec;
  }

  /** @returns {{ allowed: boolean, count: number, ttl: number }} */
  hit(ip) {
    const key = `rate:${ip}`;
    const count = this.redis.command(['INCR', key]); // 원자적으로 +1 (동시 요청에도 정확)
    if (count === 1 && !flags.limiterNoExpire) this.redis.command(['EXPIRE', key, String(this.windowSec)]);
    return { allowed: count <= this.limit, count, ttl: this.redis.command(['TTL', key]) };
  }
}

// ================================================================ 3. 분산 락
export class LockService {
  constructor(redis) {
    this.redis = redis;
  }

  /** 락 잡기: 없을 때만(NX) 내 토큰으로 저장. ttlMs 가 지나면 저절로 풀림 */
  acquire(name, owner, ttlMs = 2000) {
    const args = ['SET', `lock:${name}`, owner, 'NX'];
    if (!flags.lockNoTtl) args.push('PX', String(ttlMs));
    return this.redis.command(args) === 'OK';
  }

  /** 락 풀기: 내가 잡은 락일 때만 지운다 (늦게 끝난 워커가 남의 락을 지우지 않게) */
  release(name, owner) {
    const key = `lock:${name}`;
    if (flags.lockUnsafeRelease) return this.redis.command(['DEL', key]) === 1;
    // 미니 레디스는 한 스레드에서 명령을 실행하고 이 두 줄 사이에 await 가 없으므로 끼어들 틈이 없다.
    // (실제 Redis 에서는 네트워크를 두 번 오가므로 Lua 스크립트로 한 번에 해야 안전)
    if (this.redis.command(['GET', key]) !== owner) return false;
    return this.redis.command(['DEL', key]) === 1;
  }

  holder(name) {
    return this.redis.command(['GET', `lock:${name}`]);
  }
}

/**
 * 워커 여러 개가 같은 작업을 동시에 하려는 상황
 * @param {{ workMs: number[], crash?: number|null, ttlMs?: number }} opts  워커별 작업 시간, crash = 죽는 워커 번호
 */
export async function lockRace(lock, { workMs = [300, 300], crash = null, ttlMs = 400, retryMs = 40, giveUpMs = 1500, onEvent = () => {} } = {}) {
  const t0 = performance.now();
  const events = [];
  let inside = 0;
  let maxInside = 0;
  const note = (worker, event) => {
    const e = { worker, t: Math.round(performance.now() - t0), event };
    events.push(e);
    onEvent(e);
  };
  await Promise.all(workMs.map(async (ms, w) => {
    const me = `worker-${w}`;
    await sleep(w * 30);
    const start = performance.now();
    while (!lock.acquire('job', me, ttlMs)) {
      if (performance.now() - start > giveUpMs) return note(w, 'give-up');
      await sleep(retryMs);
    }
    note(w, 'acquire');
    inside++;
    maxInside = Math.max(maxInside, inside);
    if (crash === w) {
      inside--;
      return note(w, 'crash'); // 락을 풀지 못하고 죽음
    }
    await sleep(ms);
    inside--;
    const holder = lock.holder('job'); // 지금 락 주인 (TTL 이 지나 다른 워커가 잡았을 수도)
    const released = lock.release('job', me);
    note(w, !released ? 'release-failed' : holder === me ? 'release' : 'release-other');
  }));
  return { events, maxInside };
}

// ================================================================ 4. 좋아요 카운터
/** 사용자 n 명이 동시에 좋아요를 누른다 (요청마다 네트워크 시간이 다름) */
export async function likeBurst(redis, n = 100, { key = 'likes:post:1', maxDelay = 15 } = {}) {
  const net = () => sleep(Math.random() * maxDelay);
  const before = Number(redis.command(['GET', key]) ?? 0);
  await Promise.all(Array.from({ length: n }, async () => {
    await net();
    if (flags.likesNaive) {
      const v = Number(redis.command(['GET', key]) ?? 0); // ① 읽고
      await net();                                        //    (이 사이에 다른 사람도 같은 값을 읽음)
      redis.command(['SET', key, String(v + 1)]);         // ② +1 해서 쓰기
    } else {
      redis.command(['INCR', key]);                       // 서버 안에서 한 번에
    }
  }));
  const after = Number(redis.command(['GET', key]));
  return { pressed: n, added: after - before, lost: n - (after - before), total: after };
}

// ================================================================ 망가뜨리기 실험 설명
export const EXPERIMENTS = [
  {
    id: 'sessionNoTtl', app: 'session', title: '세션에 TTL 안 붙이기', concept: 'TTL · 만료', theory: '../theory/index.html#ttl',
    before: "SET session:토큰 정보 EX 8\nEXPIRE session:토큰 8   // 접속할 때마다", after: 'SET session:토큰 정보\n// TTL 없음, 연장도 없음',
    try: '다른 기기에서 로그인을 몇 번 하고 한참 기다려 보세요.',
    watch: '남은 시간이 "만료 없음" 으로 나오고, 로그아웃을 안 누르면 세션 수가 줄지 않습니다.',
    why: '레디스는 TTL 이 없는 키를 스스로 지우지 않습니다. 세션이 메모리에 계속 쌓이고, 도난당한 토큰도 영원히 유효해집니다. "언젠가는 지워야 하는 데이터" 에는 반드시 TTL 을 답니다.',
  },
  {
    id: 'limiterNoExpire', app: 'rate', title: 'EXPIRE 빼먹기', concept: 'INCR · EXPIRE', theory: '../theory/index.html#ttl',
    before: 'n = INCR rate:IP\nif (n === 1) EXPIRE rate:IP 10', after: 'n = INCR rate:IP\n// EXPIRE 없음',
    try: '"연타 12번" 을 누른 뒤 10초 넘게 기다리고 다시 요청해 보세요.',
    watch: '창이 끝나기까지가 "안 끝남!" 으로 나오고, 시간이 지나도 계속 429 입니다.',
    why: '카운터 키가 영원히 남아서 한 번 한도를 넘은 IP 는 영원히 막힙니다. 실제로는 INCR 과 EXPIRE 사이에 서버가 죽어도 같은 일이 생기므로 두 명령을 파이프라인·Lua 로 묶거나 SET NX EX 로 처음 값을 만듭니다.',
  },
  {
    id: 'lockNoTtl', app: 'lock', title: '락에 TTL 안 붙이기', concept: '분산 락 · 교착', theory: '../theory/index.html#concurrency',
    before: 'SET lock:job 내토큰 NX PX 600', after: 'SET lock:job 내토큰 NX\n// 저절로 풀리지 않음',
    try: '상황을 "워커 0 이 락을 쥔 채 죽음" 으로 바꿔서 실행해 보세요.',
    watch: '워커 1 이 1.5초 동안 기다리다 포기합니다. 락이 영원히 안 풀립니다.',
    why: '락을 잡은 서버가 해제 전에 죽으면 아무도 그 락을 지우지 않습니다. TTL 은 "쥔 채로 죽는" 경우의 보험입니다. 대신 작업이 TTL 보다 길면 락이 먼저 풀리는 문제가 생기므로 TTL 을 넉넉히 잡거나 작업 중에 연장합니다.',
  },
  {
    id: 'lockUnsafeRelease', app: 'lock', title: '토큰 확인 없이 해제', concept: '분산 락 · 소유권', theory: '../theory/index.html#concurrency',
    before: 'if (GET lock:job === 내토큰) DEL lock:job', after: 'DEL lock:job   // 누구 락인지 확인 안 함',
    try: '상황을 "작업 900ms 가 TTL 400ms 보다 김" 으로 바꿔서 실행해 보세요.',
    watch: '늦게 끝난 워커 0 이 "남의 락을 지움" — 그때 일하던 워커의 락이 사라집니다.',
    why: 'TTL 이 지나 락이 넘어간 뒤에 원래 주인이 끝나면, 확인 없이 DEL 할 경우 새 주인의 락을 지웁니다. 그러면 또 다른 워커가 들어와 동시에 작업하게 됩니다. 해제할 때는 반드시 "내 토큰일 때만" 지웁니다.',
  },
  {
    id: 'likesNaive', app: 'likes', title: 'GET → +1 → SET 으로 나누기', concept: '원자성 · 경쟁 상태', theory: '../theory/index.html#concurrency',
    before: 'INCR likes:post:1', after: 'v = GET likes:post:1\n// (네트워크 왕복)\nSET likes:post:1 v+1',
    try: '"100명이 동시에 좋아요" 를 눌러 보세요.',
    watch: '100번 눌렀는데 수십 개만 늘어납니다. 사라진 좋아요가 생깁니다.',
    why: '두 사람이 같은 값(예: 41)을 읽고 각자 42 를 쓰면 하나가 사라집니다(lost update). 명령 하나는 원자적이지만 두 명령의 조합은 아닙니다. INCR 처럼 서버 안에서 한 번에 하는 명령을 씁니다.',
  },
];
