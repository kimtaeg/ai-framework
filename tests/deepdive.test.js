/**
 * 개념 더 파고들기 페이지: 계산 함수 + 실험 앱
 */
import './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FunctionComponent } from '../src/lib/component.js';
import { diff, summarizePatches } from '../src/lib/diff.js';
import { h } from '../src/lib/vdom.js';
import {
  parseKeys, lisPlan, visiblePatches, naiveMoves, hookSlots, diffCost, humanTime, scoreOrder,
  SnapshotApp, KeyIdentityApp, RaceApp, ImmutableApp, HookOrderApp,
} from '../deepdive/labs.js';
import { container, flushMicrotasks } from './setup.js';

const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));
const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('계산 함수', () => {
  test('parseKeys: 공백/쉼표로 나누고 중복 제거', () => {
    assert.deepEqual(parseKeys('A, B  C,A'), ['A', 'B', 'C']);
    assert.deepEqual(parseKeys(''), []);
  });

  test('lisPlan: 맨 앞 → 맨 뒤 는 A 하나만 이동', () => {
    const p = lisPlan(['A', 'B', 'C', 'D', 'E'], ['B', 'C', 'D', 'E', 'A']);
    assert.deepEqual(p.positions, [1, 2, 3, 4, 0]);
    assert.deepEqual(p.keep, ['B', 'C', 'D', 'E']);
    assert.deepEqual(p.moved, ['A']);
  });

  test('lisPlan: 추가/삭제/이동이 섞여도 계산한다', () => {
    const p = lisPlan(['A', 'B', 'C', 'D'], ['X', 'B', 'D', 'Y', 'A']);
    assert.deepEqual(p.inserted, ['X', 'Y']);
    assert.deepEqual(p.removed, ['C']);
    assert.deepEqual(p.moved, ['A']);
  });

  test('lisPlan 의 이동 수 = 실제 diff 의 MOVE 수 (여러 경우)', () => {
    const cases = [
      ['A B C D E', 'E A B C D'], ['A B C D E', 'E D C B A'], ['A B C D E F', 'A C B E D F'],
      ['A B C', 'A B C'], ['A B C D', 'X B D Y A'], ['1 2 3 4 5 6 7', '7 1 3 2 6 5 4'],
    ];
    const list = (keys) => h('ul', null, ...keys.map((k) => h('li', { key: k }, k)));
    for (const [o, n] of cases) {
      const ok = parseKeys(o), nk = parseKeys(n);
      const real = summarizePatches(diff(list(ok), list(nk)));
      assert.equal(real.MOVE, lisPlan(ok, nk).moved.length, `${o} → ${n}`);
      assert.ok(lisPlan(ok, nk).moved.length <= naiveMoves(ok, nk));
    }
  });

  test('hookSlots: 조건부 Hook 이 끼면 그 칸부터 어긋난다', () => {
    const rows = hookSlots(['useState:on', 'useState:n', 'useMemo:d'], ['useState:on', 'useRef:memo', 'useState:n', 'useMemo:d']);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'mismatch', 'mismatch', 'extra']);
    assert.deepEqual(hookSlots(['useState:a', 'useState:b'], ['useState:b', 'useState:a']).map((r) => r.status), ['swapped', 'swapped']);
  });

  test('diffCost / humanTime / scoreOrder', () => {
    const c = diffCost(1000);
    assert.equal(c.naive, 1e9);
    assert.equal(c.heuristic, 1000);
    assert.equal(humanTime(1), '1.0초');
    assert.equal(humanTime(0.0021), '2.1ms');
    assert.match(humanTime(1e6), /일$/);
    assert.equal(scoreOrder(['a', 'b', 'c'], ['a', 'c', 'b']), 1);
  });
});

