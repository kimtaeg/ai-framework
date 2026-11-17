/**
 * 실제 브라우저에서만 확인할 수 있는 동작 검사 (jsdom 에는 moveBefore · 레이아웃 · 실제 포커스 규칙이 없다)
 *  열자마자 실행하고 결과를 화면과 window.__selftest 에 남긴다.
 */
import { h, createElement, diff, applyPatches, focusedKeys, mount, useState, DeltaHistory } from '../src/lib/index.js';

const stage = document.querySelector('#stage');
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
  stage.replaceChildren();
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const list = (keys) => h('ul', null, ...keys.map((k) => h('li', { key: k }, h('span', null, k), h('input', { 'data-k': k }))));
const withoutMoveBefore = async (fn) => {
  const saved = Element.prototype.moveBefore;
  Element.prototype.moveBefore = undefined;
  try { return await fn(); } finally { Element.prototype.moveBefore = saved; }
};

await check('moveBefore 가 있으면, 입력 중인 줄을 맨 위로 옮겨도 포커스 · 커서가 남는다', () => {
  if (typeof Element.prototype.moveBefore !== 'function') return '이 브라우저에는 moveBefore 가 없음 (건너뜀)';
  const a = list(['a', 'b', 'c', 'd']);
  const root = createElement(a);
  stage.append(root);
  const input = root.querySelector('[data-k="d"]');
  input.focus();
  input.value = '입력중';
  input.setSelectionRange(2, 2);
  applyPatches(root, diff(a, list(['d', 'a', 'b', 'c'])));
  assert(document.activeElement === input, '포커스가 풀림');
  assert(input.selectionStart === 2, '커서 위치가 바뀜');
  return '포커스 · 커서 유지';
});

await check('moveBefore 가 없으면, 한 칸 아래로 옮길 때 가중치 LIS 가 입력 중인 줄 대신 옆 줄을 옮긴다', () => withoutMoveBefore(() => {
  const a = list(['a', 'b', 'c', 'd']);
  const root = createElement(a);
  stage.append(root);
  const input = root.querySelector('[data-k="b"]');
  input.focus();
  const patches = diff(a, list(['a', 'c', 'b', 'd']), [], [], { keep: focusedKeys(root) });
  applyPatches(root, patches);
  const moved = patches.filter((p) => p.type === 'MOVE').map((p) => p.key);
  assert(moved.join() === 'c', `옮긴 줄: ${moved.join()}`);
  assert(document.activeElement === input, '포커스가 풀림');
  return `옮긴 줄 ${moved.join()} · 포커스 유지`;
}));

await check('매번 새로 만드는 클릭 핸들러: 패치 0개, 클릭하면 최신 상태를 읽는다', async () => {
  let setN;
  const seen = [];
  function App() {
    const [n, set] = useState(0);
    setN = set;
    return h('div', null, h('button', { onClick: () => seen.push(n) }, '눌러'));
  }
  const comp = mount(App, stage);
  setN(3);
  const patches = comp.flush();
  stage.querySelector('button').click();
  comp.unmount();
  assert(patches.length === 0, `패치 ${patches.length}개`);
  assert(seen[0] === 3, `읽은 값 ${seen[0]}`);
  return '패치 0개 · 최신 값 3';
});

await check('히스토리를 뒤로 · 앞으로 이동해도 입력값과 실제 스크롤 위치가 남는다', () => {
  const page = (label) => h('div', { class: 'scroll', style: { height: '60px', overflow: 'auto' } },
    ...Array.from({ length: 30 }, (_, i) => h('p', { key: i }, i === 0 ? label : `줄 ${i}`, h('input', { 'data-i': String(i) }))));
  const v0 = page('처음');
  const root = createElement(v0);
  stage.append(root);
  const hist = new DeltaHistory(v0, { keyframeEvery: 10, branching: true });
  const v1 = page('두 번째');
  const fwd = diff(v0, v1);
  applyPatches(root, fwd);
  hist.push(v1, '두 번째', fwd);
  root.scrollTop = 200;
  const input = root.querySelector('[data-i="5"]');
  input.value = '메모';
  applyPatches(root, hist.travel(0).patches);
  applyPatches(root, hist.travel(1).patches);
  assert(root.scrollTop === 200, `scrollTop ${root.scrollTop}`);
  assert(input.value === '메모' && root.contains(input), '입력값이 사라짐');
  return 'scrollTop 200 · 입력값 유지';
});

await check('MOVE 하나는 실제 DOM 변경 기록 2건 (떼기 + 붙이기) 이고, 결과 순서가 맞다', () => {
  const a = list(['a', 'b', 'c', 'd', 'e']);
  const root = createElement(a);
  stage.append(root);
  const mo = new MutationObserver(() => {});
  mo.observe(root, { childList: true });
  applyPatches(root, diff(a, list(['e', 'a', 'b', 'c', 'd'])));
  const records = mo.takeRecords().length;
  mo.disconnect();
  const order = [...root.querySelectorAll('span')].map((s) => s.textContent).join('');
  assert(order === 'eabcd', `순서 ${order}`);
  return `기록 ${records}건 · 순서 ${order}`;
});

const passed = results.filter((r) => r.ok).length;
document.querySelector('#summary').textContent = `${passed} / ${results.length} 통과 · ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? navigator.userAgent}`;
document.querySelector('#results').replaceChildren(...results.map((r) => {
  const li = document.createElement('li');
  li.className = r.ok ? 'pass' : 'fail';
  li.innerHTML = `<b>${r.ok ? '통과' : '실패'}</b> ${r.name} — ${r.detail}`;
  return li;
}));
window.__selftest = { passed, total: results.length, results };
