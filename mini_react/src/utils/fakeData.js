// 대시보드용 가짜 데이터 생성기.
// 모든 함수는 기존 데이터를 고치지 않고 "새 객체"를 돌려준다 (불변 업데이트).
// 그래야 setState의 Object.is 비교와 useMemo의 deps 비교가 "바뀌었는지"를 정확히 알아챈다.

export const CATEGORIES = ['전자기기', '의류', '식품', '도서'];
export const MAX_ORDERS = 12; // 주문 목록은 최근 N개만 유지
const CHART_POINTS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const CUSTOMERS = ['김정글', '이크래', '박프톤', '최리액', '정돔', '한훅스', '오배칭', '서패치'];

// 시드를 받는 간단한 난수 생성기 (같은 시드 → 같은 순서). 테스트에서 결과를 고정하려고 쓴다
export function createRandom(seed = Date.now()) {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];
const between = (random, min, max) => Math.floor(min + random() * (max - min + 1));

export function createOrder(random, id, createdAt = Date.now()) {
  return {
    id: `#${id}`,
    customer: pick(random, CUSTOMERS),
    category: pick(random, CATEGORIES),
    amount: between(random, 8, 320) * 1000,
    createdAt,
  };
}

export function createInitialDashboard(random, now = Date.now()) {
  // 처음 주문들은 최근 30일 안에 흩어 놓아 "오늘 / 7일 / 30일" 필터가 의미 있게 한다
  const orders = Array.from({ length: 8 }, (_, i) => createOrder(random, 1001 + i, now - between(random, 0, 29) * DAY_MS - i * 60_000))
    .sort((a, b) => b.createdAt - a.createdAt);
  const revenue = orders.reduce((sum, order) => sum + order.amount, 0);
  const visitors = between(random, 80, 140);
  return {
    visitors,
    revenue,
    orderCount: orders.length,
    prev: { visitors, revenue, orderCount: orders.length }, // StatCard의 증감 표시용 "직전 값"
    orders,
    // 차트 점마다 id를 둔다 → 막대 리스트를 key로 비교해, 한 칸 밀릴 때 "삭제 1 + 추가 1"로 끝나게
    salesHistory: Array.from({ length: CHART_POINTS }, (_, i) => ({ id: i + 1, amount: between(random, 200, 900) * 1000 })),
    nextId: 1001 + orders.length,
  };
}

// 방문자 수만 바꾼다 (다른 필드는 같은 참조를 그대로 둔다)
export function changeVisitors(data, random) {
  const delta = between(random, -12, 18) || 5;
  return { ...data, visitors: Math.max(0, data.visitors + delta), prev: { ...data.prev, visitors: data.visitors } };
}

// 주문 1건 추가: 맨 위에 넣고 최대 개수를 넘으면 가장 오래된 것을 뺀다. 매출·주문 수·차트도 함께 갱신
export function addOrder(data, random, now = Date.now()) {
  const order = createOrder(random, data.nextId, now);
  const lastPoint = data.salesHistory.at(-1);
  const salesHistory = [...data.salesHistory.slice(1), { id: (lastPoint?.id ?? 0) + 1, amount: order.amount }];
  return {
    ...data,
    revenue: data.revenue + order.amount,
    orderCount: data.orderCount + 1,
    prev: { ...data.prev, revenue: data.revenue, orderCount: data.orderCount },
    orders: [order, ...data.orders].slice(0, MAX_ORDERS),
    salesHistory,
    nextId: data.nextId + 1,
  };
}

// 가장 최근 주문 하나의 카테고리만 다른 것으로 바꾼다
export function changeOneCategory(data, random) {
  if (data.orders.length === 0) return data;
  const [first, ...rest] = data.orders;
  const others = CATEGORIES.filter((category) => category !== first.category);
  return { ...data, orders: [{ ...first, category: pick(random, others) }, ...rest] };
}

// 자동 새로고침 한 번: 방문자 변화 + (가끔) 새 주문
export function tick(data, random, now = Date.now()) {
  const withVisitors = changeVisitors(data, random);
  return random() < 0.6 ? addOrder(withVisitors, random, now) : withVisitors;
}
