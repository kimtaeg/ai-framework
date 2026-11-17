/**
 * miniReact 예제 앱 모음
 * ------------------------------------------------------------------
 * 각 앱은 독립된 루트 컴포넌트(FunctionComponent 하나)이고,
 * Phase 2 와 같은 규칙을 따른다: Hook 은 루트에서만, 자식은 props 만 받는 순수 함수.
 */
import { h } from '../src/lib/vdom.js';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useReducer, createContext, useContext } from '../src/lib/component.js';
import { flags, leakedTimers } from './experiments.js';

// 아래 코드에서 `flags.xxx` 가 나오는 곳이 "일부러 망가뜨리기" 실험 지점이다. (experiments.js)

const won = (n) => n.toLocaleString('ko-KR') + '원';

// ================================================================ 1. 장바구니
export const CART_PRODUCTS = [
  { id: 'kb', name: '기계식 키보드', price: 89000, qty: 1 },
  { id: 'ms', name: '무선 마우스', price: 32000, qty: 2 },
  { id: 'pad', name: '마우스 패드', price: 12000, qty: 1 },
];
const COUPONS = { JUNGLE10: 0.1, WELCOME20: 0.2 };

function CartRow({ item, onInc, onDec, onRemove }) {
  if (flags.cartHookInChild) useState(0); // [실험] 자식 컴포넌트에서 Hook 호출 → 에러
  return h('li', { class: 'cart-row' },
    h('span', { class: 'cart-name' }, item.name),
    h('span', { class: 'cart-price muted' }, won(item.price)),
    h('div', { class: 'qty' },
      h('button', { type: 'button', class: 'small dec', disabled: item.qty <= 1, onClick: () => onDec(item.id), 'aria-label': `${item.name} 수량 줄이기` }, '−'),
      h('b', { class: 'qty-n' }, item.qty),
      h('button', { type: 'button', class: 'small inc', disabled: item.qty >= 9, onClick: () => onInc(item.id), 'aria-label': `${item.name} 수량 늘리기` }, '+'),
    ),
    h('b', { class: 'cart-line' }, won(item.price * item.qty)),
    h('button', { type: 'button', class: 'ghost small danger remove', onClick: () => onRemove(item.id), 'aria-label': `${item.name} 삭제` }, '✕'),
  );
}

function CartSummary({ s }) {
  return h('div', { class: 'cart-summary' },
    h('div', null, h('span', null, '상품 금액'), h('span', null, won(s.subtotal))),
    s.discount > 0 && h('div', { class: 'discount' }, h('span', null, `쿠폰 할인 (${Math.round(s.rate * 100)}%)`), h('span', null, '−' + won(s.discount))),
    h('div', null, h('span', null, '배송비'), h('span', null, s.shipping === 0 ? '무료' : won(s.shipping))),
    h('div', { class: 'total' }, h('span', null, '결제 금액'), h('b', { class: 'cart-total' }, won(s.total))),
    s.subtotal > 0 && s.shipping > 0 && h('p', { class: 'hint-free muted' }, `${won(50000 - (s.subtotal - s.discount))} 더 담으면 무료배송`),
  );
}

const freshCart = () => CART_PRODUCTS.map((p) => ({ ...p }));

