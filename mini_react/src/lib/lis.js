/**
 * LIS (최장 증가 부분 수열) — diff 가 "옮기지 않아도 되는 줄" 을 고를 때 쓴다.
 *  diff.js 에서 분리. diff.js 가 다시 내보내므로 예전 import 경로도 그대로 동작한다.
 */

/**
 * 최장 증가 부분 수열의 "인덱스" 들을 반환. O(n log n), 이미 증가하는 부분은 O(1) 씩.
 * 예) [2, 0, 1, 3] → [1, 2, 3]  (값 0,1,3)
 *  - 엄격하게 증가하는 수열만 센다 (같은 값은 이어지지 않음).
 *  - 비교할 수 없는 값(undefined · null · NaN)은 건너뛴다. 예전에는 이런 값이 섞이면 결과가 짧아졌다
 *    ([1, undefined, 2, 3] → 길이 2). diff 는 이런 값을 넘기지 않지만 밖에서 쓰는 경우를 위해 막아 둔다.
 *  - 배열 · 타입 배열 모두 받는다.
 */
export function longestIncreasingSubsequence(arr, weights) {
  const n = arr.length;
  if (n === 0) return [];
  if (weights) return weightedLIS(arr, weights);
  const prev = new Int32Array(n); // prev[i] = i 앞에 오는 원소의 인덱스 (+1, 0 이면 없음)
  const tails = new Int32Array(n); // tails[len] = 길이 len+1 인 증가 수열의 마지막 원소 인덱스
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v == null || v !== v) continue; // undefined · null · NaN
    // 빠른 길: 지금까지 가장 긴 수열의 끝보다 크면 이분 탐색 없이 뒤에 붙인다 (이미 정렬된 구간이 많은 diff 에서 흔함)
    if (len === 0 || arr[tails[len - 1]] < v) {
      prev[i] = len > 0 ? tails[len - 1] + 1 : 0;
      tails[len++] = i;
      continue;
    }
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] + 1 : 0;
    tails[lo] = i;
  }
  // 뒤에서부터 채워 reverse 없이 만든다
  const result = new Array(len);
  for (let k = len - 1, i = tails[len - 1]; k >= 0; k--) {
    result[k] = i;
    i = prev[i] - 1;
  }
  return result;
}

/**
 * 가중치가 있는 LIS — 가장 긴 증가 수열들 중에서 가중치 합이 가장 큰 것. O(n log n).
 *  길이가 먼저이므로 옮기는 횟수(남은 줄 − LIS 길이)는 늘지 않는다. 같은 길이일 때만 가중치가 큰 줄을 남긴다.
 *  값을 순위로 바꾼 뒤, "내 값보다 작은 값으로 끝나는 가장 좋은 (길이, 가중치)" 를 Fenwick 트리(앞부분 최댓값)로 찾는다.
 */
function weightedLIS(arr, weights) {
  const n = arr.length;
  const ok = [];
  for (let i = 0; i < n; i++) { const v = arr[i]; if (v != null && v === v) ok.push(i); }
  if (ok.length === 0) return [];
  const vals = [...new Set(ok.map((i) => arr[i]))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rankOf = new Map(vals.map((v, r) => [v, r + 1]));
  const m = vals.length;
  const tLen = new Int32Array(m + 1), tW = new Float64Array(m + 1), tI = new Int32Array(m + 1).fill(-1);
  const better = (l1, w1, l2, w2) => l1 > l2 || (l1 === l2 && w1 > w2);
  const prev = new Int32Array(n).fill(-1);
  let bestLen = 0, bestW = -1, bestI = -1;
  for (const i of ok) {
    const r = rankOf.get(arr[i]);
    // 순위 < r 중 가장 좋은 끝점
    let ql = 0, qw = 0, qi = -1;
    for (let k = r - 1; k > 0; k -= k & -k) if (better(tLen[k], tW[k], ql, qw)) { ql = tLen[k]; qw = tW[k]; qi = tI[k]; }
    const len = ql + 1, w = qw + (weights[i] || 0);
    prev[i] = qi;
    if (better(len, w, bestLen, bestW)) { bestLen = len; bestW = w; bestI = i; }
    for (let k = r; k <= m; k += k & -k) if (better(len, w, tLen[k], tW[k])) { tLen[k] = len; tW[k] = w; tI[k] = i; }
  }
  const result = new Array(bestLen);
  for (let k = bestLen - 1, i = bestI; k >= 0; k--, i = prev[i]) result[k] = i;
  return result;
}
