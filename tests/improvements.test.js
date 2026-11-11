/**
 * 개선 사항 검증 — 전역 상태 제거 · props API · 중복 key 경고 · 핸들러 패치 없애기 · memo · patch 실패 복구
 *                  · 뒤집은 패치 · 분기 히스토리 · 스크롤 유지
 */
import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, createElement, createText } from '../src/lib/vdom.js';
import { diff, diffProps } from '../src/lib/diff.js';
import { applyPatches, applyPatchesToVNode } from '../src/lib/patch.js';
import { DeltaHistory, invertPatches } from '../src/lib/history.js';
import { mount, useState, memo } from '../src/lib/component.js';
import { devConfig, resetWarnings } from '../src/lib/warn.js';

let seed = 777;
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
const html = (el) => el.outerHTML ?? el.nodeValue;

describe('1 · diff 는 전역 상태를 쓰지 않는다', () => {
  test('diff 도중 (속성 getter 안에서) diff 를 또 불러도 바깥 diff 의 경로가 섞이지 않는다', () => {
    const inner = () => diff(h('ul', null, h('li', null, 'x'), h('li', null, h('b', null, 'y'))), h('ul', null, h('li', null, 'x'), h('li', null, h('b', null, 'Y'))));
    let innerPatches = null;
    const sneaky = {};
    Object.defineProperty(sneaky, 'title', { enumerable: true, get() { innerPatches = inner(); return 't'; } });
    const a = h('div', null, h('p', null, 'a'), h('section', null, h('i', null, 'b'), h('i', null, 'c')));
    const b = h('div', null, h('p', null, 'A'), { type: 'section', props: sneaky, key: null, children: [h('i', null, 'b'), h('i', null, 'C')] });
    const patches = diff(a, b);
    assert.deepEqual(innerPatches.map((p) => p.path), [[1, 0, 0]]);
    assert.deepEqual(patches.filter((p) => p.type === 'TEXT').map((p) => p.path), [[0, 0], [1, 1, 0]]);
  });
});

describe('3 · 4 · diffProps', () => {
  test('바뀐 게 없어도 새 배열을 돌려준다 (고쳐도 안전)', () => {
    const r = diffProps({ a: 1 }, { a: 1 });
    assert.deepEqual(r, []);
    r.push('ok');
    assert.deepEqual(diffProps({ a: 1 }, { a: 1 }), []);
  });

  test('물려받은 속성은 비교하지 않는다', () => {
    const oldP = Object.create({ inherited: 1 });
    const newP = Object.create({ inherited: 2 });
    oldP.own = 1;
    newP.own = 1;
    assert.deepEqual(diffProps(oldP, newP), []);
  });
});

describe('diff 와 createElement 는 같은 규칙: 자기 속성만', () => {
  test('손으로 Object.create(기본값) 로 만든 props: 처음 그릴 때도, 비교할 때도 물려받은 속성은 쓰지 않는다', () => {
    const v = (title) => ({ type: 'p', props: Object.assign(Object.create({ title }), { id: 'a' }), key: null, children: [] });
    const el = createElement(v('처음'));
    assert.equal(el.getAttribute('title'), null, '처음 그릴 때 물려받은 title 은 없다');
    assert.deepEqual(diff(v('처음'), v('바뀜')), [], '비교할 때도 물려받은 title 의 변화는 패치가 아니다');
  });
});

describe('5 · 중복 key 는 리스트를 만들 때 경고한다', () => {
  test('h() 가 같은 key 를 찾아 알린다', () => {
    const got = [];
    const was = devConfig.warnings;
    devConfig.warnings = true;
    devConfig.onWarn = (m) => got.push(m);
    resetWarnings();
    h('ul', null, [h('li', { key: 'a' }), h('li', { key: 'b' }), h('li', { key: 'a' })]);
    devConfig.onWarn = null;
    devConfig.warnings = was;
    assert.ok(got.some((m) => m.includes('같은 key "a"')));
  });
});

