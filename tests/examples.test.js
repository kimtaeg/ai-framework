/**
 * 기능 테스트: Phase 1 예시 케이스 + 예제 앱 5개
 */
import './setup.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Playground } from '../phase1/playground.js';
import { PRESETS } from '../phase1/presets.js';
import { childrenToHTML, createElement } from '../src/lib/vdom.js';
import { FunctionComponent } from '../src/lib/component.js';
import {
  CartApp, FormApp, KanbanApp, ListApp, StopwatchApp,
  validate, passwordScore, kanbanReducer, KANBAN_CARDS, formatMs,
} from '../examples/apps.js';
import { container, flushMicrotasks } from './setup.js';

const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const input = (node, value) => { node.value = value; fire(node, 'input'); };
const types = (patches) => [...new Set(patches.map((p) => p.type))].sort();

// ================================================================ Phase 1 예시 케이스
describe('Phase 1 예시 케이스', () => {
  const page = readFileSync(new URL('../phase1/index.html', import.meta.url), 'utf8');
  const sample = page.match(/<div id="actual" class="sample">([\s\S]*?)<\/div>\s*<div id="overlay"/)[1];
  let actual, pg;
  beforeEach(() => {
    actual = container(sample);
    pg = new Playground({ actualRoot: actual, renderTestArea: () => {} });
    pg.init();
  });
  const run = (id) => pg.patch(PRESETS.find((p) => p.id === id).apply(pg.current), id);

  const expected = { text: ['TEXT'], props: ['PROPS'], insert: ['INSERT'], remove: ['REMOVE'], replace: ['REPLACE'], move: ['MOVE'], row: ['INSERT'] };
  for (const [id, want] of Object.entries(expected)) {
    test(`${id} → ${want.join(', ')} 패치만 생긴다`, () => {
      const r = run(id);
      assert.deepEqual(types(r.patches), want);
    });
  }

  test('점수 올리기: TEXT + SVG width PROPS', () => {
    assert.deepEqual(types(run('score').patches), ['PROPS', 'TEXT']);
  });

  test('복합 변경은 여러 종류가 섞인다', () => {
    const t = types(run('combo').patches);
    for (const k of ['TEXT', 'PROPS', 'INSERT', 'MOVE']) assert.ok(t.includes(k), k);
  });

  test('모든 케이스 적용 후 실제 영역 == 새 VDOM 을 처음부터 그린 결과', () => {
    for (const p of PRESETS) for (let i = 0; i < 3; i++) run(p.id);
    const fresh = document.createElement('div');
    fresh.append(...pg.current.children.map((c) => createElement(c)));
    assert.equal(actual.innerHTML, fresh.innerHTML);
  });

  test('토글 케이스는 두 번 누르면 원래대로', () => {
    const before = childrenToHTML(pg.current);
    run('text'); run('text');
    run('props'); run('props');
    run('replace'); run('replace');
    assert.equal(childrenToHTML(pg.current), before);
  });

  test('대상이 없으면 null (사용자가 지운 경우)', () => {
    pg.patch({ type: 'div', props: {}, key: null, children: [] });
    for (const p of PRESETS) assert.equal(p.apply(pg.current), null, p.id);
  });
});

// ================================================================ 예제 앱
function mountApp(App) {
  const el = container();
  const commits = [];
  const comp = new FunctionComponent(App, {}, { onCommit: (c) => commits.push(c) }).mount(el);
  return { el, comp, commits, last: () => commits.at(-1) };
}

