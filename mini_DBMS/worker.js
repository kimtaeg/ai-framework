/**
 * 스레드 풀의 워커 하나 — 자기만의 Database(=Phase 1 처리기 + Phase 2 B+ 트리) 인스턴스를 가진다
 *   task   { sql, params?, delayMs? } → SQL 실행 결과
 *   batch  { tasks: [{ seq, task }] } → 여러 일을 이어서 실행하고 하나씩 결과를 보낸다 (pool.js 의 묶음 처리)
 *   notify { type: 'index', ... } → 다른 워커가 넣은 레코드를 내 인덱스에도 반영
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Database } from './engine.js';
import { FileStorage } from './storage-file.js';

// 쓰다 만 줄 정리는 메인 스레드가 풀을 만들기 전에 끝낸다. 워커가 (다시) 뜰 때는 다른 워커가 쓰는 중일 수 있으니 하지 않는다
const storage = new FileStorage(workerData.dir, { repair: false, sync: workerData.sync ?? false, poolPages: workerData.poolPages });
const db = new Database(storage, { order: workerData.order ?? 64, autoIndex: workerData.autoIndex ?? false, maxRows: workerData.maxRows });

/** 실제로 오래 걸리는 쿼리를 흉내 (병렬 처리가 눈에 보이도록). CPU 를 쓰지 않고 이 스레드만 잠재운다 */
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function block(ms) {
  if (ms > 0) Atomics.wait(sleeper, 0, 0, Math.min(ms, 5000));
}

parentPort.on('message', (m) => {
  if (m.type === 'notify') {
    const n = m.message;
    if (n.type === 'index') db.applyIndex(n.table, n.entries, n.end);
    else if (n.type === 'reload') db.loadIndexes(n.tables ?? null); // tables 가 있으면 그 테이블만
    return;
  }
  if (m.type === 'task') run(m.seq, m.task);
  else if (m.type === 'batch') for (const t of m.tasks) run(t.seq, t.task);
});

/**
 * 쓰기 묶음(group commit): 같은 테이블에 쓰려고 줄 서 있던 요청 여러 개를 한 번에 받아 차례로 실행하고,
 * 파일에는 묶음 끝에서 한 번만 기록한다. 요청마다 성공/실패는 따로다 (실패한 요청은 자기가 넣은 것만 되돌린다).
 */
function runGroup(list) {
  const out = [];
  for (const t of list) {
    try {
      const results = db.execute(t.statements ?? t.sql, t.params, false);
      const entries = [];
      let end = null;
      for (const r of results) {
        if (r.type !== 'insert') continue;
        for (const e of r.entries) entries.push(e);
        if (typeof r.end === 'number') end = r.end;
        delete r.entries; // 인덱스 알림용 → 응답에는 넣지 않는다
        delete r.end;
      }
      out.push(t.raw ? { json: JSON.stringify(results), entries, end } : { result: results, entries, end });
    } catch (e) {
      out.push({ error: { name: e.name, message: e.message } });
    }
  }
  db.storage.flush();
  return out;
}

function run(seq, task) {
  try {
    if (task.group) return parentPort.postMessage({ seq, group: runGroup(task.group) });
    block(task.delayMs ?? 0);
    const results = db.execute(task.statements ?? task.sql, task.params);
    // raw: 결과를 워커에서 JSON 글자열로 만든다 → 직렬화가 워커들에 나뉘고, 메인 스레드는 글자열을 그대로 응답에 쓴다
    if (task.raw) return parentPort.postMessage({ seq, json: JSON.stringify(results) });
    parentPort.postMessage({ seq, result: results });
  } catch (e) {
    parentPort.postMessage({ seq, error: { name: e.name, message: e.message } });
  }
}

parentPort.postMessage({ type: 'ready', workerId: workerData.workerId });
