// 컨테이너용 미니 레디스: 모든 인터페이스(0.0.0.0)에서 듣고, 실제 Redis 쪽과 맞추기 위해 AOF 는 끈다.
import { startRedisServer } from '../week2/redis/server.js';

const s = await startRedisServer({ host: '0.0.0.0', port: Number(process.env.PORT ?? 6380), aofPath: null });
console.log(`MiniRedis → :${s.port} (AOF 끔)`);
const stop = async () => { await s.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
