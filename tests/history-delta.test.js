import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, createElement, createText } from '../src/lib/vdom.js';
import { diff } from '../src/lib/diff.js';
import { applyPatches, applyPatchesToVNode } from '../src/lib/patch.js';
import { StateHistory, DeltaHistory } from '../src/lib/history.js';
import { devConfig } from '../src/lib/warn.js';

devConfig.warnings = false;
let seed = 4242;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ri = (n) => Math.floor(rand() * n);
const tags = ['div', 'p', 'span', 'ul', 'li', 'b'];
function tree(depth = 0) {
  if (depth > 0 && rand() < 0.25) return createText('t' + ri(4));
  const n = depth > 3 ? 0 : ri(5);
  const keyed = rand() < 0.6;
  const used = new Set();
  const kids = [];
  for (let i = 0; i < n; i++) {
    let c = tree(depth + 1);
    if (keyed && c.type !== '#text') { let k; do k = ri(8); while (used.has(k)); used.add(k); c = { ...c, key: k }; }
    kids.push(c);
  }
  const props = {};
  if (rand() < 0.5) props.class = 'c' + ri(3);
  return { type: tags[ri(tags.length)], props, key: null, children: kids };
}
const norm = (v) => (v == null ? null : v.type === '#text' ? { t: v.text } : { type: v.type, key: v.key ?? null, props: Object.fromEntries(Object.entries(v.props).filter(([, x]) => x !== undefined).sort()), children: v.children.map(norm) });
const same = (a, b) => assert.deepEqual(norm(a), norm(b));

describe('applyPatchesToVNode — 패치를 VNode 트리에 적용', () => {
  test('무작위 트리 3천 쌍: 결과가 새 트리와 같고, 원래 트리는 그대로', () => {
    for (let t = 0; t < 3000; t++) {
      const a = tree();
      const b = rand() < 0.1 ? createText('root') : tree();
      const before = JSON.stringify(norm(a));
      same(applyPatchesToVNode(a, diff(a, b)), b);
      assert.equal(JSON.stringify(norm(a)), before);
    }
  });

  test('바뀌지 않은 하위 트리는 원래 트리와 공유한다', () => {
    const row = (k, t) => h('li', { key: k }, h('b', null, t));
    const a = h('ul', null, row(1, 'a'), row(2, 'b'), row(3, 'c'));
    const out = applyPatchesToVNode(a, diff(a, h('ul', null, row(1, 'a'), row(2, 'B'), row(3, 'c'))));
    assert.equal(out.children[0], a.children[0]);
    assert.equal(out.children[2], a.children[2]);
    assert.notEqual(out.children[1], a.children[1]);
  });
});

describe('DeltaHistory — 키프레임 + 델타', () => {
  test('무작위 push · back · forward · go 2천 번: 매번 StateHistory 와 같은 화면, 이동 패치를 DOM 에 적용하면 목표와 같다', () => {
    for (const keyframeEvery of [1, 3, 10]) {
      const first = tree();
      const snap = new StateHistory(first, { limit: 30 });
      const delta = new DeltaHistory(first, { limit: 30, keyframeEvery });
      const host = document.createElement('div');
      host.appendChild(createElement(first));
      for (let t = 0; t < 700; t++) {
        const r = rand();
        if (r < 0.45) {
          const next = tree();
          applyPatches(host.firstChild, diff(delta.current, next));
          snap.push(next);
          delta.push(next);
        } else {
          const target = r < 0.6 ? delta.index - 1 : r < 0.75 ? delta.index + 1 : ri(delta.entries.length);
          if (target < 0 || target >= delta.entries.length) continue;
          const { patches } = delta.travel(target);
          snap.go(target);
          const root = applyPatches(host.firstChild, patches);
          if (root !== host.firstChild) host.replaceChildren(root);
        }
        assert.equal(delta.index, snap.index);
        assert.equal(delta.entries.length, snap.entries.length);
        same(delta.current, snap.current);
        const expected = createElement(snap.current);
        assert.equal(host.firstChild.outerHTML ?? host.firstChild.nodeValue, expected.outerHTML ?? expected.nodeValue);
      }
    }
  });

  test('한 칸 이동은 저장된 패치를 쓰고 (diff 없음), 멀리 이동은 가까운 키프레임에서 다시 만든다', () => {
    const v = (n) => h('ul', null, ...Array.from({ length: 5 }, (_, i) => h('li', { key: i }, String(i + n))));
    const hist = new DeltaHistory(v(0), { keyframeEvery: 5 });
    for (let i = 1; i <= 12; i++) hist.push(v(i), `${i}`);
    assert.equal(hist.travel(11).via, 'delta');
    const far = hist.travel(1);
    assert.equal(far.via, 'keyframe');
    assert.equal(far.steps, 1); // 키프레임 0 에서 한 칸
    same(far.vnode, v(1));
    assert.deepEqual(hist.entries.map((e) => !!e.keyframe), [true, false, false, false, false, true, false, false, false, false, true, false, false]);
  });

  test('limit 을 넘으면 가장 오래된 기록을 버리고, 새 첫 기록을 키프레임으로 만든다', () => {
    const v = (n) => h('p', null, String(n));
    const hist = new DeltaHistory(v(0), { limit: 4, keyframeEvery: 10 });
    for (let i = 1; i <= 6; i++) hist.push(v(i));
    assert.equal(hist.entries.length, 4);
    assert.ok(hist.entries[0].keyframe);
    same(hist.go(0), v(3));
    same(hist.go(3), v(6));
  });
});

