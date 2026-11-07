/**
 * B+ 트리 (메모리 기반) — id → 레코드 위치(locator) 인덱스
 * ------------------------------------------------------------------
 *  구조
 *    - 내부 노드: keys[i] 는 "오른쪽 자식(children[i+1]) 의 가장 작은 키".  자식 수 = 키 수 + 1
 *    - 리프 노드: 실제 (key, value) 를 정렬해서 들고 있고, next 로 오른쪽 리프와 연결 (범위 검색용)
 *    - 모든 리프는 같은 깊이 → 검색은 항상 높이(h)만큼만 내려간다: O(log n)
 *
 *  차수(order) m: 한 노드에 키를 최대 m-1 개.  넘치면 반으로 쪼개고(split) 가운데 키를 부모로 올린다.
 *    실제 DBMS 는 노드 하나 = 디스크 페이지 하나(예: 16KB)라서 m 이 수백이고, 높이가 3~4 면 수억 건을 찾는다.
 *    여기서는 메모리 기반이라 m 을 64 정도로 쓰고, 시각화에서는 3~5 로 작게 쓴다.
 *
 *  삭제는 이번 과제 범위(INSERT/SELECT)에 없어서 구현하지 않았다.
 */

export class BPlusTree {
  /** @param {number} order 최대 자식 수 (3 이상) */
  constructor(order = 64) {
    if (!Number.isInteger(order) || order < 3) throw new RangeError('B+ 트리 차수는 3 이상의 정수여야 합니다.');
    this.order = order;
    this.maxKeys = order - 1;
    this.root = this.#leaf();
    this.size = 0;
    this.height = 1;
    this.stats = { splits: 0 };
  }