describe('예제: 장바구니', () => {
  test('수량 변경은 TEXT 패치만, 합계 재계산', async () => {
    const { el, last } = mountApp(CartApp);
    assert.equal(el.querySelector('.cart-total').textContent, '165,000원'); // 89,000 + 32,000×2 + 12,000, 5만원 이상이라 배송비 0
    el.querySelector('.cart-row .inc').click();
    await flushMicrotasks();
    assert.equal(el.querySelector('.qty-n').textContent, '2');
    assert.ok(types(last().patches).every((t) => t === 'TEXT' || t === 'PROPS'));
    assert.ok(last().patches.some((p) => p.type === 'TEXT'));
  });

  test('쿠폰 적용 → 할인 줄 INSERT, 잘못된 쿠폰 → 에러 메시지', async () => {
    const { el, last } = mountApp(CartApp);
    const field = el.querySelector('.coupon input');
    input(field, 'jungle10');
    await flushMicrotasks();
    fire(el.querySelector('.coupon'), 'submit');
    await flushMicrotasks();
    assert.ok(el.querySelector('.discount'));
    assert.ok(last().patches.some((p) => p.type === 'INSERT'));
    input(field, 'nope');
    await flushMicrotasks();
    fire(el.querySelector('.coupon'), 'submit');
    await flushMicrotasks();
    assert.equal(el.querySelector('.discount'), null);
    assert.equal(el.querySelector('.msg.bad').textContent, '없는 쿠폰입니다');
  });

  test('모두 삭제 → 빈 장바구니로 교체, 다시 담기', async () => {
    const { el } = mountApp(CartApp);
    for (let i = 0; i < 3; i++) {
      el.querySelector('.remove').click();
      await flushMicrotasks();
    }
    assert.ok(el.querySelector('.empty'));
    assert.equal(el.querySelector('.cart-total').textContent, '0원');
    el.querySelector('.restore').click();
    await flushMicrotasks();
    assert.equal(el.querySelectorAll('.cart-row').length, 3);
  });

  test('배송비: 5만원 미만이면 3,000원', async () => {
    const { el } = mountApp(CartApp);
    el.querySelectorAll('.remove')[0].click(); // 키보드 삭제 → 64000 + 12000 = 76000
    await flushMicrotasks();
    el.querySelectorAll('.remove')[0].click(); // 마우스 삭제 → 12000
    await flushMicrotasks();
    assert.equal(el.querySelector('.cart-total').textContent, '15,000원');
  });
});

describe('예제: 회원가입 폼', () => {
  test('validate / passwordScore', () => {
    assert.deepEqual(Object.keys(validate({ name: '', email: 'x', password: 'short', confirm: '', agree: false })).sort(), ['agree', 'confirm', 'email', 'name', 'password']);
    assert.deepEqual(validate({ name: '김정글', email: 'a@b.co', password: 'abcd1234', confirm: 'abcd1234', agree: true }), {});
    assert.equal(passwordScore(''), 0);
    assert.equal(passwordScore('abcd1234!xyz'), 4);
  });

  test('입력해도 input 노드가 유지되고(포커스 유지), blur 하면 class 만 바뀐다', async () => {
    const { el, last } = mountApp(FormApp);
    const name = el.querySelector('input[name=name]');
    input(name, '김');
    await flushMicrotasks();
    assert.equal(el.querySelector('input[name=name]'), name);
    fire(name, 'blur');
    await flushMicrotasks();
    assert.ok(name.closest('.field').classList.contains('invalid'));
    assert.ok(last().patches.some((p) => p.type === 'PROPS' && p.changes.some((c) => c.name === 'class')));
  });

  test('모두 올바르게 입력 → 가입 → 환영 화면(REPLACE) → 다시 작성', async () => {
    const { el, last } = mountApp(FormApp);
    const set = async (n, v) => { input(el.querySelector(`input[name=${n}]`), v); await flushMicrotasks(); };
    await set('name', '김정글');
    await set('email', 'jungle@example.com');
    await set('password', 'abcd1234');
    await set('confirm', 'abcd1234');
    const agree = el.querySelector('.agree input');
    agree.checked = true;
    fire(agree, 'change');
    await flushMicrotasks();
    assert.ok(el.querySelector('.submit').textContent === '가입하기');
    fire(el.querySelector('form'), 'submit');
    await flushMicrotasks();
    assert.ok(el.querySelector('.form-done').textContent.includes('김정글님'));
    assert.ok(last().patches.some((p) => p.type === 'REPLACE'));
    el.querySelector('.again').click();
    await flushMicrotasks();
    assert.equal(el.querySelector('input[name=name]').value, '');
  });

  test('비어 있는 채로 제출하면 모든 칸에 에러 표시', async () => {
    const { el } = mountApp(FormApp);
    fire(el.querySelector('form'), 'submit');
    await flushMicrotasks();
    assert.equal(el.querySelectorAll('.field.invalid').length, 4);
    assert.ok(el.querySelector('.agree.invalid'));
  });
});