export function CartApp() {
  const [items, setItems] = useState(freshCart);
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState(null); // { code, rate } | null
  const [couponMsg, setCouponMsg] = useState('');

  const summary = useMemo(() => {
    const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    const rate = coupon?.rate ?? 0;
    const discount = Math.round(subtotal * rate);
    const shipping = subtotal === 0 || subtotal - discount >= 50000 ? 0 : 3000;
    return { subtotal, rate, discount, shipping, total: subtotal - discount + shipping };
  }, [items, coupon]);

  const clampQty = (q) => Math.min(9, Math.max(1, q));
  const update = (id, d) => {
    if (flags.cartMutate) {
      // [실험] 불변성 위반: 기존 객체를 직접 고치고 같은 배열을 다시 넣는다
      const item = items.find((it) => it.id === id);
      item.qty = clampQty(item.qty + d);
      setItems(items);
      return;
    }
    setItems((list) => list.map((it) => (it.id === id ? { ...it, qty: clampQty(it.qty + d) } : it)));
  };
  const applyCoupon = () => {
    const key = code.trim().toUpperCase();
    if (COUPONS[key]) {
      setCoupon({ code: key, rate: COUPONS[key] });
      setCouponMsg(`${key} 적용됨`);
    } else {
      setCoupon(null);
      setCouponMsg(key ? '없는 쿠폰입니다' : '쿠폰 코드를 입력하세요');
    }
  };

  return h('div', { class: 'cart' },
    items.length === 0
      ? h('div', { class: 'empty' }, '장바구니가 비었습니다. ', h('button', { type: 'button', class: 'small restore', onClick: () => setItems(freshCart()) }, '상품 다시 담기'))
      : h('ul', { class: 'cart-list' },
          items.map((it) => h(CartRow, { key: it.id, item: it, onInc: (id) => update(id, 1), onDec: (id) => update(id, -1), onRemove: (id) => setItems((l) => l.filter((x) => x.id !== id)) })),
        ),
    h('form', { class: 'coupon', onSubmit: (e) => { e.preventDefault(); applyCoupon(); } },
      h('input', { type: 'text', placeholder: '쿠폰 (JUNGLE10, WELCOME20)', value: code, onInput: (e) => setCode(e.target.value), 'aria-label': '쿠폰 코드' }),
      h('button', { type: 'submit' }, '적용'),
      couponMsg && h('span', { class: coupon ? 'msg ok' : 'msg bad' }, couponMsg),
    ),
    h(CartSummary, { s: summary }),
  );
}

// ================================================================ 2. 회원가입 폼 검증
const EMPTY_FORM = { name: '', email: '', password: '', confirm: '', agree: false };

export function validate(v) {
  const e = {};
  if (v.name.trim().length < 2) e.name = '이름은 2글자 이상';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) e.email = '이메일 형식이 아닙니다';
  if (v.password.length < 8) e.password = '8자 이상';
  else if (!/\d/.test(v.password) || !/[a-zA-Z]/.test(v.password)) e.password = '영문과 숫자를 섞어 주세요';
  if (v.confirm !== v.password || !v.confirm) e.confirm = '비밀번호가 일치하지 않습니다';
  if (!v.agree) e.agree = '약관에 동의해 주세요';
  return e;
}

export function passwordScore(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/\d/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return s; // 0~4
}

function Field({ label, name, type = 'text', value, error, show, onInput, onBlur, children }) {
  return h('label', { class: show && error ? 'field invalid' : show ? 'field valid' : 'field' },
    h('span', { class: 'field-label' }, label),
    h('input', { type, name, value, autocomplete: 'off', onInput: (e) => onInput(name, e.target.value), onBlur: () => onBlur(name), 'aria-invalid': String(Boolean(show && error)) }),
    children,
    h('span', { class: 'field-msg' }, show ? error ?? '좋아요 ✓' : ''),
  );
}

