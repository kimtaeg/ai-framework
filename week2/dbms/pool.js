/**
 * 스레드 풀 (Node worker_threads)
 * ------------------------------------------------------------------
 *  요청이 올 때마다 스레드를 새로 만들면 만들고 없애는 비용이 크고, 요청이 몰리면 스레드가 끝없이 늘어난다.
 *  → 처음에 N 개를 만들어 두고(풀), 일이 오면 쉬고 있는 워커에게 맡긴다. 모두 바쁘면 큐에서 기다린다.
 *
 *  - run(task)        : 쉬는 워커에게 보내고 결과를 Promise 로
 *  - broadcast(msg)   : 모든 워커에게 알림 (예: 다른 워커가 넣은 레코드의 인덱스 반영)
 *                       워커 하나에게 보낸 메시지는 보낸 순서대로 처리되므로, 알림을 먼저 보내면
 *                       그 뒤에 그 워커에게 가는 조회는 반드시 알림이 반영된 상태에서 실행된다.
 *  - 워커가 죽으면 새로 만들고, 처리 중이던 요청은 실패로 돌려준다.
 *  - 너무 오래 걸리는 요청(timeout)은 그 워커를 끝내고 새로 만든다.
 */
import { Worker } from 'node:worker_threads';

export class ThreadPool {
  /**
   * @param {string|URL} file  워커 스크립트
   * @param {{ size?: number, workerData?: any, timeoutMs?: number }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.size = Math.max(1, opts.size ?? 4);
    this.workerData = opts.workerData;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.queue = [];
    this.workers = [];
    this.seq = 0;
    this.closed = false;
    this.broken = null;
    this.rr = 0;
    this.startupFailures = 0;
    this.stats = { completed: 0, failed: 0, maxQueue: 0, restarts: 0 };
    for (let i = 0; i < this.size; i++) this.workers.push(this.#spawn(i));
  }

  #spawn(id) {
    // 부모가 node -e / --input-type 으로 실행됐으면 그 옵션이 워커로 넘어가 워커가 시작을 못 한다 → 그때만 비운다
    // (평소에는 Node 기본값대로 부모 옵션을 물려받게 둔다)
    const evalFlags = process.execArgv.some((a) => a.startsWith('--input-type') || a === '-e' || a === '--eval' || a === '-p');
    const worker = new Worker(this.file, { workerData: { ...this.workerData, workerId: id }, ...(evalFlags ? { execArgv: [] } : {}) });
    const slot = { id, worker, busy: null, done: 0, ready: false };
    worker.on('message', (m) => {
      if (m.type === 'ready') {
        slot.ready = true;
        return this.#next();
      }
      if (!slot.busy || m.seq !== slot.busy.seq) return;
      const job = slot.busy;
      clearTimeout(job.timer);
      slot.busy = null;
      slot.done++;
      if (m.error) {
        this.stats.failed++;
        const e = new Error(m.error.message);
        e.name = m.error.name;
        e.workerId = id;
        job.reject(e);
      } else {
        this.stats.completed++;
        job.resolve({ result: m.result, workerId: id, waitedMs: job.startedAt - job.enqueuedAt, execMs: performance.now() - job.startedAt });
      }
      this.#next();
    });
    worker.on('error', (e) => this.#crash(slot, e));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.#crash(slot, new Error(`워커 ${id} 이(가) 종료되었습니다 (code ${code}).`));
    });
    return slot;
  }

  #crash(slot, error) {
    if (this.closed) return;
    const i = this.workers.indexOf(slot);
    if (i === -1) return;
    if (slot.busy) {
      clearTimeout(slot.busy.timer);
      this.stats.failed++;
      slot.busy.reject(error);
      slot.busy = null;
    }
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => {});
    // 시작도 못 하고 죽는 워커를 끝없이 다시 만들지 않는다 (스크립트 오류 등)
    if (!slot.ready && ++this.startupFailures > this.size * 2) {
      this.broken = new Error(`워커를 시작할 수 없습니다: ${error.message}`);
      for (const job of this.queue) job.reject(this.broken);
      this.queue = [];
      this.workers.splice(i, 1);
      return;
    }
    this.stats.restarts++;
    this.workers[i] = this.#spawn(slot.id);
  }

  /** @returns {Promise<{ result, workerId, waitedMs, execMs }>} */
  run(task) {
    if (this.closed) return Promise.reject(new Error('스레드 풀이 닫혔습니다.'));
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, seq: ++this.seq, enqueuedAt: performance.now() });
      this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length);
      this.#next();
    });
  }

  #next() {
    while (this.queue.length) {
      // 돌아가며 맡긴다 (round-robin) — 항상 0번 워커에만 일이 몰리지 않게
      const n = this.workers.length;
      let slot = null;
      for (let k = 0; k < n && !slot; k++) {
        const w = this.workers[(this.rr + k) % n];
        if (w.ready && !w.busy) slot = w;
      }
      if (!slot) return;
      this.rr = (this.workers.indexOf(slot) + 1) % n;
      const job = this.queue.shift();
      job.startedAt = performance.now();
      job.timer = setTimeout(() => this.#crash(slot, new Error(`요청이 ${this.timeoutMs}ms 안에 끝나지 않았습니다.`)), this.timeoutMs);
      slot.busy = job;
      slot.worker.postMessage({ type: 'task', seq: job.seq, task: job.task });
    }
  }

  /** 모든 워커(except 제외)에게 알림 */
  broadcast(message, except = -1) {
    for (const w of this.workers) if (w.id !== except) w.worker.postMessage({ type: 'notify', message });
  }

  status() {
    return {
      size: this.size,
      queued: this.queue.length,
      workers: this.workers.map((w) => ({ id: w.id, busy: !!w.busy, done: w.done, ready: w.ready })),
      ...this.stats,
    };
  }

  /** 모든 워커가 준비될 때까지 */
  async ready() {
    while (!this.workers.every((w) => w.ready)) {
      if (this.broken) throw this.broken;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.queue) job.reject(new Error('스레드 풀이 닫혔습니다.'));
    this.queue = [];
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
