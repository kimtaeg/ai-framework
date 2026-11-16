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
 *  삭제는 이번 과제 범위(INSERT/SELECT)에 없어서 일반 삭제는 구현하지 않았다.
 *  다만 "가장 큰 키 하나 지우기"(removeMax)는 있다: 실패한 요청이 방금 넣은 레코드를 되돌릴 때 쓴다.
 *  (id 는 넣을 때마다 커지므로, 되돌릴 레코드는 항상 트리의 맨 오른쪽 끝에 있다)
 */

export class BPlusTree {
  /** @param {number} order 최대 자식 수 (3 이상) */
  constructor(order = 64) {
    if (!Number.isInteger(order) || order < 3) throw new RangeError('B+ 트리 차수는 3 이상의 정수여야 합니다.');
    this.order = order;
    this.maxKeys = order - 1;
    this.root = this.#leaf();
    this.last = this.root; // 맨 오른쪽 리프 (가장 큰 키가 있는 곳)
    this._cacheLeaf = null; // 최근 접근 리프 1-슬롯 캐시
    this._idxPath = null;
    this.size = 0;
    this.height = 1;
    this.stats = { splits: 0 };
  }

  /**
   * 오름차순 정렬된 키/값 배열로 B+ 트리를 아래에서 위로 한 번에 만든다 (분할 0회, 리프 채움률 ~100%).
   * @param {number[]} keys  엄격한 오름차순 키 배열
   * @param {any[]} values   같은 길이의 값 배열
   * @param {number} [order=64]
   */
  static buildFromSorted(keys, values, order = 64) {
    const tree = new BPlusTree(order);
    const n = keys.length;
    if (n === 0) return tree;
    const maxKeys = tree.maxKeys;
    const minKeys = Math.ceil(order / 2) - 1;
    if (n <= maxKeys) {
      tree.root.keys = keys.slice(0, n);
      tree.root.values = values.slice(0, n);
      tree.size = n;
      tree._cacheLeaf = tree.root;
      return tree;
    }

    // 리프 크기 배분 (마지막 리프가 minKeys 미만이면 뒤의 두 리프를 반씩 나눈다)
    const leafStarts = [];
    const leafEnds = [];
    for (let s = 0; s < n; s += maxKeys) {
      leafStarts.push(s);
      leafEnds.push(Math.min(n, s + maxKeys));
    }
    const lc = leafStarts.length;
    const lastLen = leafEnds[lc - 1] - leafStarts[lc - 1];
    if (lastLen < minKeys && lc >= 2) {
      const startPrev = leafStarts[lc - 2];
      const total = n - startPrev;
      const leftLen = Math.floor(total / 2);
      leafEnds[lc - 2] = startPrev + leftLen;
      leafStarts[lc - 1] = startPrev + leftLen;
    }

    const leaves = new Array(lc);
    const levelMinKeys = new Array(lc);
    for (let i = 0; i < lc; i++) {
      const leaf = { leaf: true, keys: keys.slice(leafStarts[i], leafEnds[i]), values: values.slice(leafStarts[i], leafEnds[i]), next: null };
      if (i > 0) leaves[i - 1].next = leaf;
      leaves[i] = leaf;
      levelMinKeys[i] = leaf.keys[0];
    }
    tree.last = leaves[lc - 1];
    tree._cacheLeaf = tree.last;
    tree.size = n;

    // 내부 노드를 한 층씩 위로 쌓는다
    let level = leaves;
    let minKeysPerNode = levelMinKeys;
    const minChildren = minKeys + 1;
    while (level.length > 1) {
      const len = level.length;
      const pStarts = [];
      const pEnds = [];
      for (let s = 0; s < len; s += order) {
        pStarts.push(s);
        pEnds.push(Math.min(len, s + order));
      }
      const pc = pStarts.length;
      const lastChildren = pEnds[pc - 1] - pStarts[pc - 1];
      if (lastChildren < minChildren && pc >= 2) {
        const startPrev = pStarts[pc - 2];
        const total = len - startPrev;
        const leftChildren = Math.floor(total / 2);
        pEnds[pc - 2] = startPrev + leftChildren;
        pStarts[pc - 1] = startPrev + leftChildren;
      }

      const parents = new Array(pc);
      const nextMinKeys = new Array(pc);
      for (let i = 0; i < pc; i++) {
        const s = pStarts[i];
        const e = pEnds[i];
        const sepLen = e - s - 1;
        const pKeys = new Array(sepLen);
        for (let j = 0; j < sepLen; j++) pKeys[j] = minKeysPerNode[s + 1 + j];
        parents[i] = { leaf: false, keys: pKeys, children: level.slice(s, e) };
        nextMinKeys[i] = minKeysPerNode[s];
      }
      level = parents;
      minKeysPerNode = nextMinKeys;
      tree.height++;
    }
    tree.root = level[0];
    return tree;
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

  #findLeaf(key, path = null, idxPath = null) {
    let node = this.root;
    while (!node.leaf) {
      const i = BPlusTree.childIndex(node.keys, key);
      if (path !== null) {
        path.push(node);
        idxPath?.push(i);
      }
      node = node.children[i];
    }
    return node;
  }

