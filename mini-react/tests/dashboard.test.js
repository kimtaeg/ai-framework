import { makeContainer } from './setup.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionComponent } from '../src/core/component.js';
import { createApp, selectOrders } from '../src/app/App.js';
import { createRandom, MAX_ORDERS } from '../src/utils/fakeData.js';
import { Header } from '../src/app/components/Header.js';
import { StatCard } from '../src/app/components/StatCard.js';
import { FilterBar } from '../src/app/components/FilterBar.js';
import { OrderTable } from '../src/app/components/OrderTable.js';
import { MiniChart } from '../src/app/components/MiniChart.js';
import { ControlPanel } from '../src/app/components/ControlPanel.js';
import { CategoryStats } from '../src/app/components/CategoryStats.js';
import { RenderStats } from '../src/app/components/RenderStats.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = new Date('2026-11-10T15:00:00').getTime();

// 진짜 타이머 대신 "지금 살아 있는 interval"을 세는 가짜 타이머
function fakeTimers() {
  const active = new Map();
  let nextId = 1;
  return {
    active,
    setInterval(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    fireAll() {
      for (const { fn } of [...active.values()]) fn();
    },
  };
}

function mountDashboard(options = {}) {
  const container = makeContainer();
  const timers = fakeTimers();
  const renders = [];
  const App = createApp({ random: createRandom(42), now: () => NOW, timers });
  const component = new FunctionComponent(App, container, { onRender: (info) => renders.push(info), ...options }).mount();
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  const button = (text) => $$('button').find((b) => b.textContent.includes(text));
  const select = (label) => $$('label').find((l) => l.textContent.startsWith(label)).querySelector('select');
  const change = (selectEl, value) => {
    selectEl.value = value;
    selectEl.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const rows = () => $$('table.orders')[0].querySelectorAll('tbody tr');
  return { container, component, timers, renders, $, $$, button, select, change, rows, last: () => renders.at(-1) };
}

describe('대시보드: 처음 그리기', () => {
  test('카드 3개, 주문 8건, 차트 막대, 카테고리 4줄', () => {
    const { $$, rows } = mountDashboard();
    assert.equal($$('.stat').length, 3);
    assert.equal(rows().length, 8);
    assert.equal($$('.chart__bar').length, 12);
    assert.equal($$('table.orders')[1].querySelectorAll('tbody tr').length, 4);
  });

  test('document.title에 방문자 수, body에 테마 클래스 (useEffect)', () => {
    const { $$ } = mountDashboard();
    const visitors = $$('.stat__value')[0].textContent.replace('명', '');
    assert.match(document.title, new RegExp(`방문자 ${visitors}명`));
    assert.ok(document.body.classList.contains('theme-light'));
  });
});

describe('대시보드: 바뀐 부분만 patch', () => {
  test('방문자 수만 변경 → 방문자 카드 안의 글자·클래스만 바뀐다 (표·차트·버튼은 그대로)', async () => {
    const { button, last, $$, rows } = mountDashboard();
    const firstRow = rows()[0];
    const revenueText = $$('.stat__value')[1].textContent;
    button('방문자 수만 변경').click();
    await flush();
    const { patches } = last();
    assert.ok(patches.length >= 1 && patches.length <= 3, `patch ${patches.length}개`);
    for (const patch of patches) assert.deepEqual(patch.path.slice(0, 3), [1, 0, patch.path[2]], '모두 첫 번째 카드 안');
    assert.equal(rows()[0], firstRow);
    assert.equal($$('.stat__value')[1].textContent, revenueText);
  });

  test('주문 1건 추가 → 표에는 행 CREATE 1개, 기존 행 DOM은 재사용', async () => {
    const { button, last, rows } = mountDashboard();
    const oldFirst = rows()[0];
    button('주문 1건 추가').click();
    await flush();
    assert.equal(rows().length, 9);
    assert.equal(rows()[1], oldFirst);
    assert.equal(last().patches.filter((p) => p.type === 'CREATE' && p.vnode.type === 'tr').length, 1);
  });

  test('주문은 최대 N개까지만: 넘치면 가장 오래된 행이 빠진다', async () => {
    const { button, rows } = mountDashboard();
    for (let i = 0; i < MAX_ORDERS + 3; i++) {
      button('주문 1건 추가').click();
      await flush();
    }
    assert.equal(rows().length, MAX_ORDERS);
  });

  test('카테고리 하나만 변경 → UPDATE_TEXT 1개 (+ 카테고리별 표 숫자)', async () => {
    const { button, last } = mountDashboard();
    button('카테고리 하나만 변경').click();
    await flush();
    // 경로 [4, 0, ...] = 루트의 4번 자식(dash-grid) → 0번(주문 표)
    const inOrderTable = last().patches.filter((p) => p.path?.[0] === 4 && p.path[1] === 0);
    assert.equal(inOrderTable.length, 1);
    assert.equal(inOrderTable[0].type, 'UPDATE_TEXT');
  });

  test('핸들러는 한 번만 만들어 둬서, 렌더가 거듭돼도 onClick 때문에 UPDATE_PROPS가 생기지 않는다', async () => {
    const { button, last } = mountDashboard();
    button('방문자 수만 변경').click();
    await flush();
    const eventPatches = last().patches.filter((p) => p.type === 'UPDATE_PROPS' && Object.keys(p.set).some((k) => k.startsWith('on')));
    assert.equal(eventPatches.length, 0);
  });
});

describe('대시보드: 필터 · 정렬 (useMemo)', () => {
  test('결과 0건이면 빈 상태 메시지, 다시 전체로 돌리면 행이 돌아온다', async () => {
    const { select, change, rows, $ } = mountDashboard();
    // 시드 42의 처음 주문 8건에는 '전자기기'가 없다
    change(select('카테고리'), '전자기기');
    await flush();
    assert.equal(rows().length, 1);
    assert.equal($('.orders__empty').textContent, '조건에 맞는 주문이 없습니다.');
    change(select('카테고리'), 'all');
    change(select('기간'), '30d');
    await flush();
    assert.equal(rows().length, 8);
    assert.equal($('.orders__empty'), null);
  });

  test('selectOrders: 기간·카테고리·정렬 (원본은 그대로)', () => {
    const day = 24 * 60 * 60 * 1000;
    const orders = [
      { id: 'a', category: '의류', amount: 1000, createdAt: NOW - 1000 },
      { id: 'b', category: '도서', amount: 9000, createdAt: NOW - 3 * day },
      { id: 'c', category: '의류', amount: 5000, createdAt: NOW - 20 * day },
    ];
    const ids = (list) => list.map((o) => o.id);
    assert.deepEqual(ids(selectOrders(orders, { category: 'all', period: 'today', sort: 'latest' }, NOW)), ['a']);
    assert.deepEqual(ids(selectOrders(orders, { category: 'all', period: '7d', sort: 'amount' }, NOW)), ['b', 'a']);
    assert.deepEqual(ids(selectOrders(orders, { category: '의류', period: '30d', sort: 'amount' }, NOW)), ['c', 'a']);
    assert.deepEqual(ids(orders), ['a', 'b', 'c']);
  });

  test('정렬만 바꾸면 행이 MOVE로 자리만 바뀐다 (새로 만들지 않음)', async () => {
    const { select, change, last } = mountDashboard();
    change(select('정렬'), 'amount');
    await flush();
    const types = new Set(last().patches.map((p) => p.type));
    assert.ok(types.has('MOVE'));
    assert.ok(!types.has('CREATE') && !types.has('REMOVE'));
  });
});

describe('대시보드: 자동 새로고침 (useEffect + cleanup)', () => {
  test('시작 → interval 1개, 정지 → 0개, 재시작 → 다시 1개 (중복 없음)', async () => {
    const { button, timers } = mountDashboard();
    assert.equal(timers.active.size, 0);
    button('자동 새로고침').click();
    await flush();
    assert.equal(timers.active.size, 1);
    button('정지').click();
    await flush();
    assert.equal(timers.active.size, 0);
    button('자동 새로고침').click();
    await flush();
    assert.equal(timers.active.size, 1);
  });

  test('주기를 바꾸면 옛 interval을 지우고 새 주기로 1개만', async () => {
    const { button, timers, select, change } = mountDashboard();
    button('자동 새로고침').click();
    await flush();
    change(select('주기'), '5000');
    await flush();
    assert.equal(timers.active.size, 1);
    assert.equal([...timers.active.values()][0].ms, 5000);
  });

  test('새로고침 중 필터를 바꿔도 interval은 그대로 1개이고, tick 결과에 필터가 적용된다', async () => {
    const { button, timers, select, change, rows } = mountDashboard();
    button('자동 새로고침').click();
    await flush();
    const [id] = timers.active.keys();
    change(select('카테고리'), '의류');
    await flush();
    assert.deepEqual([...timers.active.keys()], [id]);
    for (let i = 0; i < 5; i++) {
      timers.fireAll();
      await flush();
    }
    for (const row of rows()) assert.equal(row.querySelector('.badge').textContent, '의류');
  });

  test('unmount하면 interval도 정리된다', async () => {
    const { button, timers, component } = mountDashboard();
    button('자동 새로고침').click();
    await flush();
    component.unmount();
    assert.equal(timers.active.size, 0);
  });
});

describe('대시보드: 다크모드 · 배칭', () => {
  test('다크모드 반복 토글: body 클래스가 마지막 상태와 같고 버튼 글자도 맞다', async () => {
    const { button } = mountDashboard();
    for (let i = 0; i < 5; i++) {
      (button('다크') ?? button('라이트')).click();
      await flush();
    }
    assert.ok(document.body.classList.contains('theme-dark'));
    assert.ok(!document.body.classList.contains('theme-light'));
    assert.ok(button('라이트'));
  });

  test('한 클릭에 setState 3번: 배칭 켜면 렌더 1번', async () => {
    const { button, component } = mountDashboard();
    const before = component.renderCount;
    button('setState 3번').click();
    await flush();
    assert.equal(component.renderCount - before, 1);
    assert.equal(component.lastBatchSize, 3);
  });

  test('한 클릭에 setState 3번: 배칭 끄면 렌더 3번', () => {
    const { button, component } = mountDashboard({ batching: false });
    const before = component.renderCount;
    button('setState 3번').click();
    assert.equal(component.renderCount - before, 3);
  });

  test('전체 다시 그리기 모드에서도 같은 화면이 나온다', async () => {
    const diffSide = mountDashboard();
    diffSide.button('주문 1건 추가').click();
    await flush();
    const expected = diffSide.container.innerHTML;
    const fullSide = mountDashboard({ renderMode: 'full' });
    fullSide.button('주문 1건 추가').click();
    await flush();
    assert.equal(fullSide.container.innerHTML, expected);
  });
});

describe('자식 컴포넌트는 props만 받는 순수 함수', () => {
  const noop = () => {};
  test('렌더 밖에서 직접 불러도 에러 없이 VNode를 돌려준다 (Hook을 쓰지 않는다는 증거)', () => {
    const outputs = [
      Header({ darkMode: false, autoRefresh: false, refreshMs: 2000, onToggleDark: noop, onToggleAuto: noop, onChangeRefresh: noop }),
      StatCard({ label: '방문자', value: 10, prevValue: 7, format: String }),
      FilterBar({ category: 'all', period: '7d', sort: 'latest', categories: ['의류'], onCategory: noop, onPeriod: noop, onSort: noop }),
      OrderTable({ orders: [], totalCount: 0 }),
      MiniChart({ points: [{ id: 1, amount: 100 }] }),
      ControlPanel({ onVisitors: noop, onAddOrder: noop, onChangeCategory: noop, onTripleSetState: noop, onTick: noop }),
      CategoryStats({ rows: [{ category: '의류', count: 0, total: 0 }] }),
      RenderStats({ info: null, mutations: { added: 0, removed: 0, attributes: 0, texts: 0, total: 0, nodes: 0 }, comparison: { diff: { renders: 0 }, full: { renders: 0 } }, renderMode: 'diff', batching: true, onRenderMode: noop, onBatching: noop }),
    ];
    for (const vnode of outputs) assert.equal(typeof vnode.type, 'string');
  });

  test('같은 props → 같은 결과 (StatCard 증감 표시)', () => {
    const card = (value, prevValue) => StatCard({ label: 'x', value, prevValue, format: String });
    assert.deepEqual(card(10, 7), card(10, 7));
    assert.equal(card(10, 7).children[2].children[0], '▲ 3');
    assert.equal(card(5, 7).children[2].children[0], '▼ 2');
    assert.equal(card(7, 7).children[2].children[0], '변화 없음');
  });
});