export function FormApp() {
  const [values, setValues] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState({});
  const [done, setDone] = useState(false);

  const errors = useMemo(() => validate(values), [values]);
  const score = useMemo(() => passwordScore(values.password), [values.password]);
  if (flags.formConditionalHook && values.name.length >= 3) useMemo(() => 0, []); // [실험] 조건부 Hook
  const valid = Object.keys(errors).length === 0;

  const onInput = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  const onBlur = (name) => setTouched((t) => (t[name] ? t : { ...t, [name]: true }));
  const submit = () => {
    setTouched({ name: true, email: true, password: true, confirm: true, agree: true });
    if (valid) setDone(true);
  };

  if (done) {
    return h('div', { class: 'form-done' },
      h('div', { class: 'big' }, '🎉'),
      h('b', null, `${values.name}님, 가입을 환영합니다!`),
      h('p', { class: 'muted' }, values.email),
      h('button', { type: 'button', class: 'again', onClick: () => { setDone(false); setValues(EMPTY_FORM); setTouched({}); } }, '다시 작성하기'),
    );
  }

  const strength = ['매우 약함', '약함', '보통', '강함', '매우 강함'][score];
  return h('form', { class: 'signup', onSubmit: (e) => { e.preventDefault(); submit(); } },
    h(Field, { label: '이름', name: 'name', value: values.name, error: errors.name, show: touched.name, onInput, onBlur }),
    h(Field, { label: '이메일', name: 'email', value: values.email, error: errors.email, show: touched.email, onInput, onBlur }),
    h(Field, { label: '비밀번호', name: 'password', type: 'password', value: values.password, error: errors.password, show: touched.password, onInput, onBlur },
      h('div', { class: 'strength', 'data-score': score },
        h('div', { class: 'strength-bar', style: { width: `${(score / 4) * 100}%` } }),
      ),
      values.password && h('span', { class: 'strength-label' }, `강도: ${strength}`),
    ),
    h(Field, { label: '비밀번호 확인', name: 'confirm', type: 'password', value: values.confirm, error: errors.confirm, show: touched.confirm, onInput, onBlur }),
    h('label', { class: touched.agree && errors.agree ? 'agree invalid' : 'agree' },
      h('input', { type: 'checkbox', checked: values.agree, onChange: (e) => { onInput('agree', e.target.checked); onBlur('agree'); } }),
      ' 이용약관에 동의합니다',
    ),
    h('button', { type: 'submit', class: valid ? 'primary submit' : 'submit' }, valid ? '가입하기' : `가입하기 (남은 항목 ${Object.keys(errors).length}개)`),
  );
}

// ================================================================ 3. 칸반 보드
const COLUMNS = [
  ['todo', '할 일'],
  ['doing', '진행 중'],
  ['done', '완료'],
];
export const KANBAN_CARDS = [
  { id: 1, title: 'VDOM 구조 설계', col: 'done' },
  { id: 2, title: 'diff 구현', col: 'done' },
  { id: 3, title: 'patch 구현', col: 'doing' },
  { id: 4, title: 'useState', col: 'doing' },
  { id: 5, title: 'useEffect', col: 'todo' },
  { id: 6, title: '발표 자료', col: 'todo' },
];

/** reducer: 상태 변경 규칙을 한 곳에 모은다 (useReducer 예시) */
export function kanbanReducer(cards, action) {
  switch (action.type) {
    case 'add': {
      const id = cards.reduce((m, c) => Math.max(m, c.id), 0) + 1;
      return [...cards, { id, title: action.title, col: 'todo' }];
    }
    case 'remove':
      return cards.filter((c) => c.id !== action.id);
    case 'column': { // 다른 열로 이동: 그 열의 맨 아래로
      const order = COLUMNS.map(([k]) => k);
      const card = cards.find((c) => c.id === action.id);
      const col = order[order.indexOf(card.col) + action.dir];
      if (!col) return cards;
      return [...cards.filter((c) => c.id !== action.id), { ...card, col }];
    }
    case 'order': { // 같은 열 안에서 위/아래
      const card = cards.find((c) => c.id === action.id);
      const same = cards.filter((c) => c.col === card.col);
      const i = same.indexOf(card);
      const other = same[i + action.dir];
      if (!other) return cards;
      const a = cards.indexOf(card);
      const b = cards.indexOf(other);
      const next = cards.slice();
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    }
    case 'reset':
      return KANBAN_CARDS;
    default:
      return cards;
  }
}