  #leaf() {
    return { leaf: true, keys: [], values: [], next: null };
  }

  /** 키가 들어갈 위치: keys[i] >= key 인 첫 i (이진 탐색) */
  static lowerBound(keys, key) {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 내부 노드에서 내려갈 자식 번호: keys[i] <= key 인 개수 */
  static childIndex(keys, key) {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #findLeaf(key, path = null) {
    let node = this.root;
    while (!node.leaf) {
      const i = BPlusTree.childIndex(node.keys, key);
      path?.push(node);
      node = node.children[i];
    }
    return node;
  }

  /** @returns {*} 없으면 undefined */
  get(key) {
    const leaf = this.#findLeaf(key);
    const i = BPlusTree.lowerBound(leaf.keys, key);
    return leaf.keys[i] === key ? leaf.values[i] : undefined;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  /** 검색 경로 (시각화용): 방문한 노드들과 찾았는지 */
  trace(key) {
    const path = [];
    const leaf = this.#findLeaf(key, path);
    path.push(leaf);
    const i = BPlusTree.lowerBound(leaf.keys, key);
    return { path, found: leaf.keys[i] === key, value: leaf.keys[i] === key ? leaf.values[i] : undefined };
  }

  /**
   * 삽입 (키 중복 시 에러 — id 는 유일해야 하므로)
   */
  insert(key, value) {
    if (typeof key !== 'number' || Number.isNaN(key)) throw new TypeError('B+ 트리 키는 숫자여야 합니다.');
    const path = [];
    const leaf = this.#findLeaf(key, path);
    const i = BPlusTree.lowerBound(leaf.keys, key);
    if (leaf.keys[i] === key) throw new Error(`이미 있는 키입니다: ${key}`);
    leaf.keys.splice(i, 0, key);
    leaf.values.splice(i, 0, value);
    this.size++;
    if (leaf.keys.length > this.maxKeys) this.#splitLeaf(leaf, path);
  }

  #splitLeaf(leaf, path) {
    const mid = Math.ceil(leaf.keys.length / 2);
    const right = { leaf: true, keys: leaf.keys.splice(mid), values: leaf.values.splice(mid), next: leaf.next };
    leaf.next = right;
    this.stats.splits++;
    // 리프 분할: 오른쪽의 첫 키를 "복사" 해서 부모로 올린다 (리프에도 그대로 남음 → B+ 트리의 특징)
    this.#insertIntoParent(leaf, right.keys[0], right, path);
  }

  #insertIntoParent(left, key, right, path) {
    if (path.length === 0) {
      this.root = { leaf: false, keys: [key], children: [left, right] };
      this.height++;
      return;
    }
    const parent = path.pop();
    const i = parent.children.indexOf(left);
    parent.keys.splice(i, 0, key);
    parent.children.splice(i + 1, 0, right);
    if (parent.keys.length > this.maxKeys) this.#splitInternal(parent, path);
  }

  #splitInternal(node, path) {
    const mid = Math.floor(node.keys.length / 2);
    const upKey = node.keys[mid];
    // 내부 분할: 가운데 키는 "이동" 해서 부모로 (양쪽 어디에도 남지 않음)
    const right = { leaf: false, keys: node.keys.splice(mid + 1), children: node.children.splice(mid + 1) };
    node.keys.length = mid;
    this.stats.splits++;
    this.#insertIntoParent(node, upKey, right, path);
  }

  /** lo <= key <= hi 인 [key, value] 를 순서대로 (리프 연결 리스트를 따라감) */
  *range(lo = -Infinity, hi = Infinity) {
    let leaf = this.#findLeaf(lo);
    let i = BPlusTree.lowerBound(leaf.keys, lo);
    while (leaf) {
      for (; i < leaf.keys.length; i++) {
        if (leaf.keys[i] > hi) return;
        yield [leaf.keys[i], leaf.values[i]];
      }
      leaf = leaf.next;
      i = 0;
    }
  }

  min() {
    let n = this.root;
    while (!n.leaf) n = n.children[0];
    return n.keys[0];
  }

  max() {
    let n = this.root;
    while (!n.leaf) n = n.children[n.children.length - 1];
    return n.keys[n.keys.length - 1];
  }

  /** 구조가 올바른지 검사 (테스트용). 문제가 있으면 에러 */
  check() {
    let leafDepth = -1;
    let count = 0;
    const walk = (node, depth, lo, hi) => {
      const minKeys = node === this.root ? (node.leaf ? 0 : 1) : Math.ceil(this.order / 2) - 1;
      if (node.keys.length > this.maxKeys) throw new Error('키가 너무 많은 노드');
      if (node.keys.length < minKeys) throw new Error(`키가 너무 적은 노드 (${node.keys.length} < ${minKeys})`);
      for (let i = 1; i < node.keys.length; i++) if (!(node.keys[i - 1] < node.keys[i])) throw new Error('정렬되지 않은 노드');
      for (const k of node.keys) if (k < lo || k >= hi) throw new Error(`범위를 벗어난 키 ${k}`);
      if (node.leaf) {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) throw new Error('리프 깊이가 다름');
        count += node.keys.length;
        return;
      }
      if (node.children.length !== node.keys.length + 1) throw new Error('자식 수 ≠ 키 수 + 1');
      node.children.forEach((c, i) => walk(c, depth + 1, i === 0 ? lo : node.keys[i - 1], i === node.keys.length ? hi : node.keys[i]));
    };
    walk(this.root, 1, -Infinity, Infinity);
    if (count !== this.size) throw new Error('크기 불일치');
    if (leafDepth !== this.height) throw new Error('높이 불일치');
    let prev = -Infinity, n = 0;
    for (const [k] of this.range()) {
      if (!(k > prev)) throw new Error('리프 연결 순서 오류');
      prev = k;
      n++;
    }
    if (n !== this.size) throw new Error('리프 연결 누락');
    return true;
  }

  /** 시각화용: 층별 노드의 키 목록 */
  levels() {
    const out = [];
    let level = [this.root];
    while (level.length) {
      out.push(level.map((n) => ({ keys: [...n.keys], leaf: n.leaf })));
      level = level.flatMap((n) => (n.leaf ? [] : n.children));
    }
    return out;
  }
}
