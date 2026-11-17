/**
 * 읽기/쓰기 락 (Readers-Writer Lock) — 테이블마다 하나
 * ------------------------------------------------------------------
 *  - 읽기(SELECT)끼리는 동시에 여러 개 OK  → 스레드 풀의 여러 워커가 병렬로 조회
 *  - 쓰기(INSERT)는 혼자만               → id 중복, 파일에 두 줄이 섞여 쓰이는 문제, 인덱스 불일치를 막음
 *  - 공정성: 기다리는 쓰기가 있으면 새 읽기는 뒤에 줄 선다 (읽기가 계속 와서 쓰기가 영원히 못 하는 "기아" 방지)
 *  - 여러 테이블을 잡을 때는 항상 이름 순서로 → 교착 상태(deadlock) 방지
 *  - 락 이름은 key 함수로 하나로 맞춘다: SQL 에 USERS / users 로 적혀도 같은 테이블이면 같은 락
 *    (이름을 적힌 그대로 쓰면 한 테이블에 쓰기 락이 두 개 생겨서 INSERT 가 겹친다)
 */
const NOOP_RELEASE = () => {};

export class RWLock {
  constructor(name = '') {
    this.name = name;
    this.readers = 0;
    this.writer = false;
    this.queue = []; // { mode, resolve }
    this.queueHead = 0;
  }

  /** @returns {Promise<() => void>} 해제 함수 */
  acquire(mode) {
    if (this.queueHead >= this.queue.length && !this.writer && (mode === 'read' || this.readers === 0)) {
      if (mode === 'write') this.writer = true;
      else this.readers++;
      return Promise.resolve(this.#release(mode));
    }
    return new Promise((resolve) => {
      this.queue.push({ mode, resolve });
      this.#drain();
    });
  }

  #drain() {
    while (this.queueHead < this.queue.length) {
      const head = this.queue[this.queueHead];
      if (head.mode === 'write') {
        if (this.writer || this.readers > 0) return;
        this.writer = true;
        this.queueHead++;
        this.#compact();
        head.resolve(this.#release('write'));
        return;
      }
      if (this.writer) return; // 읽기는 쓰는 중이 아닐 때만, 그리고 앞에 기다리는 쓰기가 없을 때만 (queue 순서)
      this.readers++;
      this.queueHead++;
      head.resolve(this.#release('read'));
    }
    this.#compact();
  }

  #compact() {
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead >= 32 && this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
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
    return { readers: this.readers, writer: this.writer, waiting: this.queue.length - this.queueHead };
  }
}

export class LockManager {
  /**
   * @param {{ key?: (name: string) => string, readLocks?: boolean }} [opts]
   *   key: 테이블 이름 → 락 이름 (기본: 그대로)
   *   readLocks: false 면 읽기는 락을 잡지 않는다 (스냅샷 읽기 — service.js 의 snapshotReads 설명 참고)
   */
  constructor(opts = {}) {
    this.locks = new Map();
    this.key = opts.key ?? ((name) => name);
    this.readLocks = opts.readLocks ?? true;
  }

  #lock(name) {
    let l = this.locks.get(name);
    if (!l) this.locks.set(name, (l = new RWLock(name)));
    return l;
  }

  /**
   * @param {{ read?: string[], write?: string[] }} want
   * @returns {Promise<() => void>} 전부 해제하는 함수
   */
  acquire({ read = [], write = [] }) {
    const needRead = this.readLocks && read.length > 0;
    const needWrite = write.length > 0;
    if (!needRead && !needWrite) return Promise.resolve(NOOP_RELEASE);
    if (!needRead && write.length === 1) return this.#lock(this.key(write[0])).acquire('write');
    if (needRead && read.length === 1 && !needWrite) return this.#lock(this.key(read[0])).acquire('read');
    return this.#acquireMany(read, write, needRead);
  }

  async #acquireMany(read, write, needRead) {
    const modes = new Map();
    if (needRead) for (const t of read) modes.set(this.key(t), 'read');
    for (const t of write) modes.set(this.key(t), 'write'); // 같은 테이블을 읽고 쓰면 쓰기 락
    const order = [...modes.keys()].sort();
    const releases = [];
    for (const t of order) releases.push(await this.#lock(t).acquire(modes.get(t)));
    return () => {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    };
  }

  state() {
    return Object.fromEntries([...this.locks].map(([k, l]) => [k, l.state()]));
  }
}