describe('Playground — 히스토리를 이동해도 실제 영역의 사용자 상태가 남는다', async () => {
  const { Playground } = await import('../phase1/playground.js');
  const { htmlToVNode } = await import('../src/lib/vdom.js');
  const listHTML = (keys) => `<ul>${keys.map((k) => `<li data-key="${k}"><span>${k}</span><input data-k="${k}"></li>`).join('')}</ul>`;
  const setup = () => {
    const actual = document.createElement('div');
    document.body.appendChild(actual);
    actual.innerHTML = listHTML(['a', 'b', 'c', 'd', 'e']);
    const pg = new Playground({ actualRoot: actual, renderTestArea: () => {} });
    pg.init();
    const typeInto = () => actual.querySelectorAll('input').forEach((el) => { el.value = `입력-${el.dataset.k}`; });
    const kept = () => [...actual.querySelectorAll('input')].filter((el) => el.value === `입력-${el.dataset.k}`).length;
    return { actual, pg, typeInto, kept };
  };
  const vnodeOf = (keys) => htmlToVNode(listHTML(keys)).children; // 컨테이너 VNode 의 자식 (ul 하나)

  test('뒤로 · 앞으로 · 멀리 이동해도 입력값 5/5 와 포커스가 유지된다 (다시 그리면 0/5)', () => {
    const { actual, pg, typeInto, kept } = setup();
    pg.patch({ ...pg.current, children: vnodeOf(['e', 'a', 'b', 'c', 'd']) });
    pg.patch({ ...pg.current, children: vnodeOf(['e', 'a', 'c', 'b', 'd']) });
    typeInto();
    const focused = actual.querySelector('[data-k="b"]');
    focused.focus();
    pg.back();
    assert.equal(kept(), 5);
    pg.go(0);
    assert.equal(kept(), 5);
    pg.forward();
    pg.forward();
    assert.equal(kept(), 5);
    assert.equal(document.activeElement, focused, '포커스 유지');
    assert.deepEqual([...actual.querySelectorAll('input')].map((el) => el.dataset.k), ['e', 'a', 'c', 'b', 'd']);
    // 비교: 스냅샷으로 실제 영역을 통째로 다시 그리면 입력값이 모두 사라진다
    actual.replaceChildren(...pg.current.children.map((c) => createElement(c)));
    assert.equal(kept(), 0);
    actual.remove();
  });

  test('한 칸 이동은 저장된 패치를 쓰고, 결과에 그 사실이 남는다', () => {
    const { actual, pg } = setup();
    pg.patch({ ...pg.current, children: vnodeOf(['b', 'a', 'c', 'd', 'e']) });
    const r = pg.back();
    assert.equal(r.via, 'delta');
    assert.equal(r.steps, 1);
    actual.remove();
  });
});
