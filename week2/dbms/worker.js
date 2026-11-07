/**
 * 스레드 풀의 워커 하나 — 자기만의 Database(=Phase 1 처리기 + Phase 2 B+ 트리) 인스턴스를 가진다
 *   task   { sql, delayMs? }       → SQL 실행 결과
 *   notify { type: 'index', ... } → 다른 워커가 넣은 레코드를 내 인덱스에도 반영
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Database } from './engine.js';
import { FileStorage } from './storage-file.js';

const storage = new FileStorage(workerData.dir);
const db = new Database(storage, { order: workerData.order ?? 64 });

/** 실제로 오래 걸리는 쿼리를 흉내 (병렬 처리가 눈에 보이도록). CPU 를 쓰지 않고 이 스레드만 잠재운다 */
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function block(ms) {
  if (ms > 0) Atomics.wait(sleeper, 0, 0, Math.min(ms, 5000));
}

parentPort.on('message', (m) => {
  if (m.type === 'notify') {
    const n = m.message;
    if (n.type === 'index') db.applyIndex(n.table, n.entries);
    else if (n.type === 'reload') db.loadIndexes();
    return;
  }
  if (m.type !== 'task') return;
  try {
    block(m.task.delayMs ?? 0);
    const results = db.execute(m.task.sql);
    parentPort.postMessage({ seq: m.seq, result: results });
  } catch (e) {
    parentPort.postMessage({ seq: m.seq, error: { name: e.name, message: e.message } });
  }
});

parentPort.postMessage({ type: 'ready', workerId: workerData.workerId });
