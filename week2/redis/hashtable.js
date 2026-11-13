/**
 * 직접 만든 해시 테이블 (Map / Object 를 저장소로 쓰지 않는다)
 * ------------------------------------------------------------------
 *  - 해시 함수 : FNV-1a 32bit  (문자열 → 0 ~ 2^32-1 정수)
 *  - 충돌 처리 : 체이닝 (버킷 = 노드 연결 리스트)
 *  - 크기      : 버킷 수는 항상 2의 거듭제곱 → index = hash & (size - 1)  (나머지 연산보다 빠름)
 *  - 확장      : 부하율(= 원소 수 / 버킷 수) > 1 이면 2배로
 *  - 축소      : 부하율 < 0.1 이면 절반으로 (최소 MIN_SIZE)
 *  - 점진적 리해시 (Redis 의 dict 와 같은 방식)
 *      크기를 바꿀 때 한 번에 전부 옮기면 원소가 100만 개일 때 그 순간 서버가 멈춘다.
 *      그래서 테이블을 두 개(old, new) 두고, 연산이 일어날 때마다 버킷을 몇 개씩만 옮긴다.
 *      옮기는 동안 조회는 두 테이블을 모두 보고, 새 원소는 새 테이블에만 넣는다.
 *
 * 브라우저와 Node 양쪽에서 쓰기 위해 아무것도 import 하지 않는다.
 */

export const MIN_SIZE = 4;
const GROW_AT = 1;      // 부하율이 이보다 크면 확장
const SHRINK_AT = 0.1;  // 부하율이 이보다 작으면 축소
const STEP = 1;         // 연산 한 번에 옮길 버킷 수
const RANDOM_TRIES = 16; // randomEntry 가 무작위 버킷을 찔러 보는 횟수
const EMPTY_VISITS = 10; // 빈 버킷만 계속 나오면 이만큼 보고 멈춤 (한 번의 연산이 너무 길어지지 않게)

/**
 * FNV-1a 32bit 해시
 * @param {number} [seed] 시작 값에 섞는 시드. 서버마다 무작위로 주면, 같은 버킷에 몰리도록 미리 계산해 둔
 *   키 묶음(해시 플러딩)이 통하지 않는다. FNV 는 암호학적 해시가 아니라서 완전한 방어는 아니다 (Redis 는 SipHash)
 */
export function fnv1a(str, seed = 0) {
  let h = (0x811c9dc5 ^ seed) | 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // 32bit 곱셈 (오버플로는 버림)
  }
  return h >>> 0; // 부호 없는 32bit
}

function makeTable(size) {
  return { buckets: new Array(size).fill(null), size, mask: size - 1, used: 0 };
}

export class HashTable {
  /** @param {{ initialSize?: number, hash?: (s: string) => number, seed?: number, onEvent?: (e) => void }} [opts] */
  constructor(opts = {}) {
    const size = Math.max(MIN_SIZE, nextPow2(opts.initialSize ?? MIN_SIZE));
    const seed = (opts.seed ?? 0) | 0;
    this.hash = opts.hash ?? (seed ? (s) => fnv1a(s, seed) : fnv1a);
    this.onEvent = opts.onEvent ?? null; // 시각화용: 'resize-start', 'move', 'resize-end'
    this.tables = [makeTable(size), null]; // [0] = 지금 테이블, [1] = 리해시 중일 때 새 테이블
    this.rehashIdx = -1; // -1 = 리해시 안 하는 중, 그 외 = 다음에 옮길 tables[0] 의 버킷 번호
    this.resizable = true;
    this.stats = { collisions: 0, resizes: 0, moved: 0 };
  }

  get size() {
    return this.tables[0].used + (this.tables[1]?.used ?? 0);
  }

  get isRehashing() {
    return this.rehashIdx !== -1;
  }

  get loadFactor() {
    const t = this.tables[1] ?? this.tables[0];
    return this.size / t.size;
  }

  // ---------------------------------------------------------------- 기본 연산
  get(key) {
    const node = this.#find(key);
    return node ? node.value : undefined;
  }

  has(key) {
    return this.#find(key) !== null;
  }

