// 컨테이너용 미니 레디스: 모든 인터페이스(0.0.0.0)에서 듣고, 실제 Redis 쪽과 맞추기 위해 AOF 는 끈다.
//   :6380  HTTP + JSON  (원래 방식, backend=mini)
//   :6381  RESP / TCP   (실제 Redis 와 같은 말, backend=miniresp) — 같은 프로세스 · 같은 저장소를 함께 쓴다
//          XCPU 는 실험용 명령: 이 프로세스가 지금까지 쓴 CPU 시간(µs)을 돌려준다 (요청당 CPU 계산용)
import { startRedisServer } from '../week2/redis/server.js';
import { startRespServer } from './resp.js';

const s = await startRedisServer({ host: '0.0.0.0', port: Number(process.env.PORT ?? 6380), aofPath: null });
const handler = (args) => {
  if (String(args[0]).toUpperCase() === 'XCPU') { const u = process.cpuUsage(); return u.user + u.system; }
  return s.redis.command(args);
};
const resp = await startRespServer({ handler, port: Number(process.env.RESP_PORT ?? 6381) });
console.log(`MiniRedis → HTTP :${s.port} · RESP :${resp.port} (AOF 끔, 저장소 하나)`);
const stop = async () => { await resp.close(); await s.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
