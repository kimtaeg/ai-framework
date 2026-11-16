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

/**
 * Redis 의 glob 패턴(*, ?, [abc], [a-z], [!abc], \x) 매처 → { test(문자열) }
 *
 *  정규식으로 바꿔 쓰지 않고 직접 맞춰 본다. 이유 두 가지:
 *   1) 자바스크립트 정규식은 되돌아가며 찾는 방식이라 a*a*a*...b 같은 패턴에서 시도 횟수가 폭발한다.
 *      명령을 한 스레드에서 처리하므로, 그런 KEYS 한 번이 서버 전체를 몇 초씩 멈춘다 (ReDoS).
 *      여기서는 "마지막 * 로만 되돌아가는" 방식이라 최악에도 (패턴 길이 × 키 길이) 만큼만 본다.
 *   2) [z-a] 처럼 정규식으로는 문법 오류인 패턴이 예외(→ HTTP 500)를 내지 않는다. Redis 처럼 양 끝을 바꿔 [a-z] 로 본다.
 */
export function globMatcher(pattern) {
  // 패턴을 조각으로: 문자 하나(문자열) · ANY(?) · STAR(*) · 문자 묶음({ neg, ranges })
  const parts = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (parts[parts.length - 1] !== STAR) parts.push(STAR); // ** 는 * 하나와 같다
    } else if (c === '?') parts.push(ANY);
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) parts.push('['); // 닫히지 않은 [ 는 글자 그대로
      else {
        let body = pattern.slice(i + 1, end);
        const neg = body.startsWith('!');
        if (neg) body = body.slice(1);
        const ranges = [];
        for (let k = 0; k < body.length; k++) {
          let lo = body.charCodeAt(k), hi = lo;
          if (body[k + 1] === '-' && k + 2 < body.length) {
            hi = body.charCodeAt(k + 2);
            k += 2;
          }
          ranges.push(lo <= hi ? [lo, hi] : [hi, lo]);
        }
        parts.push({ neg, ranges });
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) parts.push(pattern[++i]);
    else parts.push(c);
  }
  const one = (part, ch) => {
    if (part === ANY) return true;
    if (typeof part === 'string') return part === ch;
    const code = ch.charCodeAt(0);
    let hit = false;
    for (const [lo, hi] of part.ranges) if (code >= lo && code <= hi) { hit = true; break; }
    return hit !== part.neg;
  };
  return {
    test(str) {
      let s = 0, p = 0;
      let starP = -1, starS = 0; // 마지막으로 만난 * 의 위치와, 그 * 가 지금까지 삼킨 곳
      while (s < str.length) {
        if (p < parts.length && parts[p] === STAR) {
          starP = p++;
          starS = s;
        } else if (p < parts.length && one(parts[p], str[s])) {
          p++;
          s++;
        } else if (starP !== -1) {
          p = starP + 1; // 안 맞으면 마지막 * 가 한 글자 더 삼키게 하고 다시
          s = ++starS;
        } else return false;
      }
      while (p < parts.length && parts[p] === STAR) p++;
      return p === parts.length;
    },
  };
}
const STAR = Symbol('*');
const ANY = Symbol('?');

/** 예전 이름 (정규식을 돌려주던 때의 이름). 쓰는 쪽은 .test() 만 부르므로 그대로 동작한다 */
export const globToRegExp = globMatcher;

