/**
 * MiniRedis HTTP API (Node) — 외부 프로그램이 HTTP + JSON 으로 쓰는 창구
 * ------------------------------------------------------------------
 *  GET    {p}/keys/:key                  값 조회        → 200 { key, value, ttl }   / 404 없음(만료 포함)
 *  PUT    {p}/keys/:key                  저장           body { value, ttl?, px?, nx?, xx?, tags? } → { ok, created }
 *  DELETE {p}/keys/:key                  삭제           → { deleted }
 *  POST   {p}/keys/:key/expire           만료 설정      body { ttl } (초)  /  { ttl: null } 이면 만료 해제
 *  POST   {p}/keys/:key/incr             정수 더하기    body { by? }  → { value }
 *  GET    {p}/keys?pattern=user:*        키 목록        → { keys }
 *  POST   {p}/invalidate                 무효화         body { tags?: [], pattern?: '' } → { deleted }
 *  POST   {p}/command                    명령 그대로    body { args: ['SET','a','1'] } 또는 { command: 'SET a 1' }
 *  POST   {p}/pipeline                   여러 명령 원자적 실행  body { commands: [[...], [...]] }
 *  GET    {p}/info                       상태/통계
 *
 *  동시성: Node 는 요청 처리 코드를 한 스레드에서 하나씩 실행하고, 저장소 명령은 동기 함수라서
 *          한 요청의 명령이 실행되는 도중에 다른 요청이 끼어들 수 없다. (I/O 대기만 겹친다)
 */
import { parseCommandLine, RedisError } from './miniredis.js';