describe('예제: 칸반 보드', () => {
  test('reducer: 추가 / 열 이동 / 순서 / 삭제 / 경계', () => {
    let s = kanbanReducer(KANBAN_CARDS, { type: 'add', title: '새 카드' });
    assert.equal(s.at(-1).col, 'todo');
    s = kanbanReducer(s, { type: 'column', id: 5, dir: 1 });
    assert.equal(s.find((c) => c.id === 5).col, 'doing');
    assert.equal(kanbanReducer(KANBAN_CARDS, { type: 'column', id: 1, dir: 1 }), KANBAN_CARDS, '오른쪽 끝에서 더 못 감');
    const o = kanbanReducer(KANBAN_CARDS, { type: 'order', id: 6, dir: -1 });
    assert.deepEqual(o.filter((c) => c.col === 'todo').map((c) => c.id), [6, 5]);
    assert.equal(kanbanReducer(KANBAN_CARDS, { type: 'order', id: 5, dir: -1 }), KANBAN_CARDS, '맨 위에서 더 못 감');
    assert.equal(kanbanReducer(KANBAN_CARDS, { type: 'remove', id: 1 }).length, 5);
  });

  test('같은 열 안 이동 → MOVE (카드 노드 재사용)', async () => {
    const { el, last } = mountApp(KanbanApp);
    const todo = () => [...el.querySelectorAll('.kcol.todo .kcard')];
    const [first, second] = todo();
    second.querySelector('[title=위로]').click();
    await flushMicrotasks();
    assert.equal(todo()[0], second, '같은 DOM 노드가 옮겨짐');
    assert.equal(todo()[1], first);
    assert.ok(last().patches.some((p) => p.type === 'MOVE'));
  });

  test('다른 열로 이동 → REMOVE + INSERT', async () => {
    const { el, last } = mountApp(KanbanApp);
    el.querySelector('.kcol.todo .kcard [title="오른쪽 열로"]').click();
    await flushMicrotasks();
    const t = types(last().patches);
    assert.ok(t.includes('REMOVE') && t.includes('INSERT'));
    assert.equal(el.querySelectorAll('.kcol.doing .kcard').length, 3);
  });

  test('열이 비면 "비어 있음"으로 교체', async () => {
    const { el } = mountApp(KanbanApp);
    for (let i = 0; i < 2; i++) {
      el.querySelector('.kcol.done .kcard [title=삭제]').click();
      await flushMicrotasks();
    }
    assert.ok(el.querySelector('.kcol.done .kempty'));
  });
});

describe('예제: 1,000행 리스트', () => {
  test('1,000행 렌더, 한 명 점수 +1 → DOM 변경 최소', async () => {
    const { el, last } = mountApp(ListApp);
    assert.equal(el.querySelectorAll('tbody tr').length, 1000);
    const observer = new MutationObserver(() => {});
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    el.querySelector('.bump').click();
    await flushMicrotasks();
    const mutations = observer.takeRecords().length;
    observer.disconnect();
    assert.ok(mutations <= 3, `DOM 변경 ${mutations}건`);
    assert.ok(last().patches.some((p) => p.type === 'TEXT'));
  });

  test('검색 → REMOVE, 정렬 → MOVE', async () => {
    const { el, last } = mountApp(ListApp);
    input(el.querySelector('input[type=search]'), '김민준');
    await flushMicrotasks();
    assert.ok(el.querySelectorAll('tbody tr').length < 1000);
    assert.ok(last().patches.some((p) => p.type === 'REMOVE'));
    input(el.querySelector('input[type=search]'), '');
    await flushMicrotasks();
    const sort = el.querySelectorAll('select')[1];
    sort.value = 'score';
    fire(sort, 'change');
    await flushMicrotasks();
    assert.ok(last().patches.some((p) => p.type === 'MOVE'));
    const scores = [...el.querySelectorAll('tbody .score')].slice(0, 20).map((n) => Number(n.textContent));
    assert.deepEqual(scores, scores.slice().sort((a, b) => b - a));
  });
});