  /** @returns {*} 없으면 undefined */
  get(key) {
    const c = this._cacheLeaf;
    if (c !== null && c.keys.length > 0 && key >= c.keys[0] && (key <= c.keys[c.keys.length - 1] || c.next === null)) {
      const i = BPlusTree.lowerBound(c.keys, key);
      return c.keys[i] === key ? c.values[i] : undefined;
    }
    const leaf = this.#findLeaf(key);
    this._cacheLeaf = leaf;
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
    // 빠른 길: 지금까지의 어떤 키보다 크고(자동 증가 id 가 항상 그렇다) 맨 오른쪽 리프에 자리가 있으면
    // 루트부터 내려가지 않고 그 리프 끝에 바로 붙인다. 쪼개야 할 때만 아래의 일반 경로로 간다.
    const last = this.last;
    const n = last.keys.length;
    if (n > 0 && key > last.keys[n - 1]) {
      if (n < this.maxKeys) {
        last.keys.push(key);
        last.values.push(value);
        this.size++;
        this._cacheLeaf = last;
        return;
      }
      // 맨 오른쪽 리프가 꽉 찬 경우에도 이진 탐색 없이 가장 오른쪽 경로만 따라 내려가 바로 분할
      const path = [];
      const idxPath = [];
      let node = this.root;
      while (!node.leaf) {
        const ci = node.children.length - 1;
        path.push(node);
        idxPath.push(ci);
        node = node.children[ci];
      }
      last.keys.push(key);
      last.values.push(value);
      this.size++;
      this._idxPath = idxPath;
      this.#splitLeaf(last, path);
      return;
    }
    const path = [];
    const idxPath = [];
    const leaf = this.#findLeaf(key, path, idxPath);
    this._cacheLeaf = leaf;
    const i = BPlusTree.lowerBound(leaf.keys, key);
    if (leaf.keys[i] === key) throw new Error(`이미 있는 키입니다: ${key}`);
    leaf.keys.splice(i, 0, key);
    leaf.values.splice(i, 0, value);
    this.size++;
    this._idxPath = idxPath;
    if (leaf.keys.length > this.maxKeys) this.#splitLeaf(leaf, path);
  }

