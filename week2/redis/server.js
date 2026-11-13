/**
 * MiniRedis 단독 서버
 *   node week2/redis/server.js [--port 6380] [--aof week2/data/redis.aof] [--fsync everysec|always|no] [--no-aof]
 *
 *   http://localhost:6380/keys/:key ...   (API 목록은 api.js 맨 위 주석)
 *   http://localhost:6380/demo/products/1 (캐시를 쓰는 느린 상품 API 예시)
 */
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniRedis } from './miniredis.js';
import { openPersistentRedis } from './persistence.js';
import { createRedisApi } from './api.js';
import { createProductApi } from './demo-api.js';
import { MiniRedisClient } from './client.js';

export function startRedisServer({ port = 6380, host = '127.0.0.1', aofPath = null, fsync = 'everysec', latencyMs = 120, maxMemory = 0 } = {}) {
  let redis, aof = null, restored = null;
  // 해시 시드를 서버마다 무작위로: 밖에서 버킷 위치를 미리 계산해 한 버킷에 몰리는 키를 보낼 수 없게
  const hashSeed = randomInt(1, 0x7fffffff);
  if (aofPath) ({ redis, aof, restored } = openPersistentRedis(aofPath, { fsync, hashSeed, maxMemory }));
  else redis = new MiniRedis({ hashSeed, maxMemory });
  redis.start();
  const api = createRedisApi(redis);
  let client = null;
  const products = createProductApi({ prefix: '/demo', latencyMs, cache: () => client });
  const server = createServer(async (req, res) => {
    if (await products(req, res)) return;
    await api(req, res);
  });
  return new Promise((ok) => {
    server.listen(port, host, () => {
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
    maxMemory: Number(arg('maxmemory', 0)) || 0, // 바이트. 넘으면 오래 안 쓴 키부터 지운다 (0 = 제한 없음)
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
