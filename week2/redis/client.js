/**
 * MiniRedis 클라이언트 — 다른 프로그램(브라우저, Node)에서 미니 레디스 서버를 쉽게 쓰기 위한 작은 라이브러리
 *
 *   const cache = new MiniRedisClient('http://localhost:6380');
 *   await cache.set('user:1', JSON.stringify(user), { ttl: 60, tags: ['users'] });
 *   const v = await cache.get('user:1');   // 없거나 만료되면 null
 *   await cache.invalidate({ tags: ['users'] });
 *
 * fetch 만 쓰므로 브라우저와 Node 18+ 양쪽에서 동작한다.
 */
export class MiniRedisClient {
  constructor(baseUrl, { fetch: f = globalThis.fetch } = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.fetch = f;
    this.flights = createSingleFlight(); // getOrLoad 의 캐시 스탬피드 방어
  }

  async #call(method, path, body) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  #fail({ status, data }) {
    const e = new Error(data.message || `MiniRedis 오류 (HTTP ${status})`);
    e.status = status;
    e.code = data.error;
    throw e;
  }

  /** @returns {Promise<string|null>} */
  async get(key) {
    const r = await this.#call('GET', `/keys/${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail(r);
    return r.data.value;
  }

  /**
   * @param {{ ttl?: number, px?: number, nx?: boolean, xx?: boolean, tags?: string[], jitter?: number }} [opts]
   *   jitter: 만료 시간을 ±비율만큼 무작위로 흩뜨린다 (예: 0.1 = ±10%).
   *     같은 때 만든 캐시가 같은 순간에 한꺼번에 만료돼 DB 로 요청이 몰리는 것(캐시 눈사태)을 막는다.
   * @returns {Promise<boolean>} 저장됐으면 true
   */
  async set(key, value, opts = {}) {
    const { jitter, ...send } = opts;
    if (jitter > 0 && (send.ttl || send.px)) {
      const ms = send.px ?? send.ttl * 1000;
      const spread = Math.min(1, jitter) * (Math.random() * 2 - 1); // -jitter ~ +jitter
      send.px = Math.max(1, Math.round(ms * (1 + spread)));
      delete send.ttl;
    }
    const r = await this.#call('PUT', `/keys/${encodeURIComponent(key)}`, { value, ...send });
    if (r.status === 409) return false;
    if (r.status >= 300) this.#fail(r);
    return true;
  }

  async del(key) {
    const r = await this.#call('DELETE', `/keys/${encodeURIComponent(key)}`);
    if (r.status !== 200) this.#fail(r);
    return r.data.deleted;
  }

  async expire(key, ttl) {
    const r = await this.#call('POST', `/keys/${encodeURIComponent(key)}/expire`, { ttl });
    if (r.status === 404) return false;
    if (r.status !== 200) this.#fail(r);
    return true;
  }

  async incr(key, by = 1) {
    const r = await this.#call('POST', `/keys/${encodeURIComponent(key)}/incr`, { by });
    if (r.status !== 200) this.#fail(r);
    return r.data.value;
  }

  async keys(pattern = '*') {
    const r = await this.#call('GET', `/keys?pattern=${encodeURIComponent(pattern)}`);
    if (r.status !== 200) this.#fail(r);
    return r.data.keys;
  }

  async invalidate({ tags, pattern } = {}) {
    const r = await this.#call('POST', '/invalidate', { tags, pattern });
    if (r.status !== 200) this.#fail(r);
    return r.data.deleted;
  }

  async command(...args) {
    const r = await this.#call('POST', '/command', { args: args.map(String) });
    if (r.status !== 200) this.#fail(r);
    return r.data.result;
  }

  async pipeline(commands) {
    const r = await this.#call('POST', '/pipeline', { commands });
    if (r.status !== 200) this.#fail(r);
    return r.data.results;
  }

  async info() {
    const r = await this.#call('GET', '/info');
    if (r.status !== 200) this.#fail(r);
    return r.data;
  }

  /**
   * 캐시 우선 조회 (cache-aside): 있으면 캐시에서, 없으면 loader() 로 가져와서 저장
   * @param {object} [opts]  set 의 옵션(ttl, tags, jitter ...) +
   *   lockMs: 0 보다 크면 서버끼리 공유하는 락(분산 락)을 건다. API 서버가 여러 대일 때,
   *           캐시가 빈 순간 서버마다 한 번씩 DB 로 가는 것까지 막는다 (값 = 락의 수명 ms. loader 가 걸리는 시간보다 넉넉히)
   * @returns {Promise<{ value: any, hit: boolean }>}
   */
  async getOrLoad(key, loader, opts = {}) {
    const cached = await this.get(key);
    if (cached !== null) return { value: JSON.parse(cached), hit: true };
    const { lockMs = 0, ...setOpts } = opts;
    // 캐시 스탬피드 방어 1: 이 서버 안에서 같은 키를 동시에 놓친 요청들은 loader(DB 조회)를 한 번만 실행한다
    const { value, hit } = await this.flights.run(key, async () => {
      if (lockMs > 0) return this.#loadWithLock(key, loader, setOpts, lockMs);
      const v = await loader();
      await this.set(key, JSON.stringify(v), setOpts);
      return { value: v, hit: false };
    }).then((r) => r.value);
    return { value, hit };
  }

  /**
   * 캐시 스탬피드 방어 2 (분산 락): SET lock:키 NX PX 로 "내가 가져오는 중" 을 서버끼리 알린다.
   *   락을 잡은 한 곳만 loader 를 실행하고, 못 잡은 곳은 잠깐씩 기다리며 캐시가 채워지기를 본다.
   *   락에는 수명(PX)이 있어서, 잡은 서버가 죽어도 영원히 잠기지 않는다.
   */
  async #loadWithLock(key, loader, setOpts, lockMs) {
    const lockKey = `lock:${key}`;
    const deadline = Date.now() + lockMs;
    for (;;) {
      const t0 = Date.now();
      if (await this.set(lockKey, '1', { px: lockMs, nx: true })) {
        try {
          const v = await loader();
          await this.set(key, JSON.stringify(v), setOpts);
          return { value: v, hit: false };
        } finally {
          // 락의 수명이 남아 있을 때만 지운다 (이미 만료됐다면 다른 서버가 새로 잡은 락일 수 있다)
          if (Date.now() - t0 < lockMs) await this.del(lockKey).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 25));
      const cached = await this.get(key);
      if (cached !== null) return { value: JSON.parse(cached), hit: true };
      if (Date.now() >= deadline) {
        // 락을 잡은 쪽이 끝내지 못했다 → 더 기다리지 않고 직접 가져온다
        const v = await loader();
        await this.set(key, JSON.stringify(v), setOpts);
        return { value: v, hit: false };
      }
    }
  }
}