  #splitLeaf(leaf, path) {
    const mid = Math.ceil(leaf.keys.length / 2);
    const right = { leaf: true, keys: leaf.keys.splice(mid), values: leaf.values.splice(mid), next: leaf.next };
    leaf.next = right;
    if (leaf === this.last) this.last = right;
    if (this._cacheLeaf === leaf) this._cacheLeaf = right;
    this.stats.splits++;
    // 리프 분할: 오른쪽의 첫 키를 "복사" 해서 부모로 올린다 (리프에도 그대로 남음 → B+ 트리의 특징)
    this.#insertIntoParent(leaf, right.keys[0], right, path);
  }

  #insertIntoParent(left, key, right, path) {
    if (path.length === 0) {
      this._idxPath = null;
      this.root = { leaf: false, keys: [key], children: [left, right] };
      this.height++;
      return;
    }
    const parent = path.pop();
    const idxPath = this._idxPath;
    const i = idxPath && idxPath.length > 0 ? idxPath.pop() : parent.children.indexOf(left);
    parent.keys.splice(i, 0, key);
    parent.children.splice(i + 1, 0, right);
    if (parent.keys.length > this.maxKeys) this.#splitInternal(parent, path);
    else this._idxPath = null;
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

  /** 할당(제너레이터·배열) 없이 lo <= key <= hi 를 순회한다. fn 이 false 를 반환하면 중단 */
  forEachRange(lo = -Infinity, hi = Infinity, fn) {
    let leaf = this.#findLeaf(lo);
    let i = BPlusTree.lowerBound(leaf.keys, lo);
    while (leaf) {
      const ks = leaf.keys;
      const vs = leaf.values;
      const len = ks.length;
      for (; i < len; i++) {
        const k = ks[i];
        if (k > hi) return;
        if (fn(k, vs[i]) === false) return;
      }
      leaf = leaf.next;
      i = 0;
    }
  }

  /**
   * 가장 큰 키를 지운다 (없으면 undefined, 있으면 그 키).
   * 맨 오른쪽 리프에서 하나를 빼고, 노드가 최소 개수보다 적어지면 왼쪽 형제에게서 하나 빌리거나(borrow)
   * 왼쪽 형제와 합친다(merge). 합치면 부모의 키가 하나 줄어들므로 같은 일을 위로 올라가며 반복한다.
   * 트리 높이만큼만 일한다: O(log n)
   */
  removeMax() {
    if (this.size === 0) return undefined;
    this._cacheLeaf = null;
    const path = []; // 루트 → 맨 오른쪽 리프의 부모까지
    let node = this.root;
    while (!node.leaf) {
      path.push(node);
      node = node.children[node.children.length - 1];
    }
    const key = node.keys.pop();
    node.values.pop();
    this.size--;
    const minKeys = Math.ceil(this.order / 2) - 1;
    while (path.length && node.keys.length < minKeys) {
      const parent = path.pop();
      const last = parent.children.length - 1;
      const left = parent.children[last - 1];
      if (left.keys.length > minKeys) {
        // 빌리기: 왼쪽 형제의 마지막 것을 내 맨 앞으로
        if (node.leaf) {
          node.keys.unshift(left.keys.pop());
          node.values.unshift(left.values.pop());
          parent.keys[last - 1] = node.keys[0]; // 부모의 구분 키 = 오른쪽 자식의 가장 작은 키
        } else {
          node.keys.unshift(parent.keys[last - 1]); // 구분 키가 내려오고
          node.children.unshift(left.children.pop());
          parent.keys[last - 1] = left.keys.pop(); // 왼쪽의 마지막 키가 올라간다
        }
        break;
      }
      // 합치기: 나를 왼쪽 형제에 붙이고, 부모에서 나를 뺀다
      if (node.leaf) {
        for (let i = 0; i < node.keys.length; i++) {
          left.keys.push(node.keys[i]);
          left.values.push(node.values[i]);
        }
        left.next = node.next;
        if (node === this.last) this.last = left; // 맨 오른쪽 리프가 사라졌다 → insert 의 빠른 길이 가리키는 곳도 옮긴다
      } else {
        left.keys.push(parent.keys[last - 1]);
        for (const k of node.keys) left.keys.push(k);
        for (const c of node.children) left.children.push(c);
      }
      parent.keys.pop();
      parent.children.pop();
      node = parent;
    }
    // 루트에 자식이 하나만 남으면 그 자식이 새 루트 (높이가 1 줄어든다)
    while (!this.root.leaf && this.root.keys.length === 0) {
      this.root = this.root.children[0];
      this.height--;
    }
    return key;
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