function KanbanCard({ card, first, last, colIndex, dispatch }) {
  return h('li', { class: 'kcard', 'data-id': card.id },
    h('span', { class: 'ktitle' }, card.title),
    h('div', { class: 'kbtns' },
      h('button', { type: 'button', class: 'small', title: '왼쪽 열로', disabled: colIndex === 0, onClick: () => dispatch({ type: 'column', id: card.id, dir: -1 }) }, '◀'),
      h('button', { type: 'button', class: 'small', title: '위로', disabled: first, onClick: () => dispatch({ type: 'order', id: card.id, dir: -1 }) }, '▲'),
      h('button', { type: 'button', class: 'small', title: '아래로', disabled: last, onClick: () => dispatch({ type: 'order', id: card.id, dir: 1 }) }, '▼'),
      h('button', { type: 'button', class: 'small', title: '오른쪽 열로', disabled: colIndex === COLUMNS.length - 1, onClick: () => dispatch({ type: 'column', id: card.id, dir: 1 }) }, '▶'),
      h('button', { type: 'button', class: 'small ghost danger', title: '삭제', onClick: () => dispatch({ type: 'remove', id: card.id }) }, '✕'),
    ),
  );
}

function KanbanColumn({ id, title, cards, colIndex, dispatch }) {
  return h('div', { class: `kcol ${id}` },
    h('div', { class: 'khead' }, title, h('span', { class: 'kcount' }, cards.length)),
    cards.length === 0
      ? h('p', { class: 'kempty muted' }, '비어 있음')
      : h('ul', { class: 'klist' },
          cards.map((c, i) => h(KanbanCard, { key: flags.kanbanNoKey ? null : c.id /* [실험] key 제거 */, card: c, first: i === 0, last: i === cards.length - 1, colIndex, dispatch })),
        ),
  );
}

export function KanbanApp() {
  const [cards, dispatch] = useReducer(kanbanReducer, KANBAN_CARDS);
  const [draft, setDraft] = useState('');
  const byCol = useMemo(() => Object.fromEntries(COLUMNS.map(([k]) => [k, cards.filter((c) => c.col === k)])), [cards]);

  return h('div', { class: 'kanban' },
    h('form', { class: 'kadd', onSubmit: (e) => { e.preventDefault(); if (draft.trim()) { dispatch({ type: 'add', title: draft.trim() }); setDraft(''); } } },
      h('input', { type: 'text', placeholder: '새 카드 (할 일 열에 추가)', value: draft, onInput: (e) => setDraft(e.target.value), 'aria-label': '새 카드' }),
      h('button', { type: 'submit', disabled: !draft.trim() }, '추가'),
      h('button', { type: 'button', class: 'ghost', onClick: () => dispatch({ type: 'reset' }) }, '초기화'),
    ),
    h('div', { class: 'kcols' },
      COLUMNS.map(([id, title], colIndex) => h(KanbanColumn, { key: id, id, title, cards: byCol[id], colIndex, dispatch })),
    ),
  );
}

// ================================================================ 4. 1,000행 리스트
const TEAMS = ['프론트', '백엔드', '인프라', '데이터', '디자인'];
const FAMILY = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
const GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지유', '예준', '수아', '주원', '지호'];
export function makeRows(n = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: FAMILY[i % 10] + GIVEN[Math.floor(i / 10) % 10],
    team: TEAMS[(i * 7) % 5],
    score: (i * 37 + 11) % 100,
  }));
}

function ListRow({ row, hot }) {
  return h('tr', { class: hot ? 'hot' : null },
    h('td', { class: 'mono' }, row.id),
    h('td', null, row.name),
    h('td', null, row.team),
    h('td', { class: 'mono score' }, row.score),
  );
}

