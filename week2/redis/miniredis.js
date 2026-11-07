/**
 * MiniRedis — 직접 만든 해시 테이블 위의 키-값 저장소
 * ------------------------------------------------------------------
 *  저장 구조 (Redis 와 같은 생각)
 *    data    : key → { value: string, expireAt: number|null, tags: string[] }
 *    expires : key → expireAt   (TTL 이 있는 키만. 만료 키를 표본으로 뽑을 때 TTL 없는 키를 건너뛰려고 따로 둔다)
 *    tagIdx  : tag → HashTable(key → true)  (태그로 한꺼번에 무효화)
 *
 *  동시성
 *    JavaScript 는 한 번에 한 명령만 실행한다(단일 스레드 이벤트 루프). command() 는 동기 함수라서
 *    실행 도중에 다른 요청이 끼어들 수 없다 → 명령 하나는 항상 원자적(atomic). 진짜 Redis 도 같은 이유로
 *    명령 처리를 한 스레드로 한다. 여러 명령을 한 덩어리로 실행하려면 pipeline(atomic) 을 쓴다.
 *
 *  만료 처리 (두 가지를 함께 쓴다)
 *    1) 지연 삭제 (lazy)   : 읽을 때 만료됐으면 그 자리에서 지우고 "없음" 으로 답한다 → 만료된 값은 절대 안 나간다
 *    2) 주기 삭제 (active) : 100ms 마다 TTL 있는 키 20개를 무작위로 뽑아 만료된 것을 지운다.
 *                            25% 넘게 만료돼 있으면 한 번 더 (아무도 안 읽는 키가 메모리를 차지하지 않게)
 *
 *  영속성 (AOF: Append Only File)
 *    쓰기 명령이 성공할 때마다 "결과를 다시 만들 수 있는 명령" 을 한 줄(JSON 배열)로 기록한다.
 *    TTL 은 "몇 초 뒤" 가 아니라 "언제" (절대 시각, PXAT) 로 기록해서, 서버가 꺼져 있던 동안 지난 시간도 반영된다.
 *    INCR 같은 명령도 결과 값을 SET 으로 기록 → 다시 실행해도 같은 결과 (멱등)
 *
 * 브라우저와 Node 양쪽에서 쓰기 위해 Node 모듈을 import 하지 않는다. (파일 저장은 persistence.js)
 */
import { HashTable } from './hashtable.js';

export class RedisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisError';
  }
}

const err = (m) => new RedisError(`ERR ${m}`);
const INT_RE = /^-?\d+$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** 명령 한 줄을 인자 배열로: SET "hello world" 'a b' → ['SET', 'hello world', 'a b'] */
export function parseCommandLine(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && i + 1 < line.length) {
        const n = line[++i];
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw err('따옴표가 닫히지 않았습니다.');
  if (has) out.push(cur);
  return out;
}

