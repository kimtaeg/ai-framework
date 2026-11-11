/**
 * Fenwick 트리 (Binary Indexed Tree) — 앞부분 합을 O(log n) 에 구하고, 한 칸을 O(log n) 에 바꾼다.
 *  diff 의 배치 단계(diff.js place)와 비교용 앞에서부터 방식(move/naive.js)이 함께 쓴다.
 *  "좌표 k 앞에 1 이 몇 개 있나" = 지금 DOM 에서 몇 번째인가.
 */
export class FenwickSum {
  constructor(size) {
    this.size = size;
    this.tree = new Int32Array(size + 1);
  }

  /** 좌표 k (0부터) 에 v 를 더한다 */
  add(k, v) {
    for (k++; k <= this.size; k += k & -k) this.tree[k] += v;
  }

  /** 좌표 0 .. k-1 의 합 (k 앞에 있는 개수) */
  countBefore(k) {
    let s = 0;
    for (; k > 0; k -= k & -k) s += this.tree[k];
    return s;
  }
}
