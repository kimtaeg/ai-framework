// 대시보드의 루트 컴포넌트. Hook은 여기서만 쓴다.
//
// ■ State를 루트에 두는 이유 (Lifting State Up)
//   필터를 바꾸면 표가, 주문이 들어오면 카드·표·차트가 함께 바뀐다. 여러 컴포넌트가 같은 데이터를 보므로
//   데이터는 공통 조상(App) 한 곳에 두고, 자식에게는 props로 "값"과 "바꾸는 함수"를 내려 준다.
//   자식은 props → VNode 순수 함수라서 같은 props면 같은 화면이 나오고, 단독으로 테스트하기 쉽다.

import { h } from '../core/vdom.js';
import { useState, useEffect, useMemo } from '../core/hooks.js';
import { CATEGORIES, createRandom, createInitialDashboard, changeVisitors, addOrder, changeOneCategory, tick } from '../utils/fakeData.js';
import { formatNumber, formatWon } from './format.js';
import { Header } from './components/Header.js';
import { StatCard } from './components/StatCard.js';
import { FilterBar } from './components/FilterBar.js';
import { OrderTable } from './components/OrderTable.js';
import { MiniChart } from './components/MiniChart.js';
import { CategoryStats } from './components/CategoryStats.js';
import { ControlPanel } from './components/ControlPanel.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { '7d': 7, '30d': 30 };

// 기간 · 카테고리로 거르고 정렬한다 (원본 배열은 건드리지 않음)
export function selectOrders(orders, { category, period, sort }, now) {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const since = period === 'today' ? startOfToday : now - PERIOD_DAYS[period] * DAY_MS;
  const filtered = orders.filter((order) => order.createdAt >= since && (category === 'all' || order.category === category));
  const compare = sort === 'amount' ? (a, b) => b.amount - a.amount : (a, b) => b.createdAt - a.createdAt;
  return [...filtered].sort(compare);
}

export function summarizeCategories(orders) {
  return CATEGORIES.map((category) => {
    const items = orders.filter((order) => order.category === category);
    return { category, count: items.length, total: items.reduce((sum, order) => sum + order.amount, 0) };
  });
}

// 바깥 의존성(난수, 현재 시각, 타이머)을 주입받는다 → 테스트에서 결과·타이머를 고정할 수 있다
export function createApp({
  random = createRandom(),
  now = () => Date.now(),
  timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) },
  initialDark = false,
} = {}) {
  return function App() {
    // ── state: 모두 루트에 ──
    const [data, setData] = useState(() => createInitialDashboard(random, now()));
    const [category, setCategory] = useState('all');
    const [period, setPeriod] = useState('30d');
    const [sort, setSort] = useState('latest');
    const [darkMode, setDarkMode] = useState(initialDark);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [refreshMs, setRefreshMs] = useState(2000);

    // ── 핸들러: 처음 한 번만 만든다 (deps []) ──
    // 렌더마다 새 함수를 만들면 diff가 "onClick이 바뀌었다"고 보고 버튼마다 UPDATE_PROPS가 생긴다.
    // setState는 사물함에 고정된 같은 함수이고, 값은 setState(prev => next)로 최신 것을 받으므로 한 번 만들어도 된다.
    const handlers = useMemo(() => ({
      onToggleDark: () => setDarkMode((on) => !on),
      onToggleAuto: () => setAutoRefresh((on) => !on),
      onChangeRefresh: (event) => setRefreshMs(Number(event.target.value)),
      onCategory: (event) => setCategory(event.target.value),
      onPeriod: (event) => setPeriod(event.target.value),
      onSort: (event) => setSort(event.target.value),
      onVisitors: () => setData((d) => changeVisitors(d, random)),
      onAddOrder: () => setData((d) => addOrder(d, random, now())),
      onChangeCategory: () => setData((d) => changeOneCategory(d, random)),
      // setState 3번을 한 핸들러에서: 배칭이 켜져 있으면 렌더 1번, 꺼져 있으면 3번
      onTripleSetState: () => {
        setData((d) => changeVisitors(d, random));
        setData((d) => addOrder(d, random, now()));
        setData((d) => changeOneCategory(d, random));
      },
      onTick: () => setData((d) => tick(d, random, now())),
    }), []);

    // ── useMemo: 주문이나 조건이 바뀔 때만 다시 계산 ──
    const visibleOrders = useMemo(() => selectOrders(data.orders, { category, period, sort }, now()), [data.orders, category, period, sort]);
    const categoryRows = useMemo(() => summarizeCategories(data.orders), [data.orders]);

    // ── useEffect: 렌더 결과가 화면에 반영된 뒤 바깥세상과 맞춘다 ──
    // 자동 새로고침: 켜져 있을 때만 interval 1개. 끄거나 주기를 바꾸면 cleanup이 먼저 옛 interval을 지운다 → 중복 없음
    useEffect(() => {
      if (!autoRefresh) return undefined;
      const id = timers.setInterval(() => setData((d) => tick(d, random, now())), refreshMs);
      return () => timers.clearInterval(id);
    }, [autoRefresh, refreshMs]);

    useEffect(() => {
      document.title = `방문자 ${formatNumber(data.visitors)}명 · 미니 대시보드`;
    }, [data.visitors]);

    // 다크모드: body 클래스 (페이지 전체 색 토큰을 바꾼다)
    useEffect(() => {
      document.body.classList.toggle('theme-dark', darkMode);
      document.body.classList.toggle('theme-light', !darkMode);
    }, [darkMode]);

    return h(
      'div',
      { class: 'dash' },
      h(Header, { darkMode, autoRefresh, refreshMs, onToggleDark: handlers.onToggleDark, onToggleAuto: handlers.onToggleAuto, onChangeRefresh: handlers.onChangeRefresh }),
      h('div', { class: 'stat-grid' },
        h(StatCard, { label: '실시간 방문자', value: data.visitors, prevValue: data.prev.visitors, format: (n) => `${formatNumber(n)}명` }),
        h(StatCard, { label: '매출', value: data.revenue, prevValue: data.prev.revenue, format: formatWon }),
        h(StatCard, { label: '주문 수', value: data.orderCount, prevValue: data.prev.orderCount, format: (n) => `${formatNumber(n)}건` })),
      h(ControlPanel, handlers),
      h(FilterBar, { category, period, sort, categories: CATEGORIES, onCategory: handlers.onCategory, onPeriod: handlers.onPeriod, onSort: handlers.onSort }),
      h('div', { class: 'dash-grid' },
        h(OrderTable, { orders: visibleOrders, totalCount: data.orders.length }),
        h('div', { class: 'dash-side' },
          h(MiniChart, { points: data.salesHistory }),
          h(CategoryStats, { rows: categoryRows })))
    );
  };
}