export function ListApp() {
  const [rows, setRows] = useState(() => makeRows(1000));
  const [query, setQuery] = useState('');
  const [team, setTeam] = useState('all');
  const [sort, setSort] = useState('id');
  const [hot, setHot] = useState(null);
  const [, setTick] = useState(0); // 화면에 쓰지 않는 값: "관계없는 리렌더" 용
  const seed = useRef(1);
  const calc = useRef({ count: 0, ms: 0 });

  const visible = useMemo(() => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const q = query.trim();
    let list = rows.filter((r) => (team === 'all' || r.team === team) && (!q || r.name.includes(q) || String(r.id) === q));
    if (sort === 'score') list = list.slice().sort((a, b) => b.score - a.score || a.id - b.id);
    calc.current.count++;
    calc.current.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    return list;
  }, flags.listNoMemo ? undefined : [rows, query, team, sort]); // [실험] 의존성 배열이 없으면 매번 다시 계산

  const bumpOne = () => {
    seed.current = (seed.current * 9301 + 49297) % 233280;
    const pool = visible.length ? visible : rows;
    const target = pool[seed.current % Math.min(pool.length, 30)]; // 화면 위쪽 30행 중 하나
    setRows((list) => list.map((r) => (r.id === target.id ? { ...r, score: Math.min(99, r.score + 1) } : r)));
    setHot(target.id);
  };

  return h('div', { class: 'biglist' },
    h('div', { class: 'blbar' },
      h('input', { type: 'search', placeholder: '이름 또는 번호 검색', value: query, onInput: (e) => setQuery(e.target.value), 'aria-label': '검색' }),
      h('select', { value: team, onChange: (e) => setTeam(e.target.value), 'aria-label': '팀' },
        h('option', { value: 'all' }, '모든 팀'), TEAMS.map((t) => h('option', { key: t, value: t }, t))),
      h('select', { value: sort, onChange: (e) => setSort(e.target.value), 'aria-label': '정렬' },
        h('option', { value: 'id' }, '번호 순'), h('option', { value: 'score' }, '점수 높은 순')),
      h('button', { type: 'button', class: 'primary bump', onClick: bumpOne }, '한 명 점수 +1'),
      h('button', { type: 'button', class: 'rerender', title: '화면에 쓰지 않는 state 만 바꿔서 렌더링만 다시 일으킴', onClick: () => setTick((t) => t + 1) }, '관계없는 리렌더'),
    ),
    h('p', { class: 'blinfo muted' },
      `1,000명 중 ${visible.length.toLocaleString()}명 표시 · `,
      h('span', { class: 'calc' }, `필터·정렬 계산 ${calc.current.count}회 (마지막 ${calc.current.ms.toFixed(1)}ms)`),
    ),
    h('div', { class: 'bltable' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '이름'), h('th', null, '팀'), h('th', null, '점수'))),
        h('tbody', null, visible.map((r) => h(ListRow, { key: r.id, row: r, hot: r.id === hot }))),
      ),
    ),
  );
}

// ================================================================ 5. 스톱워치 + 랩
export function formatMs(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function LapList({ laps }) {
  if (laps.length === 0) return h('p', { class: 'muted lap-empty' }, '랩 기록이 없습니다.');
  const best = Math.min(...laps.map((l) => l.split));
  const worst = Math.max(...laps.map((l) => l.split));
  return h('ol', { class: 'laps', reversed: true },
    laps.map((l, i) => h('li', { key: flags.stopwatchIndexKey ? i : l.id /* [실험] index key */, class: laps.length > 1 && l.split === best ? 'best' : laps.length > 1 && l.split === worst ? 'worst' : null },
      h('span', null, `랩 ${l.id}`),
      h('span', { class: 'mono' }, '+' + formatMs(l.split)),
      h('span', { class: 'mono muted' }, formatMs(l.total)),
    )),
  );
}

export function StopwatchApp() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [laps, setLaps] = useState([]);
  const base = useRef(0); // 멈췄을 때까지 누적된 시간 (렌더와 무관한 값 → useRef)
  const startedAt = useRef(0);

  // running 이 true 인 동안만 interval 을 등록, false 가 되거나 사라지면 cleanup 으로 해제
  useEffect(() => {
    if (!running) return undefined;
    startedAt.current = Date.now();
    const id = setInterval(() => setElapsed(base.current + Date.now() - startedAt.current), 31);
    if (flags.stopwatchNoCleanup) {
      leakedTimers.add(id); // [실험] cleanup 없음 → 이 타이머는 해제되지 않는다 (복구 시 정리)
      return undefined;
    }
    return () => {
      clearInterval(id);
      base.current += Date.now() - startedAt.current;
    };
  }, [running]);

  const lap = () => setLaps((list) => {
    const prevTotal = list[0]?.total ?? 0;
    return [{ id: list.length + 1, total: elapsed, split: elapsed - prevTotal }, ...list];
  });
  const reset = () => {
    base.current = 0;
    setElapsed(0);
    setLaps([]);
  };

  return h('div', { class: 'stopwatch' },
    h('div', { class: running ? 'sw-time running' : 'sw-time' }, formatMs(elapsed)),
    h('div', { class: 'sw-btns' },
      h('button', { type: 'button', class: running ? 'sw-toggle' : 'primary sw-toggle', onClick: () => setRunning((r) => !r) }, running ? '정지' : elapsed ? '계속' : '시작'),
      h('button', { type: 'button', class: 'sw-lap', disabled: !running, onClick: lap }, '랩'),
      h('button', { type: 'button', class: 'sw-reset', disabled: running || elapsed === 0, onClick: reset }, '리셋'),
    ),
    h(LapList, { laps }),
  );
}

