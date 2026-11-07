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

  /** @param {{ ttl?: number, px?: number, nx?: boolean, xx?: boolean, tags?: string[] }} [opts]  @returns {Promise<boolean>} 저장됐으면 true */
  async set(key, value, opts = {}) {
    const r = await this.#call('PUT', `/keys/${encodeURIComponent(key)}`, { value, ...opts });
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
   * @returns {Promise<{ value: any, hit: boolean }>}
   */
  async getOrLoad(key, loader, opts = {}) {
    const cached = await this.get(key);
    if (cached !== null) return { value: JSON.parse(cached), hit: true };
    const value = await loader();
    await this.set(key, JSON.stringify(value), opts);
    return { value, hit: false };
  }
}
