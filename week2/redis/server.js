/**
 * MiniRedis 단독 서버
 *   node week2/redis/server.js [--port 6380] [--aof week2/data/redis.aof] [--fsync everysec|always|no] [--no-aof]
 *
 *   http://localhost:6380/keys/:key ...   (API 목록은 api.js 맨 위 주석)
 *   http://localhost:6380/demo/products/1 (캐시를 쓰는 느린 상품 API 예시)
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniRedis } from './miniredis.js';
import { openPersistentRedis } from './persistence.js';
import { createRedisApi } from './api.js';
import { createProductApi } from './demo-api.js';
import { MiniRedisClient } from './client.js';

export function startRedisServer({ port = 6380, aofPath = null, fsync = 'everysec', latencyMs = 120 } = {}) {
  let redis, aof = null, restored = null;
  if (aofPath) ({ redis, aof, restored } = openPersistentRedis(aofPath, { fsync }));
  else redis = new MiniRedis();
  redis.start();
  const api = createRedisApi(redis);
  let client = null;
  const products = createProductApi({ prefix: '/demo', latencyMs, cache: () => client });
  const server = createServer(async (req, res) => {
    if (await products(req, res)) return;
    await api(req, res);
  });
  return new Promise((ok) => {
    server.listen(port, () => {
      client = new MiniRedisClient(`http://127.0.0.1:${server.address().port}`);
      const close = () =>
        new Promise((done) => {
          redis.stop();
          aof?.close();
          server.closeAllConnections?.();
          server.close(() => done());
        });
      ok({ server, redis, aof, restored, port: server.address().port, close, products });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? def : process.argv[i + 1];
  };
  const noAof = process.argv.includes('--no-aof');
  const s = await startRedisServer({
    port: Number(arg('port', 6380)),
    aofPath: noAof ? null : resolve(arg('aof', 'week2/data/redis.aof')),
    fsync: arg('fsync', 'everysec'),
  });
  console.log(`MiniRedis → http://localhost:${s.port}  (AOF: ${noAof ? '끔' : `${arg('aof', 'week2/data/redis.aof')}, fsync=${arg('fsync', 'everysec')}`})`);
  if (s.restored) console.log(`복원: 명령 ${s.restored.applied}개${s.restored.truncated ? ', 잘린 마지막 줄 버림' : ''}`);
  const shutdown = async () => {
    await s.close(); // 버퍼에 남은 AOF 를 디스크에 쓰고 끝낸다
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