/** Redis 의 glob 패턴(*, ?, [abc], \x) → 정규식 */
export function globToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let body = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body.startsWith('^')) body = '\\' + body;
        re += `[${body.replace(/^!/, '^')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) re += '\\' + pattern[++i];
    else re += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return new RegExp(re + '$', 's');
}

/** 명령 이름 → { min: 최소 인자 수(이름 제외), write: 쓰기 명령인지 } */
export const COMMANDS = {
  PING: { min: 0 }, ECHO: { min: 1 },
  SET: { min: 2, write: true }, GET: { min: 1 }, GETDEL: { min: 1, write: true },
  MSET: { min: 2, write: true }, MGET: { min: 1 },
  DEL: { min: 1, write: true }, EXISTS: { min: 1 },
  EXPIRE: { min: 2, write: true }, PEXPIRE: { min: 2, write: true }, PEXPIREAT: { min: 2, write: true },
  TTL: { min: 1 }, PTTL: { min: 1 }, PERSIST: { min: 1, write: true },
  INCR: { min: 1, write: true }, DECR: { min: 1, write: true }, INCRBY: { min: 2, write: true }, DECRBY: { min: 2, write: true },
  KEYS: { min: 1 }, DBSIZE: { min: 0 }, FLUSHALL: { min: 0, write: true },
  TAG: { min: 2, write: true }, INVALIDATE: { min: 1, write: true }, DELPATTERN: { min: 1, write: true },
  INFO: { min: 0 },
};

export class MiniRedis {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]        현재 시각(ms). 테스트에서 가짜 시계를 넣는다
   * @param {(args: string[]) => void} [opts.onWrite]  쓰기 성공 후 AOF 기록용 콜백
   * @param {() => number} [opts.random]
   * @param {number} [opts.sample]  주기 삭제 때 한 번에 뽑는 키 수
   */
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onWrite = opts.onWrite ?? null;
    this.random = opts.random ?? Math.random;
    this.sample = opts.sample ?? 20;
    this.data = new HashTable({ onEvent: opts.onTableEvent });
    this.expires = new HashTable();
    this.tagIdx = new HashTable();
    this.timer = null;
    this.replaying = false;
    this.stats = { commands: 0, hits: 0, misses: 0, expiredLazy: 0, expiredActive: 0, activeCycles: 0 };
  }

  // ================================================================ 명령 실행
  /** 명령 한 줄 문자열 실행 */
  exec(line) {
    return this.command(parseCommandLine(String(line)));
  }

  /**
   * 명령 실행 (동기 → 원자적)
   * @param {string[]} args  ['SET', 'key', 'value', 'EX', '10']
   * @returns {string|number|null|Array}
   */
  command(args) {
    if (!Array.isArray(args) || args.length === 0) throw err('명령이 비어 있습니다.');
    const name = String(args[0]).toUpperCase();
    const spec = COMMANDS[name];
    if (!spec) throw err(`알 수 없는 명령 '${args[0]}'`);
    const a = args.slice(1).map(String);
    if (a.length < spec.min) throw err(`'${name}' 명령의 인자 개수가 부족합니다.`);
    this.stats.commands++;
    return this[`cmd_${name}`](a);
  }

  /** 여러 명령을 끼어들기 없이 한 번에 실행. 실패한 명령은 그 자리에 { error } */
  pipeline(list) {
    return list.map((args) => {
      try {
        return { ok: this.command(args) };
      } catch (e) {
        return { error: e.message };
      }
    });
  }

  // ================================================================ 키 조회 (지연 삭제가 일어나는 곳)
  /** 살아 있는 항목. 만료됐으면 지우고 null */
  #lookup(key) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      this.#remove(key, entry);
      this.stats.expiredLazy++;
      this.#log(['DEL', key]); // 다른 복제본/AOF 도 지우도록 (Redis 도 만료 삭제를 DEL 로 전파)
      return null;
    }
    return entry;
  }

  #remove(key, entry = this.data.get(key)) {
    if (!entry) return false;
    this.data.delete(key);
    if (entry.expireAt !== null) this.expires.delete(key);
    for (const t of entry.tags) {
      const set = this.tagIdx.get(t);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.tagIdx.delete(t);
    }
    return true;
  }

  #write(key, value, expireAt, tags = []) {
    const prev = this.data.get(key);
    if (prev) this.#remove(key, prev);
    const entry = { value, expireAt, tags: [] };
    this.data.set(key, entry);
    if (expireAt !== null) this.expires.set(key, expireAt);
    for (const t of tags) this.#addTag(key, entry, t);
    return entry;
  }

  #addTag(key, entry, tag) {
    if (entry.tags.includes(tag)) return;
    entry.tags.push(tag);
    let set = this.tagIdx.get(tag);
    if (!set) this.tagIdx.set(tag, (set = new HashTable()));
    set.set(key, true);
  }

  #setExpire(key, entry, at) {
    entry.expireAt = at;
    if (at === null) this.expires.delete(key);
    else this.expires.set(key, at);
  }

  #log(args) {
    if (!this.replaying) this.onWrite?.(args);
  }

  /** 항목의 현재 상태를 다시 만드는 명령 (AOF 기록 / 재작성용) */
  #stateRecord(key, entry) {
    const rec = ['SET', key, entry.value];
    if (entry.expireAt !== null) rec.push('PXAT', String(entry.expireAt));
    return rec;
  }

  // ================================================================ 명령들
  cmd_PING(a) { return a.length ? a[0] : 'PONG'; }
  cmd_ECHO(a) { return a[0]; }

  /** SET key value [EX s | PX ms | EXAT s | PXAT ms] [NX | XX] [KEEPTTL] */
  cmd_SET(a) {
    const [key, value] = a;
    let expireAt = null;
    let nx = false, xx = false, keep = false, hasTtl = false;
    for (let i = 2; i < a.length; i++) {
      const opt = a[i].toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if (opt === 'KEEPTTL') keep = true;
      else if (['EX', 'PX', 'EXAT', 'PXAT'].includes(opt)) {
        if (hasTtl) throw err('만료 옵션은 하나만 쓸 수 있습니다.');
        const n = this.#int(a[++i], opt);
        if (n <= 0 && (opt === 'EX' || opt === 'PX')) throw err(`'${opt}' 값은 1 이상이어야 합니다.`);
        expireAt = opt === 'EX' ? this.now() + n * 1000 : opt === 'PX' ? this.now() + n : opt === 'EXAT' ? n * 1000 : n;
        hasTtl = true;
      } else throw err(`SET 옵션 '${a[i]}' 을(를) 알 수 없습니다.`);
    }
    if (nx && xx) throw err('NX 와 XX 는 함께 쓸 수 없습니다.');
    if (keep && hasTtl) throw err('KEEPTTL 과 만료 옵션은 함께 쓸 수 없습니다.');
    const prev = this.#lookup(key);
    if ((nx && prev) || (xx && !prev)) return null;
    if (keep && prev) expireAt = prev.expireAt;
    const entry = this.#write(key, value, expireAt, prev && keep ? prev.tags : []);
    this.#log(this.#stateRecord(key, entry));
    return 'OK';
  }

  cmd_GET([key]) {
    const e = this.#lookup(key);
    if (e) this.stats.hits++;
    else this.stats.misses++;
    return e ? e.value : null;
  }

  cmd_GETDEL([key]) {
    const e = this.#lookup(key);
    if (!e) return null;
    this.#remove(key, e);
    this.#log(['DEL', key]);
    return e.value;
  }

  cmd_MSET(a) {
    if (a.length % 2) throw err('MSET 은 key value 쌍이어야 합니다.');
    for (let i = 0; i < a.length; i += 2) {
      const entry = this.#write(a[i], a[i + 1], null);
      this.#log(this.#stateRecord(a[i], entry));
    }
    return 'OK';
  }

  cmd_MGET(a) { return a.map((k) => this.#lookup(k)?.value ?? null); }

  cmd_DEL(a) {
    let n = 0;
    for (const k of a) {
      const e = this.#lookup(k);
      if (e && this.#remove(k, e)) {
        n++;
        this.#log(['DEL', k]);
      }
    }
    return n;
  }

  cmd_EXISTS(a) { return a.filter((k) => this.#lookup(k)).length; }

  cmd_EXPIRE([key, s]) { return this.#expireAt(key, this.now() + this.#int(s, 'EXPIRE') * 1000); }
  cmd_PEXPIRE([key, ms]) { return this.#expireAt(key, this.now() + this.#int(ms, 'PEXPIRE')); }
  cmd_PEXPIREAT([key, at]) { return this.#expireAt(key, this.#int(at, 'PEXPIREAT')); }

  #expireAt(key, at) {
    const e = this.#lookup(key);
    if (!e) return 0;
    if (at <= this.now()) {
      // 과거 시각으로 만료 = 바로 삭제 (Redis 와 동일)
      this.#remove(key, e);
      this.#log(['DEL', key]);
      return 1;
    }
    this.#setExpire(key, e, at);
    this.#log(['PEXPIREAT', key, String(at)]);
    return 1;
  }

  cmd_PTTL([key]) {
    const e = this.#lookup(key);
    if (!e) return -2; // 키 없음
    if (e.expireAt === null) return -1; // 만료 없음
    return Math.max(0, e.expireAt - this.now());
  }

  cmd_TTL([key]) {
    const ms = this.cmd_PTTL([key]);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  }

  cmd_PERSIST([key]) {
    const e = this.#lookup(key);
    if (!e || e.expireAt === null) return 0;
    this.#setExpire(key, e, null);
    this.#log(['PERSIST', key]);
    return 1;
  }

  cmd_INCR([key]) { return this.#incrBy(key, 1); }
  cmd_DECR([key]) { return this.#incrBy(key, -1); }
  cmd_INCRBY([key, by]) { return this.#incrBy(key, this.#int(by, 'INCRBY')); }
  cmd_DECRBY([key, by]) { return this.#incrBy(key, -this.#int(by, 'DECRBY')); }

  #incrBy(key, by) {
    const e = this.#lookup(key);
    const cur = e ? e.value : '0';
    if (!INT_RE.test(cur)) throw err('값이 정수가 아니어서 더할 수 없습니다.');
    const next = Number(cur) + by;
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_SAFE) throw err('정수 범위를 넘었습니다.');
    // 기존 TTL·태그는 유지 (Redis 와 동일)
    if (e) e.value = String(next);
    const entry = e ?? this.#write(key, String(next), null);
    this.#log(this.#stateRecord(key, entry));
    return next;
  }

  cmd_KEYS([pattern]) {
    const re = globToRegExp(pattern);
    const now = this.now();
    const out = [];
    for (const [k, e] of this.data.entries()) {
      if (e.expireAt !== null && e.expireAt <= now) continue; // 만료된 건 안 보여 줌 (지우는 건 lookup/주기 삭제가)
      if (re.test(k)) out.push(k);
    }
    return out.sort();
  }

  cmd_DBSIZE() { return this.data.size; }

  cmd_FLUSHALL() {
    this.data.clear();
    this.expires.clear();
    this.tagIdx.clear();
    this.#log(['FLUSHALL']);
    return 'OK';
  }

  // ---------------------------------------------------------------- miniRedis 확장: 무효화
  /** TAG key tag [tag ...] → 키에 태그를 붙인다. 붙인 태그 수 */
  cmd_TAG([key, ...tags]) {
    const e = this.#lookup(key);
    if (!e) return 0;
    let n = 0;
    for (const t of tags) {
      if (e.tags.includes(t)) continue;
      this.#addTag(key, e, t);
      n++;
    }
    if (n) this.#log(['TAG', key, ...tags]);
    return n;
  }

  /** INVALIDATE tag [tag ...] → 그 태그가 붙은 키를 모두 삭제. 지운 키 수 */
  cmd_INVALIDATE(tags) {
    const keys = new Set();
    for (const t of tags) {
      const set = this.tagIdx.get(t);
      if (set) for (const k of set.keys()) keys.add(k);
    }
    return this.cmd_DEL([...keys]);
  }

  /** DELPATTERN pattern → 패턴에 맞는 키를 모두 삭제 (예: product:*) */
  cmd_DELPATTERN([pattern]) {
    const re = globToRegExp(pattern);
    const keys = [];
    for (const k of this.data.keys()) if (re.test(k)) keys.push(k);
    return this.cmd_DEL(keys);
  }

  cmd_INFO() {
    const t = this.data.snapshot();
    return {
      keys: this.data.size,
      keysWithTtl: this.expires.size,
      tags: this.tagIdx.size,
      ...this.stats,
      hashTable: {
        buckets: (t.tables[1] ?? t.tables[0]).size,
        loadFactor: Number(t.loadFactor.toFixed(3)),
        rehashing: t.rehashIdx !== -1,
        resizes: t.stats.resizes,
        collisions: t.stats.collisions,
      },
    };
  }

  #int(v, name) {
    if (v === undefined || !INT_RE.test(v)) throw err(`'${name}' 에는 정수가 필요합니다.`);
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw err('정수 범위를 넘었습니다.');
    return n;
  }

  // ================================================================ 주기 삭제 (active expiration)
  /**
   * TTL 있는 키를 무작위로 뽑아 만료된 것을 지운다. 25% 넘게 만료돼 있으면 반복 (최대 16번)
   * @returns {number} 지운 키 수
   */
  activeExpireCycle() {
    this.stats.activeCycles++;
    let removed = 0;
    for (let round = 0; round < 16; round++) {
      const n = Math.min(this.sample, this.expires.size);
      if (n === 0) break;
      let expired = 0;
      const now = this.now();
      for (let i = 0; i < n; i++) {
        const pick = this.expires.randomEntry(this.random);
        if (!pick) break;
        const [key, at] = pick;
        if (at <= now) {
          this.#remove(key);
          this.#log(['DEL', key]);
          this.stats.expiredActive++;
          expired++;
          removed++;
        }
      }
      if (expired / n <= 0.25) break;
    }
    return removed;
  }

  /** 주기 삭제 타이머 시작 (기본 100ms = Redis 의 hz 10) */
  start(intervalMs = 100) {
    this.stop();
    this.timer = setInterval(() => this.activeExpireCycle(), intervalMs);
    this.timer.unref?.(); // Node: 이 타이머 때문에 프로세스가 안 끝나는 일이 없게
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ================================================================ 영속성 (AOF 재생 / 재작성)
  /**
   * AOF 텍스트(한 줄 = JSON 배열)를 처음부터 다시 실행해 상태를 복원한다.
   * 마지막 줄이 중간에 잘려 있으면(쓰다가 서버가 죽음) 그 줄만 버린다.
   * @returns {{ applied: number, truncated: boolean, errors: number }}
   */
  loadAof(text) {
    const lines = String(text).split('\n');
    let applied = 0, errors = 0, truncated = false;
    this.replaying = true;
    try {
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let args;
        try {
          args = JSON.parse(line);
        } catch {
          if (i >= lines.length - 2) truncated = true; // 마지막 줄 = 쓰다 만 줄
          else errors++;
          return;
        }
        try {
          this.command(args);
          applied++;
        } catch {
          errors++;
        }
      });
    } finally {
      this.replaying = false;
    }
    this.stats.commands = 0;
    return { applied, truncated, errors };
  }

  /** 지금 상태만 담은 최소 AOF (재작성/압축). 만료된 키는 뺀다 */
  rewriteAof() {
    const now = this.now();
    const lines = [];
    for (const [k, e] of this.data.entries()) {
      if (e.expireAt !== null && e.expireAt <= now) continue;
      lines.push(JSON.stringify(this.#stateRecord(k, e)));
      if (e.tags.length) lines.push(JSON.stringify(['TAG', k, ...e.tags]));
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  /** 시각화/디버깅용: 살아 있는 키 목록 */
  dump() {
    const now = this.now();
    const out = [];
    for (const [k, e] of this.data.entries()) {
      out.push({ key: k, value: e.value, expireAt: e.expireAt, expired: e.expireAt !== null && e.expireAt <= now, tags: [...e.tags] });
    }
    return out.sort((x, y) => (x.key < y.key ? -1 : 1));
  }
}

/** 응답을 redis-cli 처럼 보여 주기 */
export function formatReply(r) {
  if (r === null || r === undefined) return '(nil)';
  if (typeof r === 'number') return `(integer) ${r}`;
  if (Array.isArray(r)) return r.length ? r.map((x, i) => `${i + 1}) ${x === null ? '(nil)' : JSON.stringify(x)}`).join('\n') : '(empty array)';
  if (typeof r === 'object') return JSON.stringify(r, null, 2);
  if (r === 'OK' || r === 'PONG') return r;
  return JSON.stringify(r);
}