const MAX_BODY = 1024 * 1024; // 1MB
const MAX_KEY = 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'TOO_LARGE', `요청 본문이 너무 큽니다 (최대 ${limit} 바이트).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const v = JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'BAD_JSON', '본문은 JSON 객체여야 합니다.'));
      }
    });
    req.on('error', reject);
  });
}

function checkKey(key) {
  if (!key) throw new HttpError(400, 'BAD_KEY', '키가 비어 있습니다.');
  if (key.length > MAX_KEY) throw new HttpError(400, 'BAD_KEY', `키가 너무 깁니다 (최대 ${MAX_KEY}자).`);
  return key;
}

function intOrNull(v, name) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, 'BAD_ARG', `${name} 은(는) 1 이상의 정수여야 합니다.`);
  return v;
}

/**
 * @param {import('./miniredis.js').MiniRedis} redis
 * @param {{ prefix?: string }} [opts]
 * @returns {(req, res) => Promise<boolean>}  처리했으면 true (prefix 가 아니면 false 를 돌려줘서 다른 라우트로)
 */
export function createRedisApi(redis, opts = {}) {
  const prefix = opts.prefix ?? '';
  const run = (args) => {
    try {
      return redis.command(args);
    } catch (e) {
      if (e instanceof RedisError) throw new HttpError(400, 'REDIS_ERROR', e.message);
      throw e;
    }
  };

  async function route(req, res, path, url) {
    const m = path.match(/^\/keys\/(.+?)(\/expire|\/incr)?$/);
    if (m) {
      let key;
      try {
        key = checkKey(decodeURIComponent(m[1]));
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(400, 'BAD_KEY', '키 주소가 올바르지 않습니다.');
      }
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        const value = run(['GET', key]);
        if (value === null) return send(res, 404, { error: 'NOT_FOUND', message: '키가 없거나 만료되었습니다.', key });
        return send(res, 200, { key, value, ttl: run(['TTL', key]) });
      }
      if (!sub && req.method === 'PUT') {
        const body = await readJson(req);
        if (typeof body.value !== 'string') throw new HttpError(400, 'BAD_VALUE', 'value 는 문자열이어야 합니다. 객체는 JSON.stringify 해서 보내세요.');
        const ttl = intOrNull(body.ttl, 'ttl');
        const px = intOrNull(body.px, 'px');
        if (ttl && px) throw new HttpError(400, 'BAD_ARG', 'ttl 과 px 는 하나만 쓸 수 있습니다.');
        const existed = run(['EXISTS', key]) === 1;
        const args = ['SET', key, body.value];
        if (ttl) args.push('EX', String(ttl));
        if (px) args.push('PX', String(px));
        if (body.nx) args.push('NX');
        if (body.xx) args.push('XX');
        const r = run(args);
        if (r === null) return send(res, 409, { error: 'CONDITION', message: body.nx ? '이미 있는 키입니다 (nx).' : '없는 키입니다 (xx).' });
        if (Array.isArray(body.tags) && body.tags.length) {
          if (!body.tags.every((t) => typeof t === 'string' && t)) throw new HttpError(400, 'BAD_ARG', 'tags 는 문자열 배열이어야 합니다.');
          run(['TAG', key, ...body.tags]);
        }
        return send(res, existed ? 200 : 201, { ok: true, created: !existed });
      }
      if (!sub && req.method === 'DELETE') return send(res, 200, { deleted: run(['DEL', key]) });
      if (sub === '/expire' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.ttl === null) return send(res, 200, { updated: run(['PERSIST', key]) === 1 });
        const ttl = intOrNull(body.ttl, 'ttl');
        if (!ttl) throw new HttpError(400, 'BAD_ARG', 'ttl 이 필요합니다.');
        const ok = run(['EXPIRE', key, String(ttl)]) === 1;
        return send(res, ok ? 200 : 404, ok ? { updated: true, ttl } : { error: 'NOT_FOUND', message: '키가 없습니다.' });
      }
      if (sub === '/incr' && req.method === 'POST') {
        const body = await readJson(req);
        const by = body.by ?? 1;
        if (!Number.isInteger(by)) throw new HttpError(400, 'BAD_ARG', 'by 는 정수여야 합니다.');
        return send(res, 200, { value: run(['INCRBY', key, String(by)]) });
      }
      throw new HttpError(405, 'METHOD', '이 주소에서 지원하지 않는 메서드입니다.');
    }
    if (path === '/keys' && req.method === 'GET') {
      return send(res, 200, { keys: run(['KEYS', url.searchParams.get('pattern') || '*']) });
    }
    if (path === '/invalidate' && req.method === 'POST') {
      const body = await readJson(req);
      let deleted = 0;
      if (Array.isArray(body.tags) && body.tags.length) deleted += run(['INVALIDATE', ...body.tags.map(String)]);
      if (typeof body.pattern === 'string' && body.pattern) deleted += run(['DELPATTERN', body.pattern]);
      if (!body.tags?.length && !body.pattern) throw new HttpError(400, 'BAD_ARG', 'tags 또는 pattern 이 필요합니다.');
      return send(res, 200, { deleted });
    }
    if (path === '/command' && req.method === 'POST') {
      const body = await readJson(req);
      let args = body.args;
      if (typeof body.command === 'string') {
        try {
          args = parseCommandLine(body.command);
        } catch (e) {
          throw new HttpError(400, 'REDIS_ERROR', e.message);
        }
      }
      if (!Array.isArray(args) || !args.length) throw new HttpError(400, 'BAD_ARG', 'args 배열 또는 command 문자열이 필요합니다.');
      return send(res, 200, { result: run(args.map(String)) });
    }
    if (path === '/pipeline' && req.method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.commands) || !body.commands.every(Array.isArray)) throw new HttpError(400, 'BAD_ARG', 'commands 는 배열의 배열이어야 합니다.');
      if (body.commands.length > 1000) throw new HttpError(400, 'BAD_ARG', '한 번에 최대 1000개 명령입니다.');
      return send(res, 200, { results: redis.pipeline(body.commands.map((c) => c.map(String))) });
    }
    if (path === '/info' && req.method === 'GET') return send(res, 200, redis.command(['INFO']));
    throw new HttpError(404, 'NO_ROUTE', '없는 API 주소입니다.');
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    const path = url.pathname.slice(prefix.length) || '/';
    try {
      await route(req, res, path, url);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
      else send(res, 500, { error: 'INTERNAL', message: e.message });
    }
    return true;
  };
}