describe('예제: 스톱워치', () => {
  test('formatMs', () => {
    assert.equal(formatMs(0), '00:00.00');
    assert.equal(formatMs(61234), '01:01.23');
  });

  test('시작 → 시간 흐름(TEXT) → 랩(INSERT) → 정지 시 interval 해제 → 리셋', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { el, comp } = mountApp(StopwatchApp);
    el.querySelector('.sw-toggle').click();
    await flushMicrotasks();
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal(el.querySelector('.sw-time').textContent.slice(0, 5), '00:01');
    el.querySelector('.sw-lap').click();
    await flushMicrotasks();
    assert.equal(el.querySelectorAll('.laps li').length, 1);
    el.querySelector('.sw-toggle').click(); // 정지
    await flushMicrotasks();
    const renders = comp.renderCount;
    t.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(comp.renderCount, renders, 'cleanup 으로 interval 이 해제되어 더 이상 렌더링 안 됨');
    el.querySelector('.sw-reset').click();
    await flushMicrotasks();
    assert.equal(el.querySelector('.sw-time').textContent, '00:00.00');
    assert.ok(el.querySelector('.lap-empty'));
  });
});

// ================================================================ 일부러 망가뜨리기 실험
import { flags, clearLeakedTimers, EXPERIMENTS } from '../examples/experiments.js';
import { afterEach } from 'node:test';

