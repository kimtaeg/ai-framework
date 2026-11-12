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
 *  - 묶음 처리 (maxBatch > 1): 일이 밀려 있으면 한 워커에게 여러 개를 한 번에 보낸다.
 *      워커는 하나 끝낼 때마다 "다음 일 주세요" 를 기다리지 않고 받은 일을 이어서 처리한다
 *      → 요청마다 드는 스레드 간 왕복(메시지 보내고 깨우기)이 줄어, 짧은 조회가 몰릴 때 처리량이 오른다.
 *      한 워커가 가져가는 양은 "밀린 일 ÷ 워커 수" 까지만 (한 워커에 몰아주고 나머지가 노는 일이 없게).
 */
import { Worker } from 'node:worker_threads';

export class ThreadPool {
  /**
   * @param {string|URL} file  워커 스크립트
   * @param {{ size?: number, workerData?: any, timeoutMs?: number, maxBatch?: number, canBatch?: (task: any) => boolean }} [opts]
   *   maxBatch: 한 워커에 한 번에 보내는 일의 최대 개수 (기본 1 = 묶지 않음). 워커 스크립트가 'batch' 메시지를 처리해야 한다
   *   canBatch: 묶어도 되는 일인지 (기본: 모두). 오래 걸리는 일은 묶지 않아야 다른 워커가 나눠 처리한다
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.size = Math.max(1, opts.size ?? 4);
    this.workerData = opts.workerData;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxBatch = Math.max(1, opts.maxBatch ?? 1);
    this.canBatch = opts.canBatch ?? (() => true);
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
      const batch = slot.busy;
      const job = batch?.jobs.get(m.seq);
      if (!job) return;
      batch.jobs.delete(m.seq);
      const now = performance.now();
      slot.done++;
      if (m.error) {
        this.stats.failed++;
        const e = new Error(m.error.message);
        e.name = m.error.name;
        e.workerId = id;
        job.reject(e);
      } else {
        this.stats.completed++;
        // 묶음 안의 일은 앞의 일이 끝난 때부터 실행된 것으로 본다
        job.resolve({ result: m.result, workerId: id, waitedMs: batch.lastAt - job.enqueuedAt, execMs: now - batch.lastAt });
      }
      batch.lastAt = now;
      if (batch.jobs.size) {
        batch.timer.refresh(); // 남은 일에 다시 제한 시간을 준다 (제한 시간은 일 하나 기준)
        return;
      }
      clearTimeout(batch.timer);
      slot.busy = null;
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
      for (const job of slot.busy.jobs.values()) {
        this.stats.failed++;
        job.reject(error);
      }
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
      // 이 워커가 가져갈 개수: 밀린 일을 워커 수로 나눈 몫까지, 맨 앞부터 묶어도 되는 일이 이어지는 만큼
      let take = 1;
      if (this.maxBatch > 1 && this.canBatch(this.queue[0].task)) {
        const share = Math.min(this.maxBatch, Math.ceil(this.queue.length / n));
        while (take < share && this.canBatch(this.queue[take].task)) take++;
      }
      const picked = this.queue.splice(0, take);
      const batch = {
        jobs: new Map(picked.map((j) => [j.seq, j])),
        lastAt: performance.now(),
        timer: setTimeout(() => this.#crash(slot, new Error(`요청이 ${this.timeoutMs}ms 안에 끝나지 않았습니다.`)), this.timeoutMs),
      };
      slot.busy = batch;
      if (take === 1) slot.worker.postMessage({ type: 'task', seq: picked[0].seq, task: picked[0].task });
      else slot.worker.postMessage({ type: 'batch', tasks: picked.map((j) => ({ seq: j.seq, task: j.task })) });
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
    // 워커에서 실행 중이던 요청도 실패로 끝낸다 — 워커를 끝내면 응답이 오지 않으므로, 그대로 두면 영원히 기다린다
    for (const w of this.workers) {
      if (!w.busy) continue;
      clearTimeout(w.busy.timer);
      for (const job of w.busy.jobs.values()) {
        this.stats.failed++;
        job.reject(new Error('스레드 풀이 닫혔습니다 (실행 중이던 요청).'));
      }
      w.busy = null;
    }
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
