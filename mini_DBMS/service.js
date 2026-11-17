/**
 * Phase 3: 미니 DBMS API 서버 — 내부 DB 엔진(Phase 1 + 2) 을 스레드 풀로 감싼다
 * ------------------------------------------------------------------
 *   클라이언트 ──HTTP──▶ [메인 스레드]  요청 받기 · 쓰기 요청은 SQL 미리 파싱 · 락 잡기 · 일 나눠주기 (문법 에러는 400)
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
 *  운영 안전장치
 *   - maxPending (기본 10000): 받아서 아직 끝나지 않은 요청이 이만큼이면 새 요청을 바로 503 으로 거절한다.
 *   - allowDelay (기본 켬): 요청의 delayMs(느린 쿼리 흉내, 병렬 처리 시연용)를 받을지. 밖에 여는 서버에서는 꺼야 한다 —
 *       켜 두면 요청 몇 개로 모든 워커를 5초씩 잠재울 수 있다 (서버는 --no-delay)
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
import { FileStorage, lockDataDir } from './storage-file.js';

const MAX_SQL = 1024 * 1024;
const MAX_GROUP = 64;         // 쓰기 묶음 하나에 담는 요청 수의 상한
const MAX_GROUP_CHARS = 256 * 1024; // 쓰기 묶음 하나에 담는 SQL 글자 수의 상한 (큰 INSERT 는 혼자 또는 몇 개만)
const MAY_WRITE = /insert/i;  // 이 글자가 어디에도 없으면 쓰기 문장이 있을 수 없다 → 읽기만 하는 요청

export function createDbService({ dir, workers = Math.min(4, Math.max(2, availableParallelism())), timeoutMs = 15000, autoIndex = true, snapshotReads = true, maxPending = 10000, allowDelay = true, groupCommit = true, poolPages, maxRows = 100_000, sync = false, maxBatch = 16 } = {}) {
  // 이 폴더에 쓰는 프로그램은 하나만: 다른 서버나 CLI 가 쓰고 있으면 여기서 멈춘다 (close 에서 푼다. 죽으면 다음 시작이 치운다)
  const unlockDir = lockDataDir(dir, 'API 서버');
  const fsx = new FileStorage(dir); // 폴더와 schema.json, 테이블 파일을 미리 만든다
  const tableNames = Object.keys(fsx.schema());
  // fsx 는 열어 둔다: 답 없이 끝난 쓰기(시간 초과 · 워커가 죽음)를 되돌릴 때 쓴다.
  //   쓰기 락을 잡은 직후의 파일 크기를 적어 두고(sizeNow), 답이 없으면 그 크기로 자른다(undo).
  //   자르지 않으면 "실패" 라고 응답한 요청의 행이 파일에 남아 조회에 나온다.
  const sizeNow = (t) => {
    if (!tableNames.includes(t)) return -1; // 없는 테이블: 오류는 워커가 알려 준다
    fsx.refresh(t);
    return fsx.size(t);
  };
  const undo = (marks) => {
    if (pool.closed) return; // 닫는 중에는 워커가 아직 끝나지 않았을 수 있어 건드리지 않는다
    for (const [t, size] of marks) {
      if (size < 0) continue;
      fsx.refresh(t);
      fsx.truncate(t, size);
    }
  };
  // 락 이름은 스키마의 실제 테이블 이름으로 통일한다. 엔진은 대소문자를 구분하지 않고 테이블을 찾으므로,
  // SQL 에 적힌 그대로(USERS / users) 락을 잡으면 같은 테이블에 쓰기 락이 두 개 생겨 INSERT 가 겹친다.
  const canonical = new Map(tableNames.map((t) => [t.toLowerCase(), t]));
  const pool = new ThreadPool(new URL('./worker.js', import.meta.url), {
    size: workers,
    workerData: { dir, autoIndex, maxRows, sync, poolPages },
    timeoutMs,
    maxBatch,
    canBatch: (task) => !task.delayMs, // 일부러 느리게 한 요청은 묶지 않는다 (다른 워커가 나눠 처리해야 병렬 효과가 보인다)
  });
  const locks = new LockManager({ key: (name) => canonical.get(String(name).toLowerCase()) ?? name, readLocks: !snapshotReads });
  const stats = { requests: 0, writes: 0, reads: 0, errors: 0, rejected: 0, active: 0, maxActive: 0 };
  let pending = 0; // 받아서 아직 끝나지 않은 요청 수 (락 대기 + 풀 대기 + 실행 중)
  const canonicalNames = (names) => {
    if (names.length === 0) return names;
    if (names.length === 1) return [canonical.get(String(names[0]).toLowerCase()) ?? names[0]];
    return [...new Set(names.map((n) => canonical.get(String(n).toLowerCase()) ?? n))];
  };

  /** HTTP 용: 응답 본문(JSON 글자열)을 바로 돌려준다. 결과의 직렬화는 워커가 한다 */
  const queryJson = (sql, opts = {}) => query(sql, { ...opts, raw: true });

  async function query(sql, { delayMs = 0, params = null, raw = false } = {}) {
    if (typeof sql !== 'string' || !sql.trim()) throw new SqlError('sql 이 비어 있습니다.');
    if (sql.length > MAX_SQL) throw new SqlError('SQL 이 너무 깁니다 (최대 1MB).');
    stats.requests++;
    if (params != null && !Array.isArray(params)) throw new SqlError('params 는 배열이어야 합니다.');
    // 배압(backpressure): 처리 속도보다 빨리 들어오면 대기열이 끝없이 길어지고, 줄 선 요청이 전부 늦어지다 제한 시간에 걸린다.
    // 그 전에 "지금은 못 받는다" 고 바로 거절해야, 이미 받은 요청이라도 제때 끝난다
    if (pending >= maxPending) {
      stats.rejected++;
      const e = new Error(`서버가 바쁩니다. 처리 중이거나 기다리는 요청이 ${pending}개입니다. 잠시 뒤 다시 시도하세요.`);
      e.status = 503;
      e.code = 'BUSY';
      throw e;
    }
    pending++;
    try {
      return await dispatch(sql, Math.max(0, Math.min(5000, Number(allowDelay ? delayMs : 0) || 0)), params, raw);
    } finally {
      pending--;
    }
  }

  const envelope = (json, workerId, waitedMs, lockMs, execMs) => `{"results":${json},"workerId":${workerId},"waitedMs":${waitedMs},"lockMs":${lockMs},"execMs":${execMs}}`;
  const workerError = (err, workerId) => {
    const e = err.name === 'SqlError' ? new SqlError(err.message) : Object.assign(new Error(err.message), { name: err.name });
    e.workerId = workerId;
    return e;
  };

  /**
   * 요청을 가장 싼 길로 보낸다.
   *  1) 읽기만 하는 요청 (snapshotReads 일 때): 락이 필요 없으므로 메인 스레드에서 SQL 을 미리 파싱하지 않고 바로 워커로.
   *     (문법 오류도 워커가 찾아 준다. 메인 스레드는 모든 요청이 거치는 한 줄 통로라서, 여기서 하는 일을 줄여야 전체 처리량이 는다)
   *  2) 한 테이블에만 쓰는 요청: 쓰기 묶음(group commit) — 같은 테이블에 줄 선 요청들을 락 한 번에 함께 처리.
   *  3) 그 밖 (여러 테이블에 쓰기 · 읽기 락 모드 · 일부러 느리게 한 요청): 요청마다 락을 잡는 기본 길 (run).
   */
  async function dispatch(sql, delayMs, params, raw) {
    if (snapshotReads && !MAY_WRITE.test(sql)) return readOnly(sql, delayMs, params, raw);
    const a = Database.analyze(sql, params ?? null);
    const w = canonicalNames(a.writes);
    if (snapshotReads && w.length === 0) return readOnly(sql, delayMs, params, raw);
    if (groupCommit && !delayMs) {
      if (w.length === 1 && (snapshotReads || canonicalNames(a.reads).every((t) => t === w[0]))) {
        // 짧은 SQL 은 워커의 parseCached 가 AST 구조화 복제보다 빠르다
        const payload = sql.length <= 2048 ? { sql, ...(params ? { params } : {}), raw, chars: sql.length } : { statements: a.statements, raw, chars: sql.length };
        return groupWrite(w[0], payload);
      }
    }
    const r = await run(sql, delayMs, params);
    return raw ? envelope(JSON.stringify(r.results), r.workerId, r.waitedMs, r.lockMs, r.execMs) : r;
  }

  async function readOnly(sql, delayMs, params, raw) {
    stats.active++;
    if (stats.active > stats.maxActive) stats.maxActive = stats.active;
    try {
      const r = await pool.run({ sql, ...(params ? { params } : {}), delayMs, raw });
      stats.reads++;
      return raw ? envelope(r.json, r.workerId, r.waitedMs, 0, r.execMs) : { results: r.result, workerId: r.workerId, waitedMs: r.waitedMs, lockMs: 0, execMs: r.execMs };
    } catch (e) {
      stats.errors++;
      throw e.workerId !== undefined ? workerError(e, e.workerId) : e;
    } finally {
      stats.active--;
    }
  }

  // ---------------------------------------------------------------- 쓰기 묶음 (group commit)
  // 쓰기는 테이블마다 한 번에 하나다. 요청마다 "락 → 워커 왕복 → 다른 워커에 알림 → 락 해제" 를 하면
  // 쓰기 처리량이 왕복 한 번의 시간에 묶인다. 그래서 락을 기다리는 동안 쌓인 같은 테이블의 쓰기 요청을
  // 락 한 번, 워커 왕복 한 번, 파일 기록 한 번, 인덱스 알림 한 번으로 함께 처리한다. (실제 DBMS 의 group commit 과 같은 생각)
  // 요청마다 결과와 성공/실패는 따로다: 한 요청이 실패해도 같은 묶음의 다른 요청에는 영향이 없다.
  const groups = new Map(); // 테이블 → { queue, running }
  function groupWrite(table, payload) {
    let g = groups.get(table);
    if (!g) groups.set(table, (g = { queue: [], running: false }));
    return new Promise((resolve, reject) => {
      payload.resolve = resolve;
      payload.reject = reject;
      payload.at = performance.now();
      g.queue.push(payload);
      if (!g.running) drain(table, g);
    });
  }

  async function drain(table, g) {
    g.running = true;
    try {
      while (g.queue.length) {
        const release = await locks.acquire({ write: [table] });
        const before = sizeNow(table);
        // 락을 기다리는 동안 더 쌓인 것까지 담되, 개수(MAX_GROUP)와 SQL 크기(MAX_GROUP_CHARS)로 끊는다.
        // 묶음 하나가 워커의 제한 시간(일 하나 기준)을 함께 쓰므로, 대량 INSERT 여러 개를 한 묶음에 몰면
        // 느린 요청 하나 때문에 묶음 전체가 시간 초과로 실패할 수 있다.
        let take = 0, chars = 0;
        while (take < g.queue.length && take < MAX_GROUP && (take === 0 || chars + g.queue[take].chars <= MAX_GROUP_CHARS)) chars += g.queue[take++].chars;
        const batch = g.queue.splice(0, take);
        const started = performance.now();
        stats.active += batch.length;
        if (stats.active > stats.maxActive) stats.maxActive = stats.active;
        try {
          const group = new Array(batch.length);
          for (let i = 0; i < batch.length; i++) {
            const b = batch[i];
            group[i] = b.statements ? { statements: b.statements, raw: b.raw } : { sql: b.sql, ...(b.params ? { params: b.params } : {}), raw: b.raw };
          }
          const r = await pool.run({ group });
          pool.stats.completed += batch.length - 1; // 풀은 묶음을 일 하나로 셌다 → 통계는 요청 수로 맞춘다
          // 새로 넣은 레코드 위치를 다른 워커들에게 한 번에 알린다 (락을 풀기 전에!)
          const entries = [];
          let end = null;
          for (const item of r.group) {
            if (item.entries) for (const e of item.entries) entries.push(e);
            if (typeof item.end === 'number') end = item.end;
          }
          if (entries.length) pool.broadcast({ type: 'index', table, entries, end }, r.workerId);
          for (let i = 0; i < batch.length; i++) {
            const b = batch[i], item = r.group[i];
            if (item.error) {
              stats.errors++;
              b.reject(workerError(item.error, r.workerId));
              continue;
            }
            stats.writes++;
            const lockMs = started - b.at;
            b.resolve(b.raw ? envelope(item.json, r.workerId, r.waitedMs, lockMs, r.execMs) : { results: item.result, workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs });
          }
        } catch (e) {
          // 묶음 전체가 답 없이 끝났다 (시간 초과 · 워커가 죽음): 일부가 파일에 남았을 수 있으니 이 테이블만 다시 읽게 한다
          stats.errors += batch.length;
          undo([[table, before]]);
          pool.broadcast({ type: 'reload', tables: [table] });
          for (const b of batch) b.reject(e);
        } finally {
          stats.active -= batch.length;
          release();
        }
      }
    } finally {
      g.running = false;
    }
  }

  async function run(sql, delayMs, params) {
    const { writes, reads } = Database.analyze(sql, params ?? null); // 문법 에러는 여기서 바로 (워커를 쓰지 않음)
    const statements = Database._lastStatements;
    const t0 = performance.now();
    const release = await locks.acquire({ read: reads, write: writes });
    const lockMs = performance.now() - t0;
    const marks = canonicalNames(writes).map((t) => [t, sizeNow(t)]);
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const task = sql.length <= 2048 ? { sql, ...(params ? { params } : {}), delayMs } : { statements, delayMs };
      const r = await pool.run(task);
      // 새로 넣은 레코드 위치를 다른 워커들에게 알린다 (락을 풀기 전에!)
      if (writes.length) {
        for (const res of r.result) {
          if (res.type === 'insert' && res.entries.length) pool.broadcast({ type: 'index', table: res.table, entries: res.entries }, r.workerId);
        }
        stats.writes++;
        return { results: r.result.map(({ entries, end, ...rest }) => rest), workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs };
      }
      stats.reads++;
      return { results: r.result, workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs };
    } catch (e) {
      stats.errors++;
      // 워커가 "에러" 라고 답한 경우(e.workerId 가 있음): 그 워커가 이미 스스로 되돌렸고(engine.js 의 execute),
      //   다른 워커는 이 요청의 레코드를 알지도 못한다 → 아무것도 다시 읽을 필요가 없다.
      //   (여기서도 다시 읽게 하면, 값 하나 틀린 INSERT 한 번에 모든 워커가 파일 전체를 처음부터 훑는다)
      // 답이 없는 경우(시간 초과 · 워커가 죽음): 되돌릴 기회가 없어서 일부가 파일에 남았을 수 있다.
      //   락을 풀기 전에 모든 워커가 인덱스와 nextId 를 파일에서 다시 만들게 한다 — 이 요청이 쓰기 락을 쥔 테이블만.
      //   (다른 테이블은 지금 다른 요청이 쓰는 중일 수 있다. 락 밖의 테이블을 건드리면 쓰다 만 내용을 읽게 된다)
      if (writes.length && e.workerId === undefined) {
        undo(marks);
        pool.broadcast({ type: 'reload', tables: canonicalNames(writes) });
      }
      throw e.workerId !== undefined ? workerError(e, e.workerId) : e; // 워커가 알려 준 SQL 오류는 SqlError 로
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
    queryJson,
    pool,
    locks,
    stats,
    ready: () => pool.ready(),
    status: () => ({ pool: pool.status(), locks: locks.state(), ...stats }),
    tables,
    tableNames,
    close: async () => {
      try {
        await pool.close();
      } finally {
        fsx.close();
        unlockDir();
      }
    },
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
    const rawUrl = req.url;
    const q = rawUrl.indexOf('?');
    let pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (pathname.startsWith('http://') || pathname.startsWith('https://')) pathname = new URL(rawUrl).pathname;
    if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) return false;
    const path = pathname.slice(prefix.length) || '/';
    try {
      const svc = getService();
      if (path === '/status' && req.method === 'GET') return send(res, 200, svc.status()), true;
      if (path === '/tables' && req.method === 'GET') {
        return send(res, 200, { tables: await svc.tables() }), true;
      }
      if (path === '/' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.sql !== 'string') return send(res, 400, { error: 'BAD_REQUEST', message: '본문에 { "sql": "..." } 가 필요합니다.' }), true;
        const text = await svc.queryJson(body.sql, { delayMs: body.delayMs, params: body.params });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
        return res.end(text), true;
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
        const text = chunks.length === 0 ? '' : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).toString('utf8');
        const v = JSON.parse(text || '{}');
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