describe('실험: 일부러 망가뜨리기', () => {
  afterEach(() => {
    for (const k of Object.keys(flags)) flags[k] = false;
    clearLeakedTimers();
  });
  const mountWith = (App) => {
    const el = container();
    const errors = [];
    const commits = [];
    const comp = new FunctionComponent(App, {}, { onCommit: (c) => commits.push(c), onError: (e) => errors.push(e) }).mount(el);
    return { el, comp, errors, last: () => commits.at(-1) };
  };

  test('모든 실험에 설명 필드가 있고 flag 와 1:1', () => {
    assert.deepEqual(EXPERIMENTS.map((e) => e.id).sort(), Object.keys(flags).sort());
    for (const e of EXPERIMENTS) for (const k of ['title', 'concept', 'before', 'after', 'try', 'watch', 'why']) assert.ok(e[k], `${e.id}.${k}`);
  });

  test('불변성 깨기: + 를 눌러도 렌더링 안 됨, 나중에 렌더되면 합계가 옛날 값', async () => {
    flags.cartMutate = true;
    const { el, comp } = mountWith(CartApp);
    const r0 = comp.renderCount;
    el.querySelector('.cart-row .inc').click();
    await flushMicrotasks();
    assert.equal(comp.renderCount, r0, '같은 배열 → bail-out');
    assert.equal(el.querySelector('.qty-n').textContent, '1');
    input(el.querySelector('.coupon input'), 'x'); // 다른 이유로 렌더
    await flushMicrotasks();
    assert.equal(el.querySelector('.qty-n').textContent, '2', '수정된 수량은 이제 보임');
    assert.equal(el.querySelector('.cart-total').textContent, '165,000원', 'useMemo 는 [items] 참조가 같아 재계산 안 함');
  });

  test('불변성 깨기를 해도 원본 상품 데이터는 오염되지 않는다 (복구 후 정상)', async () => {
    flags.cartMutate = true;
    const a = mountWith(CartApp);
    a.el.querySelector('.cart-row .inc').click();
    await flushMicrotasks();
    flags.cartMutate = false;
    const b = mountWith(CartApp);
    assert.equal(b.el.querySelector('.qty-n').textContent, '1');
    assert.equal(b.el.querySelector('.cart-total').textContent, '165,000원');
  });

  test('자식에서 Hook: 마운트 시 루트 전용 에러', () => {
    flags.cartHookInChild = true;
    assert.throws(() => new FunctionComponent(CartApp).mount(container()), /최상위\(루트\) 컴포넌트에서만/);
  });

  test('조건부 Hook: 이름 3글자째에 onError 로 에러 전달, 화면은 마지막 상태 유지', async () => {
    flags.formConditionalHook = true;
    const { el, errors } = mountWith(FormApp);
    const name = el.querySelector('input[name=name]');
    input(name, '김정');
    await flushMicrotasks();
    assert.equal(errors.length, 0);
    input(name, '김정글');
    await flushMicrotasks();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Hook 호출 개수/);
  });

  test('key 지우기: ▲ 가 MOVE 대신 TEXT 로', async () => {
    flags.kanbanNoKey = true;
    const { el, last } = mountWith(KanbanApp);
    const cards = () => [...el.querySelectorAll('.kcol.todo .kcard')];
    const [first] = cards();
    cards()[1].querySelector('[title=위로]').click();
    await flushMicrotasks();
    const t = types(last().patches);
    assert.ok(!t.includes('MOVE'));
    assert.ok(t.includes('TEXT'));
    assert.equal(cards()[0], first, '노드는 제자리, 내용만 바뀜');
    assert.equal(cards()[0].querySelector('.ktitle').textContent, '발표 자료');
  });

  test('useMemo 끄기: 관계없는 리렌더마다 계산 횟수 증가 (정상일 땐 그대로)', async () => {
    const count = (el) => Number(el.querySelector('.calc').textContent.match(/계산 (\d+)회/)[1]);
    const normal = mountWith(ListApp);
    normal.el.querySelector('.rerender').click();
    await flushMicrotasks();
    normal.el.querySelector('.rerender').click();
    await flushMicrotasks();
    assert.equal(count(normal.el), 1);
    flags.listNoMemo = true;
    const broken = mountWith(ListApp);
    broken.el.querySelector('.rerender').click();
    await flushMicrotasks();
    broken.el.querySelector('.rerender').click();
    await flushMicrotasks();
    assert.equal(count(broken.el), 3);
  });

  test('cleanup 지우기: 정지해도 계속 렌더링, clearLeakedTimers 로 정리', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    flags.stopwatchNoCleanup = true;
    const { el, comp } = mountWith(StopwatchApp);
    el.querySelector('.sw-toggle').click();
    await flushMicrotasks();
    el.querySelector('.sw-toggle').click(); // 정지
    await flushMicrotasks();
    const r = comp.renderCount;
    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.ok(comp.renderCount > r, '해제되지 않은 interval 이 계속 setState');
    clearLeakedTimers();
    const r2 = comp.renderCount;
    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.equal(comp.renderCount, r2);
  });

  test('랩 key 를 index 로: 맨 앞 추가 시 기존 노드에 새 내용을 덮어씀', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const run = async () => {
      const { el } = mountWith(StopwatchApp);
      el.querySelector('.sw-toggle').click();
      await flushMicrotasks();
      t.mock.timers.tick(100);
      await flushMicrotasks();
      el.querySelector('.sw-lap').click();
      await flushMicrotasks();
      const firstLi = el.querySelector('.laps li');
      t.mock.timers.tick(100);
      await flushMicrotasks();
      el.querySelector('.sw-lap').click();
      await flushMicrotasks();
      const lis = [...el.querySelectorAll('.laps li')];
      el.querySelector('.sw-toggle').click();
      await flushMicrotasks();
      return { firstLi, lis };
    };
    const normal = await run();
    assert.equal(normal.lis[1], normal.firstLi, 'id key: 기존 랩 1 노드가 아래로 밀림');
    flags.stopwatchIndexKey = true;
    const broken = await run();
    assert.equal(broken.lis[0], broken.firstLi, 'index key: 맨 위 노드가 재사용되어 랩 2 내용으로 덮어써짐');
    assert.ok(broken.lis[0].textContent.startsWith('랩 2'));
  });
});
