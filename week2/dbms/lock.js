/**
 * 읽기/쓰기 락 (Readers-Writer Lock) — 테이블마다 하나
 * ------------------------------------------------------------------
 *  - 읽기(SELECT)끼리는 동시에 여러 개 OK  → 스레드 풀의 여러 워커가 병렬로 조회
 *  - 쓰기(INSERT)는 혼자만               → id 중복, 파일에 두 줄이 섞여 쓰이는 문제, 인덱스 불일치를 막음
 *  - 공정성: 기다리는 쓰기가 있으면 새 읽기는 뒤에 줄 선다 (읽기가 계속 와서 쓰기가 영원히 못 하는 "기아" 방지)
 *  - 여러 테이블을 잡을 때는 항상 이름 순서로 → 교착 상태(deadlock) 방지
 */
export class RWLock {
  constructor(name = '') {
    this.name = name;
    this.readers = 0;
    this.writer = false;
    this.queue = []; // { mode, resolve }
  }

  /** @returns {Promise<() => void>} 해제 함수 */
  acquire(mode) {
    return new Promise((resolve) => {
      this.queue.push({ mode, resolve });
      this.#drain();
    });
  }

  #drain() {
    while (this.queue.length) {
      const head = this.queue[0];
      if (head.mode === 'write') {
        if (this.writer || this.readers > 0) return;
        this.writer = true;
        this.queue.shift();
        head.resolve(this.#release('write'));
        return;
      }
      if (this.writer) return; // 읽기는 쓰는 중이 아닐 때만, 그리고 앞에 기다리는 쓰기가 없을 때만 (queue 순서)
      this.readers++;
      this.queue.shift();
      head.resolve(this.#release('read'));
    }
  }

  #release(mode) {
    let done = false;
    return () => {
      if (done) return; // 두 번 풀어도 안전
      done = true;
      if (mode === 'write') this.writer = false;
      else this.readers--;
      this.#drain();
    };
  }

  state() {
    return { readers: this.readers, writer: this.writer, waiting: this.queue.length };
  }
}

export class LockManager {
  constructor() {
    this.locks = new Map();
  }

  #lock(name) {
    if (!this.locks.has(name)) this.locks.set(name, new RWLock(name));
    return this.locks.get(name);
  }

  /**
   * @param {{ read?: string[], write?: string[] }} want
   * @returns {Promise<() => void>} 전부 해제하는 함수
   */
  async acquire({ read = [], write = [] }) {
    const modes = new Map();
    for (const t of read) modes.set(t, 'read');
    for (const t of write) modes.set(t, 'write'); // 같은 테이블을 읽고 쓰면 쓰기 락
    const order = [...modes.keys()].sort();
    const releases = [];
    for (const t of order) releases.push(await this.#lock(t).acquire(modes.get(t)));
    return () => releases.reverse().forEach((r) => r());
  }

  state() {
    return Object.fromEntries([...this.locks].map(([k, l]) => [k, l.state()]));
  }
}