describe('6 · 매번 새로 만드는 핸들러는 패치 없이 바꾼다', () => {
  test('바뀐 게 없으면 패치 0개, 클릭하면 최신 상태를 읽는 새 핸들러가 불린다', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let setCount;
    const seen = [];
    function App() {
      const [count, set] = useState(0);
      setCount = set;
      return h('ul', null, ...[1, 2, 3].map((k) => h('li', { key: k }, h('button', { onClick: () => seen.push(`${k}:${count}`) }, String(k)))));
    }
    const comp = mount(App, host);
    setCount(5);
    const patches = comp.flush();
    assert.equal(patches.length, 0, '예전에는 줄마다 PROPS(onClick) 패치 3개');
    host.querySelectorAll('button')[1].click();
    assert.deepEqual(seen, ['2:5'], '새 핸들러(count = 5)가 불렸다');
    setCount(7);
    comp.flush();
    host.querySelectorAll('button')[2].click();
    assert.deepEqual(seen, ['2:5', '3:7']);
    comp.unmount();
    host.remove();
  });

  test('화면에 없는 VNode 끼리 비교하면 예전처럼 PROPS 패치를 만든다', () => {
    const f = () => {}, g = () => {};
    const patches = diff(h('button', { onClick: f }), h('button', { onClick: g }));
    assert.deepEqual(patches.map((p) => p.type), ['PROPS']);
  });
});

describe('6 · 바깥에서 DOM 을 바꿔도 다른 줄의 핸들러가 불리지 않는다', () => {
  function setup(keyed) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const calls = [];
    let setN;
    function App() {
      const [n, set] = useState(0);
      setN = set;
      return h('ul', null, ...[1, 2, 3].map((id) => h('li', keyed ? { key: id } : null, h('span', null, `줄 ${id}`), h('button', { onClick: () => calls.push(`${id}:${n}`) }, '삭제'))));
    }
    const comp = mount(App, host);
    setN(9);
    comp.flush();
    const button = (id) => [...host.querySelectorAll('li')].find((li) => li.firstChild.textContent === `줄 ${id}`).querySelector('button');
    return { host, comp, calls, button };
  }

  test('평소에는 최신 핸들러 (n = 9)', () => {
    const { host, comp, calls, button } = setup(true);
    button(2).click();
    assert.deepEqual(calls, ['2:9']);
    comp.unmount(); host.remove();
  });

  for (const keyed of [true, false]) {
    test(`목록 앞에 누가 줄을 끼워 넣어도 누른 줄(2)의 핸들러가 불린다 (${keyed ? 'key 있음' : 'key 없음'})`, () => {
      const { host, comp, calls, button } = setup(keyed);
      const ul = host.querySelector('ul');
      const intruder = document.createElement('li');
      intruder.innerHTML = '<span>광고</span><button>x</button>';
      ul.insertBefore(intruder, ul.firstChild); // 바깥 코드가 DOM 을 바꿈 → 위치가 한 칸씩 밀림
      button(2).click();
      assert.equal(calls.length, 1);
      assert.match(calls[0], /^2:/, `누른 줄은 2 인데 ${calls[0]} 의 핸들러가 불림`);
      comp.unmount(); host.remove();
    });
  }

  test('브라우저 번역처럼 글자를 다른 태그로 감싸도, 위치가 그대로인 줄은 최신 핸들러를 쓴다', () => {
    const { host, comp, calls, button } = setup(true);
    const span = host.querySelector('li span'); // 줄 1 의 글자
    const font = document.createElement('font');
    font.textContent = span.firstChild.nodeValue;
    span.replaceChild(font, span.firstChild); // 텍스트 노드 → <font> (줄 2 의 경로에는 영향 없음)
    button(2).click();
    assert.deepEqual(calls, ['2:9']);
    comp.unmount(); host.remove();
  });
});

