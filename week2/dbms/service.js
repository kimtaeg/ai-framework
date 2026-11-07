/**
 * Phase 3: 미니 DBMS API 서버 — 내부 DB 엔진(Phase 1 + 2) 을 스레드 풀로 감싼다
 * ------------------------------------------------------------------
 *   클라이언트 ──HTTP──▶ [메인 스레드]  요청 받기 · SQL 미리 파싱(문법 에러는 바로 400) · 락 잡기 · 일 나눠주기
 *                              │
 *               ┌──────────────┼──────────────┐
 *            [워커 0]       [워커 1]  …    [워커 N-1]     각자 Database 인스턴스(처리기 + B+ 트리)로 실행
 *               └──────────────┴──────────────┘
 *                              │
 *                       data/*.tbl (공유 파일)
 *
 *  동시성 문제와 해결
 *   - 두 INSERT 가 동시에 같은 id 를 받음 / 파일에 두 줄이 섞여 쓰임  → 테이블 쓰기 락(한 번에 하나)
 *   - 워커마다 인덱스를 따로 들고 있어서, 워커 0 이 넣은 행을 워커 1 이 못 찾음
 *       → INSERT 가 끝나면 (id → 위치) 를 다른 모든 워커에 알리고 나서 락을 푼다.
 *         워커는 메시지를 받은 순서대로 처리하므로, 이후 조회는 항상 최신 인덱스로 실행된다.
 *   - 조회끼리는 서로 영향이 없으니 읽기 락으로 여러 워커가 동시에 (병렬)
 *
 *  API
 *   POST {p}          { sql, delayMs? }  → { results, workerId, waitedMs, lockMs, execMs }
 *   GET  {p}/status   스레드 풀 / 락 상태
 *   GET  {p}/tables   테이블별 행 수, B+ 트리 높이
 */
import { availableParallelism } from 'node:os';
import { Database } from './engine.js';
import { SqlError } from './sql.js';
import { ThreadPool } from './pool.js';
import { LockManager } from './lock.js';
import { FileStorage } from './storage-file.js';

const MAX_SQL = 1024 * 1024;

export function createDbService({ dir, workers = Math.min(4, Math.max(2, availableParallelism())), timeoutMs = 15000 } = {}) {
  const fsx = new FileStorage(dir); // 폴더와 schema.json, 테이블 파일을 미리 만든다
  const tableNames = Object.keys(fsx.schema());
  fsx.close();
  const pool = new ThreadPool(new URL('./worker.js', import.meta.url), { size: workers, workerData: { dir }, timeoutMs });
  const locks = new LockManager();
  const stats = { requests: 0, writes: 0, reads: 0, errors: 0, active: 0, maxActive: 0 };

  async function query(sql, { delayMs = 0 } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) throw new SqlError('sql 이 비어 있습니다.');
    if (sql.length > MAX_SQL) throw new SqlError('SQL 이 너무 깁니다 (최대 1MB).');
    stats.requests++;
    const { writes, reads } = Database.analyze(sql); // 문법 에러는 여기서 바로 (워커를 쓰지 않음)
    const t0 = performance.now();
    const release = await locks.acquire({ read: reads, write: writes });
    const lockMs = performance.now() - t0;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const r = await pool.run({ sql, delayMs: Math.max(0, Math.min(5000, Number(delayMs) || 0)) });
      // 새로 넣은 레코드 위치를 다른 워커들에게 알린다 (락을 풀기 전에!)
      for (const res of r.result) {
        if (res.type === 'insert' && res.entries.length) pool.broadcast({ type: 'index', table: res.table, entries: res.entries }, r.workerId);
      }
      if (writes.length) stats.writes++;
      else stats.reads++;
      return { results: r.result.map(({ entries, ...rest }) => rest), workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs };
    } catch (e) {
      stats.errors++;
      throw e;
    } finally {
      stats.active--;
      release();
    }
  }

  /** 테이블별 행 수 · B+ 트리 높이 (읽기 락을 잡고 워커에서 계산) */
  async function tables() {
    const r = await query(tableNames.map((t) => `SELECT id FROM ${t} WHERE id = 0`).join(';'));
    return r.results.map((x) => ({ table: x.table, rows: x.plan.total, height: x.plan.height }));
  }

  return {
    query,
    pool,
    locks,
    stats,
    ready: () => pool.ready(),
    status: () => ({ pool: pool.status(), locks: locks.state(), ...stats }),
    tables,
    tableNames,
    close: () => pool.close(),
  };
}

/** HTTP 핸들러 */
export function createSqlApi(getService, { prefix = '' } = {}) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    const path = url.pathname.slice(prefix.length) || '/';
    try {
      const svc = getService();
      if (path === '/status' && req.method === 'GET') return send(res, 200, svc.status()), true;
      if (path === '/tables' && req.method === 'GET') {
        return send(res, 200, { tables: await svc.tables() }), true;
      }
      if (path === '/' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.sql !== 'string') return send(res, 400, { error: 'BAD_REQUEST', message: '본문에 { "sql": "..." } 가 필요합니다.' }), true;
        const r = await svc.query(body.sql, { delayMs: body.delayMs });
        return send(res, 200, r), true;
      }
      return send(res, 404, { error: 'NO_ROUTE', message: '없는 API 주소입니다.' }), true;
    } catch (e) {
      if (e instanceof SqlError || e.name === 'SqlError') return send(res, 400, { error: 'SQL_ERROR', message: e.message }), true;
      if (e.status) return send(res, e.status, { error: e.code, message: e.message }), true;
      return send(res, 500, { error: 'INTERNAL', message: e.message }), true;
    }
  };

}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_SQL + 1024) {
        const e = new Error('요청 본문이 너무 큽니다.');
        e.status = 413;
        e.code = 'TOO_LARGE';
        reject(e);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        const e = new Error('본문은 JSON 객체여야 합니다.');
        e.status = 400;
        e.code = 'BAD_JSON';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