  /** @returns {boolean} 새로 추가됐으면 true, 기존 값을 바꿨으면 false */
  set(key, value) {
    if (typeof key !== 'string') throw new TypeError('키는 문자열이어야 합니다.');
    this.#rehashStep();
    const h = this.hash(key); // 해시는 한 번만 계산해서 찾기와 넣기에 함께 쓴다 (키 길이만큼 드는 계산)
    const found = this.#find(key, false, h);
    if (found) {
      found.value = value;
      return false;
    }
    this.#maybeGrow();
    // 리해시 중이면 새 원소는 새 테이블에만 넣는다 (옛 테이블은 비워지는 중이니까)
    const t = this.tables[1] ?? this.tables[0];
    const i = h & t.mask;
    if (t.buckets[i]) this.stats.collisions++;
    t.buckets[i] = { key, value, next: t.buckets[i] }; // 체인 맨 앞에 붙임 (O(1))
    t.used++;
    return true;
  }

  /** @returns {boolean} 지웠으면 true */
  delete(key) {
    this.#rehashStep();
    const h = this.hash(key);
    for (const t of this.tables) {
      if (!t) continue;
      const i = h & t.mask;
      let prev = null;
      for (let n = t.buckets[i]; n; prev = n, n = n.next) {
        if (n.key !== key) continue;
        if (prev) prev.next = n.next;
        else t.buckets[i] = n.next;
        t.used--;
        this.#maybeShrink();
        return true;
      }
    }
    return false;
  }

  clear() {
    this.tables = [makeTable(MIN_SIZE), null];
    this.rehashIdx = -1;
  }

  /** 모든 [key, value] (순서는 버킷 순서) */
  *entries() {
    for (const t of this.tables) {
      if (!t) continue;
      for (const head of t.buckets) for (let n = head; n; n = n.next) yield [n.key, n.value];
    }
  }

  *keys() {
    for (const [k] of this.entries()) yield k;
  }

  /** 아무 원소 하나 (만료 키 표본 추출용). 없으면 null */
  randomEntry(rand = Math.random) {
    if (this.size === 0) return null;
    // 리해시 중이면 두 테이블 중 하나를 원소 수에 비례해 고른다 (한쪽 테이블의 키만 뽑히지 않게)
    const [a, b] = this.tables;
    const t = b && rand() * (a.used + b.used) >= a.used ? b : a.used ? a : b;
    // 먼저 무작위 버킷을 몇 번 찔러 본다 → 비어 있지 않은 버킷이 모두 같은 확률로 뽑힌다.
    // (한 곳에서 시작해 옆으로 훑기만 하면, 빈 버킷이 길게 이어진 바로 뒤의 버킷만 자주 뽑힌다)
    // 그래도 못 찾으면(거의 빈 테이블) 임의 위치에서 차례로 훑어 반드시 끝낸다.
    let start = -1;
    for (let tries = 0; tries < RANDOM_TRIES; tries++) {
      const i = Math.floor(rand() * t.size) & t.mask;
      if (t.buckets[i]) { start = i; break; }
    }
    if (start === -1) start = Math.floor(rand() * t.size) & t.mask;
    for (let k = 0; k < t.size; k++) {
      const head = t.buckets[(start + k) & t.mask];
      if (!head) continue;
      // 체인 안에서도 무작위로 고른다. 맨 앞 노드만 돌려주면 그 뒤에 매달린 키는 영영 뽑히지 않는다
      // (맨 앞 키의 TTL 이 길면 뒤쪽의 만료된 키가 주기 삭제에서 계속 빠진다)
      let len = 0;
      for (let n = head; n; n = n.next) len++;
      let n = head;
      for (let skip = Math.floor(rand() * len); skip > 0 && n.next; skip--) n = n.next;
      return [n.key, n.value];
    }
    return null;
  }

  /**
   * 커서 방식 순회 (Redis 의 SCAN 과 같은 방법) — 버킷 하나(리해시 중이면 짝이 되는 버킷들)만 보고 다음 커서를 돌려준다.
   *   전체를 한 번에 훑는 entries() 와 달리, 조금씩 나눠 보므로 원소가 많아도 한 번의 호출이 짧다.
   *   커서는 "비트를 뒤집은 순서" 로 증가한다 → 순회 도중에 테이블이 커지거나 줄어도,
   *   처음부터 끝까지 있던 원소는 빠뜨리지 않는다 (같은 원소가 두 번 나올 수는 있다).
   * @param {number} cursor 0 에서 시작
   * @param {(key: string, value: any) => void} fn  이 안에서 테이블을 바꾸면 안 된다 (키를 모아 두었다가 나중에 처리)
   * @returns {number} 다음 커서. 0 이면 한 바퀴 끝
   */
  scan(cursor, fn) {
    if (this.size === 0) return 0;
    let v = cursor >>> 0;
    const emit = (t, i) => { for (let n = t.buckets[i]; n; n = n.next) fn(n.key, n.value); };
    const advance = (mask) => {
      v = (v | ~mask) >>> 0; // 마스크 밖의 비트를 1 로 채우고
      v = reverseBits(v);    // 뒤집어서
      v = (v + 1) >>> 0;     // 1 을 더하면 = 마스크의 가장 높은 비트부터 올림이 일어난다
      v = reverseBits(v);
    };
    if (!this.isRehashing) {
      const t = this.tables[0];
      emit(t, v & t.mask);
      advance(t.mask);
    } else {
      let [small, big] = this.tables;
      if (small.size > big.size) [small, big] = [big, small];
      emit(small, v & small.mask);
      // 작은 테이블의 버킷 하나는 큰 테이블의 여러 버킷으로 나뉜다 → 그 버킷들을 모두 본다
      do {
        emit(big, v & big.mask);
        advance(big.mask);
      } while (v & (small.mask ^ big.mask));
    }
    return v;
  }