/**
 * 싱글 플라이트 (single-flight) — 캐시 스탬피드(Cache Stampede) 방어
 * ------------------------------------------------------------------
 *  캐시가 비는 순간 같은 키를 100명이 동시에 조회하면, 100명 모두 "캐시에 없네" 하고 DB 로 몰려간다.
 *  → 같은 키로 이미 가져오는 중인 요청이 있으면 새로 시작하지 않고 그 결과를 함께 기다린다 (1등만 DB 로).
 *
 *  이 구현은 한 프로세스(API 서버 한 대) 안에서만 막는다. 서버가 여러 대면 서버마다 한 번씩은 DB 로 간다
 *  → 그때는 레디스의 SET key value NX PX 로 서버끼리 공유하는 락을 건다 (분산 락).
 */
export function createSingleFlight() {
  const inflight = new Map(); // 키 → 진행 중인 Promise
  return {
    /** @returns {Promise<{ value: any, shared: boolean }>} shared: 다른 요청이 시작한 조회의 결과를 받았는지 */
    async run(key, fn) {
      const running = inflight.get(key);
      if (running) {
        const value = await running;
        // 함께 기다린 요청마다 복사본을 준다 (한 요청이 결과를 고쳐도 다른 요청에 보이지 않게)
        return { value: value === undefined ? value : JSON.parse(JSON.stringify(value)), shared: true };
      }
      const p = Promise.resolve().then(fn);
      inflight.set(key, p);
      try {
        return { value: await p, shared: false };
      } finally {
        inflight.delete(key); // 성공이든 실패든 끝나면 지운다 → 다음 요청은 새로 시도
      }
    },
    get size() { return inflight.size; },
  };
}
