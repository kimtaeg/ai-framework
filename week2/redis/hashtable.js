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
const EMPTY_VISITS = 10; // 빈 버킷만 계속 나오면 이만큼 보고 멈춤 (한 번의 연산이 너무 길어지지 않게)

/** FNV-1a 32bit 해시 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
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
  /** @param {{ initialSize?: number, hash?: (s: string) => number, onEvent?: (e) => void }} [opts] */
  constructor(opts = {}) {
    const size = Math.max(MIN_SIZE, nextPow2(opts.initialSize ?? MIN_SIZE));
    this.hash = opts.hash ?? fnv1a;
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
    const found = this.#find(key, false);
    if (found) {
      found.value = value;
      return false;
    }
    this.#maybeGrow();
    // 리해시 중이면 새 원소는 새 테이블에만 넣는다 (옛 테이블은 비워지는 중이니까)
    const t = this.tables[1] ?? this.tables[0];
    const i = this.hash(key) & t.mask;
    if (t.buckets[i]) this.stats.collisions++;
    t.buckets[i] = { key, value, next: t.buckets[i] }; // 체인 맨 앞에 붙임 (O(1))
    t.used++;
    return true;
  }

  /** @returns {boolean} 지웠으면 true */
  delete(key) {
    this.#rehashStep();
    for (const t of this.tables) {
      if (!t) continue;
      const i = this.hash(key) & t.mask;
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
    // 빈 버킷이 많아도 끝나도록: 임의 위치에서 시작해 차례로 훑는다
    const t = this.tables[1] && this.tables[1].used > this.tables[0].used ? this.tables[1] : this.tables[0].used ? this.tables[0] : this.tables[1];
    const start = Math.floor(rand() * t.size);
    for (let k = 0; k < t.size; k++) {
      const n = t.buckets[(start + k) & t.mask];
      if (n) return [n.key, n.value];
    }
    return null;
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
  #find(key, step = true) {
    if (step) this.#rehashStep();
    for (const t of this.tables) {
      if (!t || t.used === 0) continue;
      for (let n = t.buckets[this.hash(key) & t.mask]; n; n = n.next) if (n.key === key) return n;
    }
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

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