describe('실험 앱', () => {
  test('SnapshotApp: 타이머 속 state 는 그때 값, ref 는 최신 값', async () => {
    const box = container();
    const comp = new FunctionComponent(SnapshotApp, { delay: 30 }).mount(box);
    click(box.querySelector('.read-state'));
    click(box.querySelector('.read-ref'));
    click(box.querySelector('.inc'));
    click(box.querySelector('.inc'));
    await flushMicrotasks();
    await sleep(60);
    await flushMicrotasks();
    const items = [...box.querySelectorAll('.snap-log li')].map((li) => li.textContent);
    assert.equal(items.length, 2);
    assert.match(items[0], /count → 0/);
    assert.match(items[0], /그때의 사진/);
    assert.match(items[1], /ref\.current → 2/);
    assert.match(items[1], /최신 값/);
    comp.unmount();
  });

  test('KeyIdentityApp: index key 는 TEXT+INSERT, id key 는 INSERT 하나', async () => {
    const box = container();
    let last = null;
    const comp = new FunctionComponent(KeyIdentityApp, {}, { onCommit: (i) => { last = i; } }).mount(box);
    // index 모드: 첫 줄 메모 입력칸 DOM 이 맨 앞 자리에 남는다
    const firstInput = box.querySelector('.memo');
    firstInput.value = '김정글 메모';
    click(box.querySelector('.prepend'));
    await flushMicrotasks();
    const types = new Set(visiblePatches(last.patches).map((p) => p.type));
    assert.ok(types.has('TEXT') && types.has('INSERT') && !types.has('MOVE'));
    assert.equal(box.querySelector('.memo'), firstInput, '맨 앞 입력칸은 같은 DOM 그대로');
    assert.notEqual(box.querySelector('.person b').textContent, '김정글', '그런데 옆 이름은 바뀜 → 메모 주인이 바뀜');
    comp.unmount();

    const box2 = container();
    const comp2 = new FunctionComponent(KeyIdentityApp, {}, { onCommit: (i) => { last = i; } }).mount(box2);
    click(box2.querySelector('[data-mode="id"]'));
    await flushMicrotasks();
    const input2 = box2.querySelector('.memo');
    click(box2.querySelector('.prepend'));
    await flushMicrotasks();
    assert.deepEqual(visiblePatches(last.patches).map((p) => p.type), ['INSERT']);
    assert.equal(box2.querySelectorAll('.memo')[1], input2, '입력칸이 주인(김정글)을 따라 두 번째 줄로');
    comp2.unmount();
  });

  /** 검색어별로 정해진 지연을 주는 가짜 서버 */
  const fixedFetcher = (delays) => (q) => new Promise((r) => setTimeout(() => r({ q, items: [], ms: delays[q] }), delays[q]));

  for (const safe of [false, true]) {
    test(`RaceApp: cleanup ${safe ? '있음 → 최신 결과 유지' : '없음 → 옛 응답이 덮어씀'}`, async () => {
      const box = container();
      const comp = new FunctionComponent(RaceApp, { fetcher: fixedFetcher({ re: 60, react: 5 }), initialSafe: safe }).mount(box);
      const input = box.querySelector('input.q');
      // flush(): 렌더와 useEffect 를 바로 실행 (화면 그리기를 기다리지 않음 → 타이밍이 흔들리지 않는다)
      typeIn(input, 're');
      comp.flush();
      typeIn(input, 'react');
      comp.flush();
      await sleep(120);
      await flushMicrotasks();
      const shown = box.querySelector('.shown-q').textContent;
      assert.equal(shown, safe ? '"react"' : '"re"', box.querySelector('.race-log').textContent);
      assert.equal(box.querySelector('.race-result').classList.contains('wrong'), !safe);
      if (safe) assert.ok(box.querySelector('.race-log li.ignored'));
      comp.unmount();
    });
  }

  test('ImmutableApp: 같은 배열로 setState 하면 렌더가 일어나지 않는다', async () => {
    const box = container();
    let memory = 1;
    const comp = new FunctionComponent(ImmutableApp, { onMemory: (n) => { memory = n; } }).mount(box);
    click(box.querySelector('.mutate'));
    click(box.querySelector('.mutate'));
    await flushMicrotasks();
    assert.equal(memory, 3);
    assert.equal(box.querySelector('.shown').textContent, '1');
    assert.equal(box.querySelector('.renders').textContent, '1');
    click(box.querySelector('.copy'));
    await flushMicrotasks();
    assert.equal(box.querySelector('.shown').textContent, '4', '몰래 들어간 2개 + 새 1개가 한꺼번에 보임');
    assert.equal(box.querySelector('.renders').textContent, '2');
    comp.unmount();
  });

  test('HookOrderApp: 조건부 Hook → 에러, 화면은 그대로 / 고친 버전은 정상', async () => {
    const box = container();
    let error = null;
    const calls = [];
    const comp = new FunctionComponent(HookOrderApp, { onCalls: (c) => calls.push(c) }, { onError: (e) => { error = e; } }).mount(box);
    const before = box.innerHTML;
    click(box.querySelector('.toggle-on'));
    await flushMicrotasks();
    assert.match(error.message, /Hook 호출 순서가 바뀌었습니다: 1번째 Hook 이 useState → useRef/);
    assert.equal(box.innerHTML, before);
    assert.equal(hookSlots(calls[0], calls[1] ?? ['useState:on', 'useRef:memo'])[1].status, 'mismatch');
    comp.unmount();

    const box2 = container();
    let error2 = null;
    const comp2 = new FunctionComponent(HookOrderApp, { fixed: true }, { onError: (e) => { error2 = e; } }).mount(box2);
    click(box2.querySelector('.toggle-on'));
    await flushMicrotasks();
    click(box2.querySelector('.inc'));
    await flushMicrotasks();
    assert.equal(error2, null);
    assert.match(box2.querySelector('.inc').textContent, /n = 1, n×2 = 2/);
    comp2.unmount();
  });
});

describe('페이지', () => {
  const html = readFileSync(new URL('../deepdive/index.html', import.meta.url), 'utf8');
  test('12개 주제마다 이해 체크가 있고 목차와 id 가 맞는다', () => {
    const ids = [...html.matchAll(/<section class="card deep" id="([^"]+)"/g)].map((m) => m[1]);
    const checks = [...html.matchAll(/class="got-it" data-id="([^"]+)"/g)].map((m) => m[1]);
    const toc = [...html.matchAll(/<a href="#([^"]+)">\d+\./g)].map((m) => m[1]);
    assert.equal(ids.length, 12);
    assert.deepEqual(checks, ids);
    assert.deepEqual(toc, ids);
  });
  test('실험이 쓰는 요소가 HTML 에 모두 있다', () => {
    const main = readFileSync(new URL('../deepdive/main.js', import.meta.url), 'utf8');
    const used = new Set([...main.matchAll(/\$\('#([\w-]+)/g)].map((m) => m[1]));
    for (const m of main.matchAll(/safeMount\('([\w-]+)'/g)) used.add(m[1]);
    for (const id of used) assert.ok(html.includes(`id="${id}"`), id);
  });
});
