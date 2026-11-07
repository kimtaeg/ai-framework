// 의존성 없는 개발 서버
//  - 정적 파일 제공 (ES Module 은 file:// 에서 로드되지 않으므로 필요)
//  - POST /api/chat : 학습 가이드 챗봇. API 키는 서버에만 두고 브라우저에는 절대 보내지 않는다.
//  - /api/redis/*    : 2주차 미니 레디스 HTTP API (AOF: week2/data/redis.aof)
//  - /api/demo/*     : 미니 레디스를 캐시로 쓰는 느린 상품 API (cache-aside 예시)
//  - /api/sql        : 2주차 미니 DBMS API (스레드 풀, 데이터: week2/data/db)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
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
      redis = openPersistentRedis(join(dataDir, 'redis.aof'), { fsync });
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

export function createApp({ week2 = createWeek2(), testlab = createTestLab({ root: ROOT }) } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      // 테스트 실험실: 로그인 API + /testlab/ · /bench/ · /load/ 잠금 (비밀번호는 서버에서만 확인)
      if (await testlab.handle(req, res, url)) return;
      if (url.pathname === '/api/chat') {
        await handleChat(req, res);
        return;
      }
      if (url.pathname.startsWith('/api/') && (await week2.handle(req, res, url.pathname)) !== false) return;
      const path = decodeURIComponent(url.pathname);
      let file = normalize(join(ROOT, path));
      if (!(file === ROOT || file.startsWith(ROOT + sep)) || isPrivate(file.slice(ROOT.length))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
        return;
      }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
  const PORT = 5200; 
  const app = createApp();
  const stop = async () => {
    app.testlab.stopJob(); // 돌고 있던 테스트 작업도 끈다
    await app.week2.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.listen(PORT, () => {
    console.log(`mini-react dev server → http://localhost:${PORT}`);
    console.log(process.env.GEMINI_API_KEY ? '학습 도우미 챗봇: 사용 가능' : '학습 도우미 챗봇: 꺼짐 (.env 에 GEMINI_API_KEY 를 넣으면 켜집니다)');
  });
}