  /** 리해시를 끝까지 진행 (테스트 / 시각화용) */
  finishRehash() {
    while (this.isRehashing) this.#rehashStep(Infinity);
  }

  /** 시각화용 스냅샷: 테이블마다 버킷별 키 목록 */
  snapshot() {
    return {
      rehashIdx: this.rehashIdx,
      size: this.size,
      loadFactor: this.loadFactor,
      stats: { ...this.stats },
      tables: this.tables.map((t) => t && {
        size: t.size,
        used: t.used,
        buckets: t.buckets.map((head) => {
          const keys = [];
          for (let n = head; n; n = n.next) keys.push(n.key);
          return keys;
        }),
      }),
    };
  }

  /** 버킷 번호 (시각화용) */
  indexOf(key, table = 0) {
    const t = this.tables[table];
    return t ? this.hash(key) & t.mask : -1;
  }

  // ---------------------------------------------------------------- 내부
  #find(key, step = true, h = this.hash(key)) {
    if (step) this.#rehashStep();
    // 리해시 중에는 두 테이블을 모두 보지만 해시는 한 번만 계산한다 (버킷 번호만 테이블마다 다르다)
    const [a, b] = this.tables;
    if (a.used) for (let n = a.buckets[h & a.mask]; n; n = n.next) if (n.key === key) return n;
    if (b && b.used) for (let n = b.buckets[h & b.mask]; n; n = n.next) if (n.key === key) return n;
    return null;
  }

  #maybeGrow() {
    if (this.isRehashing || !this.resizable) return;
    const t = this.tables[0];
    if ((t.used + 1) / t.size > GROW_AT) this.#startResize(t.size * 2);
  }

  #maybeShrink() {
    if (this.isRehashing || !this.resizable) return;
    const t = this.tables[0];
    if (t.size > MIN_SIZE && t.used / t.size < SHRINK_AT) this.#startResize(Math.max(MIN_SIZE, nextPow2(Math.max(1, t.used) * 2)));
  }

  #startResize(newSize) {
    this.tables[1] = makeTable(newSize);
    this.rehashIdx = 0;
    this.stats.resizes++;
    this.onEvent?.({ type: 'resize-start', from: this.tables[0].size, to: newSize });
  }

  /** 버킷 STEP 개(빈 버킷은 EMPTY_VISITS 개까지)를 옛 테이블 → 새 테이블로 옮긴다 */
  #rehashStep(steps = STEP) {
    if (!this.isRehashing) return;
    const [from, to] = this.tables;
    let emptyLeft = steps === Infinity ? Infinity : EMPTY_VISITS;
    while (steps > 0 && from.used > 0) {
      while (from.buckets[this.rehashIdx] === null) {
        this.rehashIdx++;
        if (--emptyLeft <= 0) return;
      }
      let n = from.buckets[this.rehashIdx];
      while (n) {
        const next = n.next;
        const i = this.hash(n.key) & to.mask;
        n.next = to.buckets[i];
        to.buckets[i] = n;
        from.used--;
        to.used++;
        this.stats.moved++;
        n = next;
      }
      from.buckets[this.rehashIdx] = null;
      this.onEvent?.({ type: 'move', bucket: this.rehashIdx });
      this.rehashIdx++;
      steps--;
    }
    if (from.used === 0) {
      // 다 옮겼으면 새 테이블이 지금 테이블이 된다
      this.tables = [to, null];
      this.rehashIdx = -1;
      this.onEvent?.({ type: 'resize-end', size: to.size });
    }
  }
}

/** 32bit 정수의 비트 순서를 뒤집는다 */
function reverseBits(v) {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  return ((v >>> 16) | (v << 16)) >>> 0;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
