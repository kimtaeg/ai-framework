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
 *  지연을 줄이는 두 가지 옵션
 *   - autoIndex (기본 켬): WHERE email = ? 처럼 id 가 아닌 열의 = 조건은 원래 파일 전체를 읽는다(O(n)).
 *       그 열을 처음 조회할 때 워커가 해시 인덱스(값 → 위치)를 만들어 두고, 다음부터는 그 줄만 읽는다.
 *   - snapshotReads (기본 켬): 조회가 읽기 락을 잡지 않는다. 파일은 덧붙이기만 하고, 워커는
 *       "확정된 끝 위치" 까지만 읽으므로, 쓰는 중인 INSERT 가 있어도 조회는 기다리지 않고 직전까지의 내용을 본다.
 *       반쯤 쓴 행은 보이지 않고, INSERT 가 끝났다는 응답을 받은 뒤의 조회는 항상 그 행을 본다.
 *       쓰기끼리는 여전히 테이블 쓰기 락으로 한 번에 하나.
 *       (끄면 읽기/쓰기 락 그대로: 쓰는 동안 같은 테이블 조회가 기다린다 — 서버는 --lock-reads)
 *
 *  그 밖의 옵션
 *   - maxRows (기본 10만): SELECT 한 문장이 돌려주는 행 수의 상한. 넘으면 잘라서 주고 truncated: true 를 붙인다
 *   - sync (기본 끔): INSERT 마다 디스크에 확정(fsync)한 뒤 응답한다. 전원이 나가도 "성공" 한 행이 남지만 느리다
 *   - 묶음 처리: 조회가 밀리면 한 워커에 여러 개를 한 번에 보낸다 (pool.js). delayMs 가 있는 요청은 묶지 않는다
 *
 *  API
 *   POST {p}          { sql, params?, delayMs? }  → { results, workerId, waitedMs, lockMs, execMs }
 *                     params: SQL 의 ? 자리에 순서대로 들어갈 값 배열 (값을 문자열에 끼워 넣지 않아 인젝션에 안전)
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

export function createDbService({ dir, workers = Math.min(4, Math.max(2, availableParallelism())), timeoutMs = 15000, autoIndex = true, snapshotReads = true, maxRows = 100_000, sync = false, maxBatch = 16 } = {}) {
  const fsx = new FileStorage(dir); // 폴더와 schema.json, 테이블 파일을 미리 만든다
  const tableNames = Object.keys(fsx.schema());
  fsx.close();
  // 락 이름은 스키마의 실제 테이블 이름으로 통일한다. 엔진은 대소문자를 구분하지 않고 테이블을 찾으므로,
  // SQL 에 적힌 그대로(USERS / users) 락을 잡으면 같은 테이블에 쓰기 락이 두 개 생겨 INSERT 가 겹친다.
  const canonical = new Map(tableNames.map((t) => [t.toLowerCase(), t]));
  const pool = new ThreadPool(new URL('./worker.js', import.meta.url), {
    size: workers,
    workerData: { dir, autoIndex, maxRows, sync },
    timeoutMs,
    maxBatch,
    canBatch: (task) => !task.delayMs, // 일부러 느리게 한 요청은 묶지 않는다 (다른 워커가 나눠 처리해야 병렬 효과가 보인다)
  });
  const locks = new LockManager({ key: (name) => canonical.get(String(name).toLowerCase()) ?? name, readLocks: !snapshotReads });
  const stats = { requests: 0, writes: 0, reads: 0, errors: 0, active: 0, maxActive: 0 };

  async function query(sql, { delayMs = 0, params = null } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) throw new SqlError('sql 이 비어 있습니다.');
    if (sql.length > MAX_SQL) throw new SqlError('SQL 이 너무 깁니다 (최대 1MB).');
    stats.requests++;
    if (params != null && !Array.isArray(params)) throw new SqlError('params 는 배열이어야 합니다.');
    const { writes, reads } = Database.analyze(sql, params ?? null); // 문법 에러는 여기서 바로 (워커를 쓰지 않음)
    const t0 = performance.now();
    const release = await locks.acquire({ read: reads, write: writes });
    const lockMs = performance.now() - t0;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const r = await pool.run({ sql, ...(params ? { params } : {}), delayMs: Math.max(0, Math.min(5000, Number(delayMs) || 0)) });
      // 새로 넣은 레코드 위치를 다른 워커들에게 알린다 (락을 풀기 전에!)
      for (const res of r.result) {
        if (res.type === 'insert' && res.entries.length) pool.broadcast({ type: 'index', table: res.table, entries: res.entries }, r.workerId);
      }
      if (writes.length) stats.writes++;
      else stats.reads++;
      return { results: r.result.map(({ entries, ...rest }) => rest), workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs };
    } catch (e) {
      stats.errors++;
      // 실패한 요청이 넣은 레코드는 워커가 되돌린다 (engine.js 의 execute).
      // 다만 시간 초과로 워커를 끝낸 경우에는 되돌릴 기회가 없어서 일부가 파일에 남을 수 있다.
      // 락을 풀기 전에 모든 워커가 파일에서 인덱스와 nextId 를 다시 만들게 한다.
      if (writes.length) pool.broadcast({ type: 'reload' });
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
    const s = JSON.stringify(body);
    // 길이를 알려 주면 chunked 인코딩 없이 헤더와 본문을 한 번에 보낸다 (응답마다 패킷이 나뉘지 않게)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
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
        const r = await svc.query(body.sql, { delayMs: body.delayMs, params: body.params });
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
