/**
 * 미니 DBMS 단독 API 서버 (Phase 3)
 *   node week2/dbms/server.js [--port 7000] [--data week2/data/db] [--workers 4] [--lock-reads] [--no-auto-index]
 *
 *   curl -X POST localhost:7000/sql -H "Content-Type: application/json" -d "{\"sql\":\"SELECT * FROM users LIMIT 3\"}"
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbService, createSqlApi } from './service.js';

export async function startDbServer({ port = 7000, host = '127.0.0.1', dir, workers, autoIndex, snapshotReads, sync, maxRows } = {}) {
  const svc = createDbService({ dir, workers, autoIndex, snapshotReads, sync, maxRows });
  await svc.ready();
  const api = createSqlApi(() => svc, { prefix: '/sql' });
  const server = createServer(async (req, res) => {
    if (!(await api(req, res))) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NO_ROUTE', message: 'POST /sql, GET /sql/status, GET /sql/tables 를 쓰세요.' }));
    }
  });
  await new Promise((ok) => server.listen(port, host, ok));
  return {
    server, svc, port: server.address().port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(ok));
      await svc.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : process.argv[i + 1];
  };
  const s = await startDbServer({ port: Number(arg('port', 7000)), dir: resolve(arg('data', 'week2/data/db')), workers: Number(arg('workers', 4)), snapshotReads: !process.argv.includes('--lock-reads'), sync: process.argv.includes('--fsync'), autoIndex: !process.argv.includes('--no-auto-index') });
  console.log(`미니 DBMS API → http://localhost:${s.port}/sql  (워커 ${s.svc.pool.size}개)`);
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