/** 명령 이름 → { min: 최소 인자 수(이름 제외), write: 쓰기 명령인지 } */
export const COMMANDS = {
  PING: { min: 0 }, ECHO: { min: 1 },
  SET: { min: 2, write: true }, GET: { min: 1 }, GETDEL: { min: 1, write: true }, DELIF: { min: 2, write: true }, GETTTL: { min: 1 },
  MSET: { min: 2, write: true }, MGET: { min: 1 },
  DEL: { min: 1, write: true }, EXISTS: { min: 1 },
  EXPIRE: { min: 2, write: true }, PEXPIRE: { min: 2, write: true }, PEXPIREAT: { min: 2, write: true },
  TTL: { min: 1 }, PTTL: { min: 1 }, PERSIST: { min: 1, write: true },
  INCR: { min: 1, write: true }, DECR: { min: 1, write: true }, INCRBY: { min: 2, write: true }, DECRBY: { min: 2, write: true },
  KEYS: { min: 1 }, SCAN: { min: 1 }, DBSIZE: { min: 0 }, FLUSHALL: { min: 0, write: true },
  TAG: { min: 2, write: true }, INVALIDATE: { min: 1, write: true }, DELPATTERN: { min: 1, write: true },
  INFO: { min: 0 },
};

/** 명령 이름 → { min, write, fn: 메서드 이름 }. 명령마다 'cmd_' + 이름 문자열을 새로 만들지 않도록 미리 만들어 둔다 */
const SPECS = new Map(Object.entries(COMMANDS).map(([name, spec]) => [name, { ...spec, name, fn: 'cmd_' + name }]));

/** 항목 하나가 차지하는 메모리의 어림값(바이트): 문자열은 글자당 2바이트 + 노드·객체 몫 */
const ENTRY_OVERHEAD = 64;
const entryCost = (key, value) => 2 * (key.length + value.length) + ENTRY_OVERHEAD;
const EVICT_SAMPLE = 5; // 축출할 때 한 번에 뽑아 비교하는 키 수 (Redis 의 maxmemory-samples 기본값)

const EMPTY_ARGS = [];
const EMPTY_TAGS = Object.freeze([]);

