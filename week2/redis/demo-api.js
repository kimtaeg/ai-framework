/**
 * 기능 테스트용 "느린 상품 API" — 응답을 MiniRedis 에 저장해서(cache-aside) 빨라지는지 확인한다
 * ------------------------------------------------------------------
 *  GET  {p}/products/:id      상품 조회. 캐시가 있으면 먼저 캐시 → 없으면 "DB"(느림) → 캐시에 저장
 *                             응답 헤더 X-Cache: HIT | MISS | BYPASS,  X-Elapsed-Ms
 *  GET  {p}/products/:id?cache=0   캐시를 쓰지 않고 항상 DB 에서 (성능 비교용)
 *  GET  {p}/products/:id?cache=local  미니 레디스 대신 API 서버 안의 메모리 캐시(Map) 로 (대안 비교용)
 *  PUT  {p}/products/:id      가격 변경 → DB 수정 후 그 상품 캐시와 목록 캐시를 무효화
 *  GET  {p}/products          전체 목록 (태그 'products' 로 캐시)
 *
 *  "DB" 는 일부러 latencyMs 만큼 기다리는 가짜 저장소다. (실제 DB 조회·외부 API 호출 비용을 흉내)
 */
import { readJson } from './api.js';

export const SEED_PRODUCTS = [
  { id: 1, name: '기계식 키보드', price: 89000, stock: 12 },
  { id: 2, name: '무선 마우스', price: 32000, stock: 40 },
  { id: 3, name: '27인치 모니터', price: 259000, stock: 5 },
  { id: 4, name: 'USB-C 허브', price: 45000, stock: 0 },
  { id: 5, name: '노트북 거치대', price: 27000, stock: 18 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 비교용 대안: API 서버 "안" 의 메모리 캐시 (Map). 미니 레디스 클라이언트와 같은 모양(get/set/del/getOrLoad).
 * 네트워크를 거치지 않아 빠르지만, 서버가 여러 대면 서로 공유되지 않고 서버를 다시 켜면 사라진다.
 */
export class LocalCache {
  constructor({ now = () => Date.now() } = {}) { this.map = new Map(); this.now = now; }
  async get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires && e.expires <= this.now()) { this.map.delete(key); return null; }
    return e.value;
  }
  async set(key, value, opts = {}) {
    this.map.set(key, { value: String(value), expires: opts.ttl ? this.now() + opts.ttl * 1000 : 0 });
    return true;
  }
  async del(key) { return this.map.delete(key) ? 1 : 0; }
  async getOrLoad(key, loader, opts = {}) {
    const cached = await this.get(key);
    if (cached !== null) return { value: JSON.parse(cached), hit: true };
    const value = await loader();
    await this.set(key, JSON.stringify(value), opts);
    return { value, hit: false };
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * @param {{ cache?: () => (import('./client.js').MiniRedisClient | null), latencyMs?: number, ttl?: number, prefix?: string }} opts
 *   cache 는 함수로 받는다 (서버 주소가 정해진 뒤에 클라이언트를 만들 수 있게)
 */
export function createProductApi(opts = {}) {
  const prefix = opts.prefix ?? '';
  const latency = opts.latencyMs ?? 120;
  const ttl = opts.ttl ?? 60;
  const db = new Map(SEED_PRODUCTS.map((p) => [p.id, { ...p }])); // 가짜 DB (캐시가 아니라 원본이라 Map 사용)
  const counters = { dbQueries: 0 };
  const localCache = new LocalCache(); // ?cache=local 비교용

  async function dbFind(id) {
    counters.dbQueries++;
    await sleep(latency);
    const p = db.get(id);
    return p ? { ...p } : null;
  }

  async function dbList() {
    counters.dbQueries++;
    await sleep(latency);
    return [...db.values()].map((p) => ({ ...p }));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    const path = url.pathname.slice(prefix.length);
    const t0 = performance.now();
    const mode = url.searchParams.get('cache');
    const cache = mode === '0' ? null : mode === 'local' ? localCache : opts.cache?.() ?? null;
    const done = (status, body, state) =>
      send(res, status, body, { 'X-Cache': state, 'X-Elapsed-Ms': (performance.now() - t0).toFixed(1), 'X-Db-Queries': String(counters.dbQueries) });

    try {
      if (path === '/products' && req.method === 'GET') {
        if (!cache) return done(200, await dbList(), 'BYPASS'), true;
        const { value, hit } = await cache.getOrLoad('products:all', dbList, { ttl, tags: ['products'] });
        return done(200, value, hit ? 'HIT' : 'MISS'), true;
      }
      const m = path.match(/^\/products\/([^/]+)$/);
      if (m) {
        const id = Number(m[1]);
        if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'BAD_ID', message: '상품 id 는 1 이상의 정수입니다.' }), true;
        if (req.method === 'GET') {
          if (!cache) {
            const p = await dbFind(id);
            return p ? done(200, p, 'BYPASS') : done(404, { error: 'NOT_FOUND' }, 'BYPASS'), true;
          }
          const key = `product:${id}`;
          const cached = await cache.get(key);
          if (cached !== null) {
            const v = JSON.parse(cached);
            // 없는 상품도 짧게 캐시해 둔다 (negative caching) → 없는 id 로 DB 를 계속 두드리는 것을 막음
            return v === null ? done(404, { error: 'NOT_FOUND' }, 'HIT') : done(200, v, 'HIT'), true;
          }
          const p = await dbFind(id);
          await cache.set(key, JSON.stringify(p), { ttl: p ? ttl : 5, tags: ['products'] });
          return p ? done(200, p, 'MISS') : done(404, { error: 'NOT_FOUND' }, 'MISS'), true;
        }
        if (req.method === 'PUT') {
          const body = await readJson(req);
          const p = db.get(id);
          if (!p) return send(res, 404, { error: 'NOT_FOUND' }), true;
          if (!Number.isInteger(body.price) || body.price < 0) return send(res, 400, { error: 'BAD_PRICE', message: 'price 는 0 이상의 정수입니다.' }), true;
          await sleep(latency);
          p.price = body.price;
          // 원본을 바꾼 뒤 캐시를 지운다 (지우기 → 다음 조회가 새 값을 다시 캐시)
          let invalidated = 0;
          const c = opts.cache?.();
          if (c) {
            invalidated += await c.del(`product:${id}`);
            invalidated += await c.del('products:all');
          }
          await localCache.del(`product:${id}`); // 비교용 메모리 캐시도 같이 지운다
          await localCache.del('products:all');
          return send(res, 200, { ...p, invalidated }), true;
        }
      }
      return send(res, 404, { error: 'NO_ROUTE' }), true;
    } catch (e) {
      send(res, e.status ?? 500, { error: e.code ?? 'INTERNAL', message: e.message });
      return true;
    }
  }

  handle.counters = counters;
  handle.db = db;
  return handle;
}
