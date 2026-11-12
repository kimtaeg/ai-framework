// 의존성 없는 개발 서버
//  - 정적 파일 제공 (ES Module 은 file:// 에서 로드되지 않으므로 필요)
//  - POST /api/chat : 학습 가이드 챗봇. API 키는 서버에만 두고 브라우저에는 절대 보내지 않는다.
//  - /api/redis/*    : 2주차 미니 레디스 HTTP API (AOF: week2/data/redis.aof)
//  - /api/demo/*     : 미니 레디스를 캐시로 쓰는 느린 상품 API (cache-aside 예시)
//  - /api/sql        : 2주차 미니 DBMS API (스레드 풀, 데이터: week2/data/db)
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { handleChat } from './server/chat.js';
import { openPersistentRedis } from './week2/redis/persistence.js';
import { createRedisApi } from './week2/redis/api.js';
import { createProductApi } from './week2/redis/demo-api.js';
import { MiniRedisClient } from './week2/redis/client.js';
import { createDbService, createSqlApi } from './week2/dbms/service.js';
import { createTestLab } from './server/testlab.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const gzipAsync = promisify(gzip);
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.md']); // 글자로 된 파일만 압축 (이미지는 이미 압축돼 있다)
const GZIP_MIN = 1024;       // 이보다 작으면 압축해도 이득이 없다
const GZIP_CACHE_MAX = 300;  // 압축 결과를 기억해 두는 파일 수

/** 같은 컴퓨터에서 온 요청인지 (127.0.0.1, ::1) */
export function isLoopback(address) {
  const a = String(address ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

/** .env 파일의 KEY=VALUE 를 환경 변수로 읽는다 (이미 설정된 값은 덮어쓰지 않음) */
export function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** 브라우저에 보여주면 안 되는 파일: .env 같은 점(.)으로 시작하는 파일/폴더, node_modules, 서버 코드 */
function isPrivate(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  return parts.some((p) => p.startsWith('.') || p === 'node_modules') || parts[0] === 'server' || (parts[0] === 'week2' && parts[1] === 'data');
}

/** 2주차 서비스: 처음 요청이 올 때 연다 (테스트·1주차만 쓸 때는 파일이나 스레드를 만들지 않도록) */
export function createWeek2(dataDir = join(ROOT, 'week2', 'data'), { fsync = 'everysec', dbWorkers } = {}) {
  let redis = null, db = null, client = null;
  const getRedis = () => {
    if (!redis) {
      redis = openPersistentRedis(join(dataDir, 'redis.aof'), { fsync, hashSeed: randomInt(1, 0x7fffffff) });
      redis.redis.start();
    }
    return redis.redis;
  };
  let redisHandler = null;
  const redisApi = (req, res) => (redisHandler ??= createRedisApi(getRedis(), { prefix: '/api/redis' }))(req, res);
  const products = createProductApi({ prefix: '/api/demo', cache: () => client });
  const sqlApi = createSqlApi(() => (db ??= createDbService({ dir: join(dataDir, 'db'), ...(dbWorkers ? { workers: dbWorkers } : {}) })), { prefix: '/api/sql' });
  return {
    async handle(req, res, pathname) {
      if (pathname === '/api/redis' || pathname.startsWith('/api/redis/')) return redisApi(req, res);
      if (pathname.startsWith('/api/demo/')) {
        getRedis();
        client ??= new MiniRedisClient(`http://127.0.0.1:${req.socket.localPort}/api/redis`);
        return products(req, res);
      }
      if (pathname === '/api/sql' || pathname.startsWith('/api/sql/')) return sqlApi(req, res);
      return false;
    },
    async close() {
      redis?.redis.stop();
      redis?.aof.close(); // 버퍼에 남은 AOF 를 디스크에 쓴다
      await db?.close();
    },
  };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowRemoteApi]  /api/redis · /api/sql · /api/demo 를 다른 컴퓨터에서도 쓸 수 있게 할지.
 *   기본은 같은 컴퓨터(localhost)만. 이 API 들은 로그인 없이 SQL 과 레디스 명령을 그대로 실행하므로,
 *   열어 두면 같은 네트워크의 누구나 데이터를 넣거나 지울 수 있다. (열려면 환경 변수 ALLOW_REMOTE_API=1)
 */
export function createApp({ week2 = createWeek2(), testlab = createTestLab({ root: ROOT }), allowRemoteApi = process.env.ALLOW_REMOTE_API === '1' } = {}) {
  const gzipCache = new Map(); // 파일 경로 → { etag, body } (같은 파일을 요청마다 다시 압축하지 않게)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      // 테스트 실험실: 로그인 API + /testlab/ · /bench/ · /load/ 잠금 (비밀번호는 서버에서만 확인)
      if (await testlab.handle(req, res, url)) return;
      if (url.pathname === '/api/chat') {
        await handleChat(req, res);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!allowRemoteApi && !isLoopback(req.socket.remoteAddress)) {
          const body = JSON.stringify({ error: 'FORBIDDEN', message: '이 API 는 서버와 같은 컴퓨터에서만 쓸 수 있습니다. (다른 컴퓨터에 열려면 서버를 ALLOW_REMOTE_API=1 로 실행)' });
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
          return;
        }
        if ((await week2.handle(req, res, url.pathname)) !== false) return;
      }
      const path = decodeURIComponent(url.pathname);
      let file = normalize(join(ROOT, path));
      if (!(file === ROOT || file.startsWith(ROOT + sep)) || isPrivate(file.slice(ROOT.length))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
        return;
      }
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file);
      }
      if (!info) throw new Error('없는 파일');
      // ETag = 파일의 크기와 고친 시각. 브라우저가 가진 사본과 같으면 본문 없이 304 만 보낸다 (다시 내려받지 않음)
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const ext = extname(file);
      const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      let body = await readFile(file);
      // 글자로 된 파일은 gzip 으로 줄여 보낸다 (번들 JS 는 보통 1/4 ~ 1/5 로 준다)
      if (COMPRESSIBLE.has(ext) && body.length >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        let hit = gzipCache.get(file);
        if (!hit || hit.etag !== etag) {
          hit = { etag, body: await gzipAsync(body) };
          if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
          gzipCache.set(file, hit);
        }
        body = hit.body;
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  server.week2 = week2;
  server.testlab = testlab;
  return server;
}

// node server.js 로 직접 실행했을 때만 서버를 띄운다 (테스트에서는 createApp 만 가져다 씀)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  // 포트와 주소는 환경 변수로 바꿀 수 있다 (예: PORT=8080 HOST=127.0.0.1 node server.js)
  const PORT = Number(process.env.PORT) || 5200;
  const HOST = process.env.HOST || undefined; // 안 주면 모든 주소 (학습 페이지는 다른 기기에서도 볼 수 있다. API 는 위에서 따로 막는다)
  const app = createApp();
  const stop = async () => {
    app.testlab.stopJob(); // 돌고 있던 테스트 작업도 끈다
    await app.week2.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.listen(PORT, HOST, () => {
    console.log(`mini-react dev server → http://localhost:${PORT}`);
    console.log(process.env.GEMINI_API_KEY ? '학습 도우미 챗봇: 사용 가능' : '학습 도우미 챗봇: 꺼짐 (.env 에 GEMINI_API_KEY 를 넣으면 켜집니다)');
  });
}