describe('7 · memo', () => {
  test('props 가 같은 줄은 지난 결과 객체를 그대로 써서 diff 가 건너뛰고, 사라진 줄의 결과는 버린다', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let calls = 0;
    const Row = memo(function Row({ label }) { calls++; return h('li', null, label); });
    let setItems;
    function App() {
      const [items, set] = useState([{ id: 1, label: 'a' }, { id: 2, label: 'b' }, { id: 3, label: 'c' }]);
      setItems = set;
      return h('ul', null, ...items.map((it) => h(Row, { key: it.id, label: it.label })));
    }
    const comp = mount(App, host);
    assert.equal(calls, 3);
    const before = comp.vnode.children.slice();
    setItems([{ id: 1, label: 'a' }, { id: 2, label: 'B' }, { id: 3, label: 'c' }]);
    const patches = comp.flush();
    assert.equal(calls, 4, '바뀐 줄 하나만 다시 실행');
    assert.equal(comp.vnode.children[0], before[0], '안 바뀐 줄은 같은 객체');
    assert.equal(comp.vnode.children[2], before[2]);
    assert.deepEqual(patches.map((p) => p.type), ['TEXT']);
    setItems([{ id: 1, label: 'a' }]);
    comp.flush();
    assert.equal(comp.memoCache.get(Row).size, 1, '사라진 줄(2, 3)의 결과는 버렸다');
    assert.equal(host.innerHTML, '<ul><li>a</li></ul>');
    comp.unmount();
    host.remove();
  });
});

describe('2 · patch 가 실패하면 화면을 새로 그려 맞춘다', () => {
  test('누군가 DOM 을 직접 지워 패치 경로가 깨져도, 다음 업데이트에서 VNode 와 같은 화면으로 돌아온다', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let setN;
    function App() {
      const [n, set] = useState(1);
      setN = set;
      return h('div', null, h('p', null, 'a'), h('p', null, h('b', null, `n=${n}`)));
    }
    const comp = mount(App, host);
    const warns = [];
    const was = devConfig.warnings;
    devConfig.warnings = true;
    devConfig.onWarn = (m) => warns.push(m);
    resetWarnings();
    host.firstChild.lastChild.remove(); // 바깥에서 DOM 을 망가뜨림
    setN(2);
    comp.flush();
    devConfig.onWarn = null;
    devConfig.warnings = was;
    assert.ok(warns.some((m) => m.includes('화면을 새로 그렸습니다')));
    assert.equal(host.innerHTML, '<div><p>a</p><p><b>n=2</b></p></div>');
    setN(3);
    comp.flush();
    assert.equal(host.innerHTML, '<div><p>a</p><p><b>n=3</b></p></div>', '복구 뒤 업데이트도 정상');
    comp.unmount();
    host.remove();
  });
});

describe('8 · 뒤집은 패치 (invertPatches)', () => {
  test('무작위 트리 3천 쌍: 앞으로 패치 뒤 뒤집은 패치를 적용하면 원래 트리 · 원래 DOM 으로 돌아온다', () => {
    const was = devConfig.warnings;
    devConfig.warnings = false;
    for (let t = 0; t < 3000; t++) {
      const a = tree();
      const b = rand() < 0.1 ? createText('root') : tree();
      const fwd = diff(a, b);
      const back = invertPatches(fwd);
      assert.deepEqual(norm(applyPatchesToVNode(applyPatchesToVNode(a, fwd), back)), norm(a));
      const host = document.createElement('div');
      host.appendChild(createElement(a));
      let root = applyPatches(host.firstChild, fwd);
      if (root !== host.firstChild) host.replaceChildren(root);
      root = applyPatches(host.firstChild, back);
      if (root !== host.firstChild) host.replaceChildren(root);
      assert.equal(html(host.firstChild), html(createElement(a)));
    }
    devConfig.warnings = was;
  });
});