// ================================================================ 6. Effect 타이밍 (useEffect vs useLayoutEffect)
const busyWait = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 일부러 메인 스레드를 막음 (무거운 측정 흉내) */ }
};

function Tooltip({ pos }) {
  return h('div', { class: pos ? 'et-tip placed' : 'et-tip unplaced', style: pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px' } },
    pos ? '✓ 버튼 옆에 딱 붙었어요' : '⚠ 위치 계산 전 (잘못된 자리)');
}

export function EffectTimingApp() {
  const [which, setWhich] = useState('effect'); // 툴팁 위치를 어느 Hook 에서 잡을지
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [slow, setSlow] = useState(true);
  const [tick, setTick] = useState(0);

  // ---- 데모 1: 실행 순서 기록 (로그는 화면 갱신을 일으키지 않도록 DOM 에 직접 쓴다) ----
  const t0 = useRef(0);
  t0.current = performance.now();
  const write = (text, cls) => {
    const ol = document.getElementById('et-log');
    if (!ol) return;
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = `${text}  +${(performance.now() - t0.current).toFixed(1)}ms`;
    ol.append(li);
  };
  useLayoutEffect(() => {
    if (tick === 0) return;
    document.getElementById('et-log').replaceChildren();
    write('① 렌더 + DOM 반영 끝 → useLayoutEffect 실행 (그리기 전, 동기)', 'layout');
    requestAnimationFrame(() => write('② 브라우저가 화면을 그리기 직전 (requestAnimationFrame)', 'paint'));
  }, [tick]);
  useEffect(() => {
    if (tick === 0) return;
    write('③ 화면을 그린 뒤 → useEffect 실행 (비동기)', 'effect');
  }, [tick]);

  // ---- 데모 2: 툴팁 위치 잡기 ----
  const place = () => {
    if (slow) busyWait(300);
    const btn = document.getElementById('et-btn');
    if (btn) setPos({ left: btn.offsetLeft + btn.offsetWidth + 10, top: btn.offsetTop });
  };
  useLayoutEffect(() => {
    if (which === 'layout' && open && !pos) place();
  }, [which, open, pos, slow]);
  useEffect(() => {
    if (which === 'effect' && open && !pos) place();
  }, [which, open, pos, slow]);

  return h('div', { class: 'etiming' },
    h('div', { class: 'et-block' },
      h('b', null, '데모 1 · 실행 순서'),
      h('p', { class: 'muted small' }, '버튼을 누르면 리렌더링하고, 각 단계가 언제 실행되는지 기록합니다.'),
      h('button', { type: 'button', class: 'primary et-run', onClick: () => setTick((t) => t + 1) }, '리렌더하고 순서 보기'),
      h('ol', { id: 'et-log', class: 'et-log' }), // 자식을 VDOM 이 관리하지 않으므로 직접 써도 diff 와 충돌하지 않음
    ),
    h('div', { class: 'et-block' },
      h('b', null, '데모 2 · 툴팁 위치 잡기 (깜빡임)'),
      h('div', { class: 'et-opts' },
        h('label', null, h('input', { type: 'radio', name: 'et-which', checked: which === 'effect', onChange: () => { setWhich('effect'); setOpen(false); setPos(null); } }), ' useEffect 로'),
        h('label', null, h('input', { type: 'radio', name: 'et-which', checked: which === 'layout', onChange: () => { setWhich('layout'); setOpen(false); setPos(null); } }), ' useLayoutEffect 로'),
        h('label', null, h('input', { type: 'checkbox', checked: slow, onChange: (e) => setSlow(e.target.checked) }), ' 측정이 300ms 걸린다고 가정'),
      ),
      h('div', { class: 'et-stage' },
        h('button', { type: 'button', id: 'et-btn', class: 'et-btn', onClick: () => { setOpen((o) => !o); setPos(null); } }, open ? '툴팁 닫기' : '툴팁 열기'),
        open && h(Tooltip, { pos }),
      ),
    ),
  );
}

// ================================================================ 7. Context vs Props Drilling
const ThemeContext = createContext('light');
const UserContext = createContext('손님');

// ---- Props Drilling: 쓰지도 않는 중간 컴포넌트들이 theme, user 를 받아서 넘겨야 한다 ----
function Relay({ label, children }) {
  return h('div', { class: 'relay' }, h('span', { class: 'relay-tag drill' }, `${label}: theme, user 받아서 넘김`), children);
}
function DrillPage({ theme, user }) { return h(Relay, { label: 'Page' }, h(DrillSection, { theme, user })); }
function DrillSection({ theme, user }) { return h(Relay, { label: 'Section' }, h(DrillCard, { theme, user })); }
function DrillCard({ theme, user }) { return h(Relay, { label: 'Card' }, h(Greeting, { theme, user })); }

// ---- Context: 중간 컴포넌트는 아무것도 모른다. 필요한 곳에서만 꺼내 쓴다 ----
function Plain({ label, children }) {
  return h('div', { class: 'relay' }, h('span', { class: 'relay-tag ctx' }, `${label}: 아무것도 안 받음`), children);
}
function CtxPage() { return h(Plain, { label: 'Page' }, h(CtxSection)); }
function CtxSection() { return h(Plain, { label: 'Section' }, h(CtxCard)); }
function CtxCard() { return h(Plain, { label: 'Card' }, h(CtxGreeting)); }
function CtxGreeting() {
  const theme = useContext(ThemeContext); // 자식에서도 읽기 가능 (상태를 만들지 않음)
  const user = useContext(UserContext);
  return h(Greeting, { theme, user });
}

function Greeting({ theme, user }) {
  return h('div', { class: `greet ${theme}` }, `안녕하세요, ${user}님 `, h('small', null, `(${theme === 'dark' ? '어두운' : '밝은'} 테마)`));
}

export function ContextApp() {
  const [theme, setTheme] = useState('light');
  const [user, setUser] = useState('김정글');
  return h('div', { class: 'ctxapp' },
    h('div', { class: 'ctx-controls' },
      h('button', { type: 'button', class: 'ctx-theme', onClick: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')) }, theme === 'light' ? '🌙 어두운 테마' : '☀️ 밝은 테마'),
      h('input', { type: 'text', value: user, onInput: (e) => setUser(e.target.value), 'aria-label': '사용자 이름' }),
    ),
    h('div', { class: 'ctx-cols' },
      h('div', { class: 'ctx-col' },
        h('div', { class: 'ctx-title' }, 'Props Drilling', h('span', { class: 'muted' }, ' — props 를 4단계로 전달')),
        h(DrillPage, { theme, user }),
      ),
      h('div', { class: 'ctx-col' },
        h('div', { class: 'ctx-title' }, 'Context', h('span', { class: 'muted' }, ' — 필요한 곳에서 바로 꺼냄')),
        h(ThemeContext.Provider, { value: theme },
          h(UserContext.Provider, { value: user }, h(CtxPage)),
        ),
      ),
    ),
  );
}