/** 32bit FNV-1a 를 짧게 쓰거나, globToRegExp 용 헬퍼 아래 */
export class MiniRedis {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]        현재 시각(ms). 테스트에서 가짜 시계를 넣는다
   * @param {(args: string[]) => void} [opts.onWrite]  쓰기 성공 후 AOF 기록용 콜백
   * @param {() => number} [opts.random]
   * @param {number} [opts.sample]  주기 삭제 때 한 번에 뽑는 키 수
   * @param {number} [opts.hashSeed]  해시 시드 (서버는 무작위 값을 준다. 안 주면 0 = 항상 같은 버킷 → 시각화/테스트용)
   * @param {number} [opts.maxMemory]  메모리 상한(바이트, 어림값). 넘으면 가장 오래 안 쓴 키부터 지운다 (0 = 제한 없음, 기본)
   * @param {'allkeys-lru'|'volatile-lru'} [opts.evictionPolicy]  축출 대상 정책 (allkeys-lru = 전체, volatile-lru = TTL 있는 키만)
   */
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
    this.onWrite = opts.onWrite ?? null;
    this.random = opts.random ?? Math.random;
    this.sample = opts.sample ?? 20;
    this.hashSeed = (opts.hashSeed ?? 0) | 0;
    this.data = new HashTable({ onEvent: opts.onTableEvent, seed: this.hashSeed });
    this.expires = new HashTable({ seed: this.hashSeed });
    this.tagIdx = new HashTable({ seed: this.hashSeed });
    // 메모리 상한 (maxmemory + allkeys-lru / volatile-lru): 넘으면 먼저 만료 키를 비운 뒤 표본 중 가장 오래 안 쓴 키를 지운다.
    // 모든 키를 사용 순서대로 줄 세우면(정확한 LRU) 조회마다 줄을 고쳐야 해서 느리다 → Redis 처럼 표본으로 어림한다.
    this.maxMemory = Math.max(0, opts.maxMemory ?? 0);
    const evictionPolicy = opts.evictionPolicy ?? 'allkeys-lru';
    if (evictionPolicy !== 'allkeys-lru' && evictionPolicy !== 'volatile-lru') {
      throw err(`알 수 없는 축출 정책 '${evictionPolicy}'`);
    }
    this.evictionPolicy = evictionPolicy;
    this.usedBytes = 0;
    this.clock = 0; // 사용 순서를 재는 논리 시계 (조회·저장 때마다 1 증가)
    this.evicted = 0;
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
    const cmd = args[0];
    const n = args.length - 1;
    if (cmd === 'GET' && n === 1) {
      this.stats.commands++;
      const x0 = args[1];
      return this.#get(typeof x0 === 'string' ? x0 : String(x0));
    }
    if (cmd === 'SET' && n === 2) {
      this.stats.commands++;
      const k = args[1], v = args[2];
      const result = this.#setSimple(typeof k === 'string' ? k : String(k), typeof v === 'string' ? v : String(v), null);
      if (this.maxMemory && this.usedBytes > this.maxMemory) this.#evict();
      return result;
    }
    if (cmd === 'SET' && n === 4 && args[3] === 'EX') {
      this.stats.commands++;
      const k = args[1], v = args[2], s = args[4];
      const sec = this.#int(typeof s === 'string' ? s : String(s), 'EX');
      if (sec <= 0) throw err("'EX' 값은 1 이상이어야 합니다.");
      const expireAt = this.now() + sec * 1000;
      if (!Number.isSafeInteger(expireAt)) throw err("'EX' 값이 너무 큽니다.");
      const result = this.#setSimple(typeof k === 'string' ? k : String(k), typeof v === 'string' ? v : String(v), expireAt);
      if (this.maxMemory && this.usedBytes > this.maxMemory) this.#evict();
      return result;
    }
    if (cmd === 'INCR' && n === 1) {
      this.stats.commands++;
      const x0 = args[1];
      const result = this.#incrBy(typeof x0 === 'string' ? x0 : String(x0), 1);
      if (this.maxMemory && this.usedBytes > this.maxMemory) this.#evict();
      return result;
    }
    if (cmd === 'GETTTL' && n === 1) {
      this.stats.commands++;
      const x0 = args[1];
      return this.#getttl(typeof x0 === 'string' ? x0 : String(x0));
    }
    // 이미 대문자로 온 이름은 그대로 찾는다 (대부분의 경우). 아니면 대문자로 바꿔 다시 찾는다
    const spec = SPECS.get(args[0]) ?? SPECS.get(String(args[0]).toUpperCase());
    if (!spec) throw err(`알 수 없는 명령 '${args[0]}'`);
    if (n < spec.min) throw err(`'${spec.name}' 명령의 인자 개수가 부족합니다.`);
    let a;
    if (n === 0) a = EMPTY_ARGS;
    else if (n === 1) {
      const x0 = args[1];
      a = [typeof x0 === 'string' ? x0 : String(x0)];
    } else if (n === 2) {
      const x0 = args[1], x1 = args[2];
      a = [typeof x0 === 'string' ? x0 : String(x0), typeof x1 === 'string' ? x1 : String(x1)];
    } else {
      a = new Array(n);
      for (let i = 0; i < n; i++) {
        const x = args[i + 1];
        a[i] = typeof x === 'string' ? x : String(x);
      }
    }
    this.stats.commands++;
    const result = this[spec.fn](a);
    if (spec.write && this.maxMemory && this.usedBytes > this.maxMemory) this.#evict();
    return result;
  }

  /** 메모리 상한을 넘었으면 내려갈 때까지 지운다: 만료 키를 먼저 치운 뒤 표본 중 가장 오래 안 쓴 키부터 (어림 LRU) */
  #evict() {
    if (this.replaying) return; // 복원 중에는 곧 치울 만료 키가 섞여 있다 → 끝난 뒤 한 번에 (loadAof)
    if (this.expires.size > 0) this.activeExpireCycle();
    if (this.usedBytes <= this.maxMemory) return;

    const volatileOnly = this.evictionPolicy === 'volatile-lru';
    let guard = this.data.size; // 한 번에 지우는 수의 상한 (끝없이 돌지 않게)
    while (this.usedBytes > this.maxMemory && this.data.size > 0 && guard-- > 0) {
      if (volatileOnly && this.expires.size === 0) break;
      const now = this.now();
      let expiredVictim = null, victim = null, oldest = Infinity;
      for (let i = 0; i < EVICT_SAMPLE; i++) {
        let key, entry;
        if (volatileOnly) {
          const pick = this.expires.randomEntry(this.random);
          if (!pick) break;
          key = pick[0];
          entry = this.data.get(key);
        } else {
          const pick = this.data.randomEntry(this.random);
          if (!pick) break;
          key = pick[0];
          entry = pick[1];
        }
        if (!entry) continue;
        if (entry.expireAt !== null && entry.expireAt <= now) {
          expiredVictim = key;
          break;
        }
        if (entry.lru < oldest) { oldest = entry.lru; victim = key; }
      }
      if (expiredVictim !== null) {
        this.#remove(expiredVictim);
        if (!this.replaying && this.onWrite) this.onWrite(['DEL', expiredVictim]);
        this.stats.expiredLazy++;
      } else if (victim !== null) {
        this.#remove(victim);
        if (!this.replaying && this.onWrite) this.onWrite(['DEL', victim]);
        this.evicted++;
      } else {
        break;
      }
    }
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
    return this.#lookupHash(key, this.data.computeHash(key));
  }

  #lookupHash(key, h) {
    const entry = this.data.getWithHash(key, h);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      // AOF 를 다시 실행하는 동안에는 시간으로 지우지 않는다: 만료를 걸었다가 해제 · 연장한 키는, 처음 건 시각이
      // 지난 뒤에 다시 켜면 그 줄에서 지워져 뒤의 PERSIST · PEXPIREAT 가 헛돈다. 정말 만료된 키는 loadAof 끝에서 치운다.
      if (this.replaying) return entry;
      this.#removeHash(key, entry, h);
      this.stats.expiredLazy++;
      if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]); // 다른 복제본/AOF 도 지우도록 (Redis 도 만료 삭제를 DEL 로 전파)
      return null;
    }
    entry.lru = ++this.clock; // 방금 쓴 키로 표시 (축출 때 오래 안 쓴 키를 고르는 기준)
    return entry;
  }

  #remove(key, entry = this.data.get(key)) {
    return this.#removeHash(key, entry, this.data.computeHash(key));
  }

  #removeHash(key, entry, h) {
    if (!entry) return false;
    this.data.deleteWithHash(key, h);
    this.usedBytes -= entryCost(key, entry.value);
    if (entry.expireAt !== null) this.expires.deleteWithHash(key, h);
    this.#dropTags(key, entry);
    return true;
  }

  /** 태그 표에서 이 키를 뺀다 */
  #dropTags(key, entry) {
    for (const t of entry.tags) {
      const set = this.tagIdx.get(t);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.tagIdx.delete(t);
    }
  }

  /**
   * 값 쓰기. prev = 지금 들어 있는 항목 (없으면 null) — 부르는 쪽이 이미 찾았으므로 여기서 다시 찾지 않는다.
   * 같은 키를 덮어쓸 때는 노드를 지웠다가 다시 넣지 않고 그 항목의 값만 바꾼다 (해시 계산 · 노드 할당을 줄임)
   */
  #write(key, value, expireAt, tags, prev, h = this.data.computeHash(key)) {
    this.#checkFits(key, value);
    let entry;
    if (prev) {
      if (prev.tags.length) this.#dropTags(key, prev);
      if (prev.expireAt !== null && expireAt === null) this.expires.deleteWithHash(key, h);
      this.usedBytes += 2 * (value.length - prev.value.length);
      prev.value = value;
      prev.expireAt = expireAt;
      prev.tags = EMPTY_TAGS;
      prev.lru = ++this.clock;
      entry = prev;
    } else {
      entry = { value, expireAt, tags: EMPTY_TAGS, lru: ++this.clock };
      this.data.insertNewWithHash(key, entry, h);
      this.usedBytes += entryCost(key, value);
    }
    if (expireAt !== null) this.expires.setWithHash(key, expireAt, h);
    if (tags.length) for (let i = 0; i < tags.length; i++) this.#addTag(key, entry, tags[i]);
    return entry;
  }

  #setSimple(key, value, expireAt) {
    const h = this.data.computeHash(key);
    const prev = this.#lookupHash(key, h);
    const entry = this.#write(key, value, expireAt, EMPTY_TAGS, prev, h);
    if (!this.replaying && this.onWrite) this.#logState(key, entry);
    return 'OK';
  }

  #get(key) {
    const e = this.#lookupHash(key, this.data.computeHash(key));
    if (e) this.stats.hits++;
    else this.stats.misses++;
    return e ? e.value : null;
  }

  #getttl(key) {
    const e = this.#lookupHash(key, this.data.computeHash(key));
    if (!e) {
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return [e.value, e.expireAt === null ? -1 : Math.ceil(Math.max(0, e.expireAt - this.now()) / 1000)];
  }

  /**
   * 값 하나가 메모리 상한보다 크면 넣기 전에 거부한다.
   * 그대로 넣으면 상한을 맞추려고 다른 키를 전부 지운 뒤 방금 넣은 키까지 지우게 된다 (아무것도 안 남는다).
   */
  #checkFits(key, value) {
    if (this.maxMemory && !this.replaying && entryCost(key, value) > this.maxMemory) {
      throw err(`값이 너무 큽니다: 이 키 하나가 메모리 상한(${this.maxMemory}바이트)보다 큽니다.`);
    }
  }

  #addTag(key, entry, tag) {
    if (entry.tags.includes(tag)) return;
    if (entry.tags === EMPTY_TAGS) entry.tags = [tag];
    else entry.tags.push(tag);
    let set = this.tagIdx.get(tag);
    if (!set) this.tagIdx.set(tag, (set = new HashTable({ seed: this.hashSeed })));
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

  /** 항목의 현재 상태(값 · 만료 · 태그)를 AOF 에 기록 */
  #logState(key, entry) {
    if (this.replaying || !this.onWrite) return;
    this.onWrite(this.#stateRecord(key, entry));
    if (entry.tags.length) this.onWrite(['TAG', key, ...entry.tags]);
  }

  // ================================================================ 명령들
  cmd_PING(a) { return a.length ? a[0] : 'PONG'; }
  cmd_ECHO(a) { return a[0]; }

  /** SET key value [EX s | PX ms | EXAT s | PXAT ms] [NX | XX] [KEEPTTL] */
  cmd_SET(a) {
    const key = a[0], value = a[1];
    if (a.length === 2) return this.#setSimple(key, value, null);
    let expireAt = null;
    let nx = false, xx = false, keep = false, hasTtl = false, isAbs = false;
    for (let i = 2; i < a.length; i++) {
      const rawOpt = a[i];
      const opt = rawOpt === 'EX' || rawOpt === 'PX' || rawOpt === 'NX' || rawOpt === 'XX' || rawOpt === 'KEEPTTL' || rawOpt === 'EXAT' || rawOpt === 'PXAT' ? rawOpt : rawOpt.toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if (opt === 'KEEPTTL') keep = true;
      else if (opt === 'EX' || opt === 'PX' || opt === 'EXAT' || opt === 'PXAT') {
        if (hasTtl) throw err('만료 옵션은 하나만 쓸 수 있습니다.');
        const n = this.#int(a[++i], opt);
        if (n <= 0 && (opt === 'EX' || opt === 'PX')) throw err(`'${opt}' 값은 1 이상이어야 합니다.`);
        expireAt = opt === 'EX' ? this.now() + n * 1000 : opt === 'PX' ? this.now() + n : opt === 'EXAT' ? n * 1000 : n;
        isAbs = opt === 'EXAT' || opt === 'PXAT';
        if (!Number.isSafeInteger(expireAt)) throw err(`'${opt}' 값이 너무 큽니다.`);
        hasTtl = true;
      } else throw err(`SET 옵션 '${a[i]}' 을(를) 알 수 없습니다.`);
    }
    if (nx && xx) throw err('NX 와 XX 는 함께 쓸 수 없습니다.');
    if (keep && hasTtl) throw err('KEEPTTL 과 만료 옵션은 함께 쓸 수 없습니다.');
    const h = this.data.computeHash(key);
    const prev = this.#lookupHash(key, h);
    if ((nx && prev) || (xx && !prev)) return null;
    if (isAbs && !this.replaying && expireAt <= this.now()) {
      if (prev) {
        this.#removeHash(key, prev, h);
        if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]);
      }
      return 'OK';
    }
    if (keep && prev) expireAt = prev.expireAt;
    const entry = this.#write(key, value, expireAt, prev && keep ? prev.tags : EMPTY_TAGS, prev, h);
    this.#logState(key, entry);
    return 'OK';
  }

  cmd_GET(a) {
    return this.#get(a[0]);
  }

  /**
   * GETTTL key → [값, 남은 초] (만료 없음은 -1). 키가 없으면 null  (miniRedis 확장)
   *   GET 과 TTL 을 따로 부르면 그 사이에 시각이 넘어가 "값은 있는데 TTL 은 -2(없음)" 같은 어긋난 답이 나올 수 있고,
   *   명령 수 · 적중 통계도 두 번 오른다. 한 번의 조회로 같은 순간의 값과 TTL 을 함께 돌려준다.
   */
  cmd_GETTTL(a) {
    return this.#getttl(a[0]);
  }

  cmd_GETDEL(a) {
    const key = a[0];
    const e = this.#lookup(key);
    if (!e) return null;
    this.#remove(key, e);
    if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]);
    return e.value;
  }

  /**
   * DELIF key value → 지금 값이 value 와 같을 때만 삭제. 지웠으면 1, 아니면 0  (miniRedis 확장)
   *   분산 락을 풀 때 쓴다: 락을 잡을 때 넣은 자기만의 값(토큰)과 같을 때만 지워야,
   *   내 락이 만료된 뒤 다른 서버가 새로 잡은 락을 실수로 지우지 않는다.
   *   "값 확인" 과 "삭제" 가 한 명령이라 그 사이에 다른 명령이 끼어들 수 없다 (실제 Redis 는 Lua 스크립트로 한다)
   */
  cmd_DELIF(a) {
    const key = a[0];
    const e = this.#lookup(key);
    if (!e || e.value !== a[1]) return 0;
    this.#remove(key, e);
    if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]);
    return 1;
  }

  cmd_MSET(a) {
    if (a.length % 2) throw err('MSET 은 key value 쌍이어야 합니다.');
    for (let i = 0; i < a.length; i += 2) this.#checkFits(a[i], a[i + 1]); // 일부만 들어가지 않게 먼저 모두 검사
    for (let i = 0; i < a.length; i += 2) {
      const entry = this.#write(a[i], a[i + 1], null, EMPTY_TAGS, this.data.get(a[i]) ?? null);
      this.#logState(a[i], entry);
    }
    return 'OK';
  }

  cmd_MGET(a) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const e = this.#lookup(a[i]);
      if (e) {
        this.stats.hits++;
        out[i] = e.value;
      } else {
        this.stats.misses++;
        out[i] = null;
      }
    }
    return out;
  }

  cmd_DEL(a) {
    let n = 0;
    const log = !this.replaying && this.onWrite ? this.onWrite : null;
    for (let i = 0; i < a.length; i++) {
      const k = a[i];
      const e = this.#lookup(k);
      if (e && this.#remove(k, e)) {
        n++;
        if (log) log(['DEL', k]);
      }
    }
    return n;
  }

  cmd_EXISTS(a) {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (this.#lookup(a[i])) n++;
    return n;
  }

  cmd_EXPIRE([key, s]) { return this.#expireAt(key, this.now() + this.#int(s, 'EXPIRE') * 1000); }
  cmd_PEXPIRE([key, ms]) { return this.#expireAt(key, this.now() + this.#int(ms, 'PEXPIRE')); }
  cmd_PEXPIREAT([key, at]) { return this.#expireAt(key, this.#int(at, 'PEXPIREAT')); }

  #expireAt(key, at) {
    // 초 → ms 로 곱한 값이 정수 범위를 넘으면 AOF 에 1e+21 같은 꼴로 남아 다시 켤 때 복원되지 않는다
    if (!Number.isSafeInteger(at)) throw err('만료 시각이 너무 큽니다.');
    const e = this.#lookup(key);
    if (!e) return 0;
    if (!this.replaying && at <= this.now()) {
      // 과거 시각으로 만료 = 바로 삭제 (Redis 와 동일)
      this.#remove(key, e);
      if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]);
      return 1;
    }
    this.#setExpire(key, e, at);
    if (!this.replaying && this.onWrite) this.onWrite(['PEXPIREAT', key, String(at)]);
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
    // 결과뿐 아니라 지금 값도 검사한다: 2^53 을 넘는 문자열은 Number 로 바꾸는 순간 이미 반올림돼서,
    // 결과가 범위 안으로 돌아와도 틀린 값이다 (예: "9007199254740993" - 2 → ...990, 정답은 ...991)
    const now = Number(cur);
    if (!Number.isSafeInteger(now)) throw err('정수 범위를 넘었습니다.');
    const next = now + by;
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_SAFE) throw err('정수 범위를 넘었습니다.');
    // 기존 TTL·태그는 유지 (Redis 와 동일)
    const text = String(next);
    let entry;
    if (e) {
      this.usedBytes += 2 * (text.length - e.value.length);
      e.value = text;
      entry = e;
    } else {
      entry = this.#write(key, text, null, EMPTY_TAGS, null);
    }
    this.#logState(key, entry);
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

  /**
   * SCAN cursor [MATCH pattern] [COUNT n] → [다음 커서, 키 배열]
   *   KEYS 는 모든 키를 한 번에 훑어서, 키가 많으면 그동안 다른 요청이 멈춘다.
   *   SCAN 은 조금씩 나눠 본다: 커서 0 으로 시작해서, 돌려받은 커서로 다시 부르기를 커서가 0 이 될 때까지 반복.
   *   순회 중에 키가 추가·삭제돼도 처음부터 끝까지 있던 키는 빠지지 않는다 (같은 키가 두 번 나올 수는 있다).
   */
  cmd_SCAN(a) {
    let cursor = this.#int(a[0], 'SCAN');
    if (cursor < 0 || cursor > 0xffffffff) throw err('커서가 올바르지 않습니다.');
    let re = null, count = 10;
    for (let i = 1; i < a.length; i++) {
      const opt = a[i].toUpperCase();
      if (opt === 'MATCH') {
        if (a[i + 1] === undefined) throw err("'MATCH' 에는 패턴이 필요합니다.");
        re = globToRegExp(a[++i]);
      } else if (opt === 'COUNT') {
        count = this.#int(a[++i], 'COUNT');
        if (count < 1) throw err("'COUNT' 값은 1 이상이어야 합니다.");
      } else throw err(`SCAN 옵션 '${a[i]}' 을(를) 알 수 없습니다.`);
    }
    count = Math.min(count, 10000);
    const now = this.now();
    const out = [];
    const collect = (k, e) => {
      if (e.expireAt !== null && e.expireAt <= now) return; // 만료된 건 안 보여 줌
      if (!re || re.test(k)) out.push(k);
    };
    let visits = count * 10; // 빈 버킷이 이어져도 한 번의 호출이 길어지지 않게
    do cursor = this.data.scan(cursor, collect);
    while (cursor !== 0 && out.length < count && --visits > 0);
    return [String(cursor), out];
  }

  cmd_DBSIZE() { return this.data.size; }

  cmd_FLUSHALL() {
    this.usedBytes = 0;
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
    // snapshot() 은 모든 버킷의 키 목록을 만든다(시각화용, 키 수에 비례). 통계에는 필요 없으니 숫자만 읽는다.
    const d = this.data;
    return {
      keys: this.data.size,
      keysWithTtl: this.expires.size,
      tags: this.tagIdx.size,
      ...this.stats,
      memory: { usedBytes: this.usedBytes, maxMemory: this.maxMemory, evicted: this.evicted },
      hashTable: {
        buckets: (d.tables[1] ?? d.tables[0]).size,
        loadFactor: Number(d.loadFactor.toFixed(3)),
        rehashing: d.isRehashing,
        resizes: d.stats.resizes,
        collisions: d.stats.collisions,
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
          if (!this.replaying && this.onWrite) this.onWrite(['DEL', key]);
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
   * @param {string | Iterable<string>} text  AOF 전체 문자열, 또는 줄을 하나씩 주는 반복자
   *   (큰 파일은 persistence.js 가 조금씩 읽어 줄 단위로 넘긴다 → 파일 전체를 문자열 하나로 올리지 않음)
   * @returns {{ applied: number, truncated: boolean, errors: number }}
   */
  loadAof(text) {
    const lines = typeof text === 'string' ? text.split('\n') : text;
    let applied = 0, errors = 0;
    let badLast = false; // 바로 앞의 (비어 있지 않은) 줄이 JSON 이 아니었는지
    this.replaying = true;
    try {
      for (const line of lines) {
        if (!line.trim()) continue;
        if (badLast) { errors++; badLast = false; } // 뒤에 줄이 더 있으면 쓰다 만 줄이 아니라 깨진 줄
        let args;
        try {
          args = JSON.parse(line);
        } catch {
          badLast = true;
          continue;
        }
        try {
          this.command(args);
          applied++;
        } catch {
          errors++;
        }
      }
    } finally {
      // 복원이 끝난 지금 기준으로 만료된 키를 치운다 (꺼져 있는 동안 만료된 키가 메모리를 차지하지 않게)
      const now = this.now();
      const dead = [];
      for (const [k, at] of this.expires.entries()) if (at <= now) dead.push(k);
      for (const k of dead) this.#remove(k);
      this.replaying = false;
    }
    if (this.maxMemory && this.usedBytes > this.maxMemory) this.#evict();
    const truncated = badLast; // 마지막 줄이 깨져 있으면 = 쓰다 만 줄
    this.stats.commands = 0;
    return { applied, truncated, errors };
  }

  /**
   * 재작성을 조금씩 나눠 하기 위한 한 조각: cursor 부터 버킷 buckets 개 분량의 AOF 줄을 만든다.
   * @returns {{ cursor: number, text: string }} cursor 가 0 이면 끝
   */
  rewriteChunk(cursor, buckets = 512) {
    const now = this.now();
    const lines = [];
    const collect = (k, e) => {
      if (e.expireAt !== null && e.expireAt <= now) return;
      lines.push(JSON.stringify(this.#stateRecord(k, e)));
      if (e.tags.length) lines.push(JSON.stringify(['TAG', k, ...e.tags]));
    };
    do cursor = this.data.scan(cursor, collect);
    while (cursor !== 0 && --buckets > 0);
    return { cursor, text: lines.length ? lines.join('\n') + '\n' : '' };
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