describe('9 · 14 · 분기 히스토리', () => {
  for (const limit of [1000, 25]) {
    test(`무작위 기록 · 이동 1,500번 (limit ${limit}): 매번 그 기록의 화면 · 실제 DOM 과 같고, 기록 수는 limit 을 넘지 않는다`, () => {
      const was = devConfig.warnings;
      devConfig.warnings = false;
      for (const keyframeEvery of [1, 4, 10]) {
        const first = tree();
        const hist = new DeltaHistory(first, { keyframeEvery, branching: true, limit });
        const truth = new Map([[hist.entries[0], first]]); // 기록 객체 → 그 기록의 화면 (번호는 버릴 때 바뀌므로 객체로)
        const host = document.createElement('div');
        host.appendChild(createElement(first));
        for (let t = 0; t < 500; t++) {
          if (rand() < 0.45) {
            const next = tree();
            const root = applyPatches(host.firstChild, diff(hist.current, next));
            if (root !== host.firstChild) host.replaceChildren(root);
            hist.push(next);
            truth.set(hist.entries[hist.index], next);
          } else {
            const r = rand();
            const e = hist.entries[hist.index];
            const target = r < 0.3 && hist.canBack ? e.parent : r < 0.5 && hist.canForward ? e.lastChild : ri(hist.entries.length);
            const { patches, via, steps } = hist.travel(target);
            if (via === 'keyframe') assert.ok(steps < keyframeEvery, '키프레임은 많아야 keyframeEvery 칸 위에 있다');
            const root = applyPatches(host.firstChild, patches);
            if (root !== host.firstChild) host.replaceChildren(root);
          }
          assert.ok(hist.entries.length <= limit, `기록 ${hist.entries.length}개 > limit ${limit}`);
          const want = truth.get(hist.entries[hist.index]);
          assert.deepEqual(norm(hist.current), norm(want));
          assert.equal(html(host.firstChild), html(createElement(want)));
          for (const en of hist.entries) if (en.parent !== -1) assert.ok(en.parent < hist.entries.length && en.fwd, '부모 번호 · 패치가 남아 있다');
        }
        if (limit === 1000) assert.equal(hist.entries.length, truth.size, '넘지 않으면 하나도 버리지 않는다');
      }
      devConfig.warnings = was;
    });
  }

  test('limit 을 넘으면 지금 위치로 오는 길에 없는 가장 오래된 갈래 끝부터 버린다', () => {
    const v = (n) => h('p', null, String(n));
    const hist = new DeltaHistory(v(0), { branching: true, limit: 5 });
    hist.push(v(1)); hist.push(v(2));          // 0 → 1 → 2
    hist.back(); hist.push(v(3));              // 1 → 3 (갈래)
    hist.back(); hist.push(v(4));              // 1 → 4 (갈래) — 기록 5개
    hist.push(v(5));                           // 4 → 5 → 6개가 되므로 하나를 버린다
    const labels = hist.entries.map((e) => e.keyframe?.children?.[0]?.text ?? (e.parent === -1 ? '0' : '?'));
    assert.equal(hist.entries.length, 5);
    // 가장 오래된 잎은 #2(화면 "2"). 지금 길(0 → 1 → 4 → 5)은 그대로
    hist.go(0);
    hist.go(hist.entries.length - 1);
    assert.equal(norm(hist.current).children[0].t, '5');
    const screens = hist.entries.map((_, i) => { hist.go(i); return norm(hist.current).children[0].t; });
    assert.deepEqual(screens.sort(), ['0', '1', '3', '4', '5'], `남은 화면 (2 가 버려져야 함) — ${labels}`);
  });
});

describe('15 · 히스토리 이동 뒤에도 스크롤 위치가 남는다', async () => {
  const { Playground } = await import('../phase1/playground.js');
  const { htmlToVNode } = await import('../src/lib/vdom.js');
  test('실제 영역의 스크롤 상자 scrollTop 이 뒤로 · 앞으로 이동 뒤에도 그대로', () => {
    const page = (label) => `<div data-key="box" class="scroll"><p data-key="p1">${label}</p><p data-key="p2">고정</p></div>`;
    const actual = document.createElement('div');
    document.body.appendChild(actual);
    actual.innerHTML = page('처음');
    const pg = new Playground({ actualRoot: actual, renderTestArea: () => {} });
    pg.init();
    pg.patch({ ...pg.current, children: htmlToVNode(page('두 번째')).children });
    const box = actual.querySelector('.scroll');
    box.scrollTop = 120;
    pg.back();
    assert.equal(actual.querySelector('.scroll'), box, '같은 요소 (다시 만들지 않음)');
    assert.equal(box.scrollTop, 120);
    pg.forward();
    assert.equal(box.scrollTop, 120);
    actual.remove();
  });
});
