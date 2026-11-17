/**
 * 개념 더 파고들기 — 실험실(Lab)에서 쓰는 앱과 계산 함수
 * ------------------------------------------------------------------
 * 앱은 모두 miniReact 루트 컴포넌트다. (Hook 은 루트에서만, 자식은 props 만)
 * 계산 함수는 DOM 없이 동작해서 테스트로 검증한다. (tests/deepdive.test.js)
 */
import { h } from '../src/lib/vdom.js';
import { longestIncreasingSubsequence } from '../src/lib/diff.js';
import { useState, useEffect, useMemo, useRef } from '../src/lib/component.js';

// ================================================================ 계산 함수

/** "A B C" / "A,B,C" → ['A','B','C'] (중복은 처음 것만) */
export function parseKeys(text) {
  const out = [];
  for (const k of String(text).split(/[\s,]+/)) if (k && !out.includes(k)) out.push(k);
  return out;
}

/**
 * 이전 순서 → 새 순서로 바꿀 때 "가만히 두는 노드"와 "움직이는 노드" 계산 (diff.js 와 같은 LIS 방식)
 * @returns {{ positions:number[], keep:string[], moved:string[], inserted:string[], removed:string[] }}
 */
export function lisPlan(oldKeys, newKeys) {
  const oldIndex = new Map(oldKeys.map((k, i) => [k, i]));
  const positions = newKeys.map((k) => (oldIndex.has(k) ? oldIndex.get(k) : -1));
  const survivors = [];
  positions.forEach((p, i) => { if (p >= 0) survivors.push(i); });
  const lis = longestIncreasingSubsequence(survivors.map((i) => positions[i]));
  const keepIdx = new Set(lis.map((j) => survivors[j]));
  const keep = [], moved = [], inserted = [];
  newKeys.forEach((k, i) => {
    if (positions[i] < 0) inserted.push(k);
    else if (keepIdx.has(i)) keep.push(k);
    else moved.push(k);
  });
  const removed = oldKeys.filter((k) => !newKeys.includes(k));
  return { positions, keep, moved, inserted, removed };
}

/** 순진한 방법(이동 대신 위치가 바뀐 노드를 전부 다시 놓기)으로 셀 때 움직이는 노드 수 */
export function naiveMoves(oldKeys, newKeys) {
  const kept = oldKeys.filter((k) => newKeys.includes(k));
  const order = newKeys.filter((k) => oldKeys.includes(k));
  return order.filter((k, i) => kept[i] !== k).length;
}

/**
 * 두 번의 렌더에서 Hook 호출 목록을 칸(slot) 번호로 맞춰 본다.
 * @param {string[]} first   첫 렌더에서 부른 Hook 이름 (예: ['useState:on', 'useMemo:total'])
 * @param {string[]} second  다음 렌더에서 부른 Hook 이름
 */
export function hookSlots(first, second) {
  const n = Math.max(first.length, second.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = first[i] ?? null;
    const b = second[i] ?? null;
    const kind = (s) => (s ? s.split(':')[0] : null);
    let status = 'ok';
    if (a && !b) status = 'missing';
    else if (!a && b) status = 'extra';
    else if (a !== b) status = kind(a) === kind(b) ? 'swapped' : 'mismatch';
    rows.push({ slot: i, first: a, second: b, status });
  }
  return rows;
}

/** 트리 비교 비용: 일반적인 최소 편집 거리 O(n³) vs React 휴리스틱 O(n) */
export function diffCost(n) {
  const naive = n ** 3;
  const heuristic = n;
  const OPS_PER_SEC = 1e9; // 대략 1초에 10억 번 연산한다고 가정
  return { n, naive, heuristic, naiveSec: naive / OPS_PER_SEC, heuristicSec: heuristic / OPS_PER_SEC };
}

/** 사람이 읽기 쉬운 시간 */
export function humanTime(sec) {
  if (sec < 1e-6) return `${(sec * 1e9).toFixed(0)}ns`;
  if (sec < 1e-3) return `${(sec * 1e6).toFixed(1)}µs`;
  if (sec < 1) return `${(sec * 1e3).toFixed(1)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}초`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}분`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}시간`;
  if (sec < 86400 * 365) return `${(sec / 86400).toFixed(1)}일`;
  return `${(sec / 86400 / 365).toFixed(1)}년`;
}

/**
 * 이벤트 핸들러만 바뀐 PROPS 패치는 뺀다.
 * (렌더마다 화살표 함수가 새로 만들어져 생기는 패치 — 화면에는 아무 변화가 없어서 실험 결과를 읽을 때 방해가 된다)
 */
export function visiblePatches(patches) {
  return patches.filter((p) => p.type !== 'PROPS' || p.changes.some((c) => !/^on[A-Z]/.test(c.name)));
}

/** 예측 채점: 내가 고른 순서와 실제 순서가 같은 자리에 있는 개수 */
export function scoreOrder(guess, actual) {
  let hit = 0;
  guess.forEach((g, i) => { if (actual[i] === g) hit++; });
  return hit;
}

// ================================================================ 앱 1. 스냅샷 (클로저)
/**
 * 렌더마다 state 는 그 순간의 "사진"이다. 2초 뒤에 읽으면 클릭 당시 값이 보인다.
 * ref 는 렌더와 상관없이 같은 상자라서 최신 값이 보인다.
 */
export function SnapshotApp({ delay = 2000 }) {
  const [count, setCount] = useState(0);
  const [log, setLog] = useState([]);
  const latest = useRef(count);
  const timers = useRef([]);
  latest.current = count; // 렌더마다 최신 값으로 덮어씀
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const later = (how) => {
    const clickedAt = count;
    const id = setTimeout(() => {
      const seen = how === 'state' ? count : latest.current;
      setLog((prev) => [...prev.slice(-5), { how, clickedAt, seen, now: latest.current }]);
    }, delay);
    timers.current.push(id);
  };

  return h('div', { class: 'lab-app snapshot' },
    h('div', { class: 'row' },
      h('b', { class: 'big-n' }, count),
      h('button', { type: 'button', class: 'inc', onClick: () => setCount((c) => c + 1) }, '+1'),
      h('button', { type: 'button', class: 'read-state', onClick: () => later('state') }, `${delay / 1000}초 뒤 state 읽기`),
      h('button', { type: 'button', class: 'read-ref', onClick: () => later('ref') }, `${delay / 1000}초 뒤 ref 읽기`),
    ),
    h('p', { class: 'small muted' }, '읽기 버튼을 누른 뒤, 2초 안에 +1 을 여러 번 눌러 보세요.'),
    h('ul', { class: 'log snap-log' },
      log.length
        ? log.map((e, i) => h('li', { key: i, class: e.seen === e.now ? 'fresh' : 'stale' },
            h('code', null, e.how === 'state' ? 'count' : 'ref.current'),
            ` → ${e.seen}  (누를 때 ${e.clickedAt}, 지금 화면 ${e.now}) `,
            h('b', null, e.seen === e.now ? '최신 값' : '그때의 사진'),
          ))
        : [h('li', { class: 'muted' }, '아직 기록이 없습니다.')]
    )
  );
}

// ================================================================ 앱 2. key 와 정체성
export const PEOPLE = [
  { id: 'p1', name: '김정글' },
  { id: 'p2', name: '이리액트' },
  { id: 'p3', name: '박훅스' },
];
const NEW_NAMES = ['최디프', '정패치', '한커밋', '윤렌더', '오스테이트'];

function PersonRow({ person, keyLabel }) {
  return h('li', { class: 'person' },
    h('span', { class: 'idx' }, `key ${keyLabel}`),
    h('b', null, person.name),
    h('input', { class: 'memo', placeholder: `${person.name} 메모`, 'aria-label': `${person.name} 메모` }),
  );
}

export function KeyIdentityApp() {
  const [mode, setMode] = useState('index');
  const [people, setPeople] = useState(PEOPLE);
  const [made, setMade] = useState(0);
  const prepend = () => {
    const name = NEW_NAMES[made % NEW_NAMES.length];
    setPeople((list) => [{ id: `n${made}`, name }, ...list]);
    setMade((m) => m + 1);
  };
  const reverse = () => setPeople((list) => [...list].reverse());
  return h('div', { class: 'lab-app keys' },
    h('div', { class: 'row' },
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'key 방식' },
        h('button', { type: 'button', class: mode === 'index' ? 'seg on' : 'seg', 'data-mode': 'index', onClick: () => setMode('index') }, 'key = index'),
        h('button', { type: 'button', class: mode === 'id' ? 'seg on' : 'seg', 'data-mode': 'id', onClick: () => setMode('id') }, 'key = id'),
      ),
      h('button', { type: 'button', class: 'prepend', onClick: prepend }, '맨 앞에 한 명 추가'),
      h('button', { type: 'button', class: 'reverse', onClick: reverse }, '순서 뒤집기'),
    ),
    h('ul', { class: 'people' },
      people.map((p, i) => {
        const key = mode === 'index' ? i : p.id;
        return h(PersonRow, { key, person: p, keyLabel: key });
      })
    )
  );
}

// ================================================================ 앱 3. Effect 경쟁 상태 (race condition)
/** 가짜 서버: 검색어마다 걸리는 시간이 다르다 */
export function fakeSearch(q, delay = 200 + Math.random() * 1300) {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ q, items: [`${q} 강의`, `${q} 예제`, `${q} 면접 질문`], ms: Math.round(delay) }), delay)
  );
}

export function RaceApp({ fetcher = fakeSearch, initialSafe = false }) {
  const [query, setQuery] = useState('');
  const [safe, setSafe] = useState(initialSafe);
  const [result, setResult] = useState(null);
  const [events, setEvents] = useState([]);
  const note = (e) => setEvents((prev) => [...prev.slice(-7), e]);

  useEffect(() => {
    if (!query) return undefined;
    let ignore = false;
    note({ type: 'send', q: query });
    fetcher(query).then((r) => {
      if (safe && ignore) {
        note({ type: 'ignored', q: r.q, ms: r.ms });
        return;
      }
      note({ type: 'show', q: r.q, ms: r.ms });
      setResult(r);
    });
    return () => { ignore = true; };
  }, [query, safe]);

  const wrong = result && result.q !== query;
  return h('div', { class: 'lab-app race' },
    h('div', { class: 'row' },
      h('input', { class: 'q', value: query, placeholder: '빠르게 타이핑: react', 'aria-label': '검색어', onInput: (e) => setQuery(e.target.value) }),
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', class: 'safe', checked: safe, onChange: (e) => setSafe(e.target.checked) }),
        ' cleanup 으로 늦은 응답 무시',
      ),
    ),
    h('div', { class: wrong ? 'race-result wrong' : 'race-result' },
      result
        ? [h('div', null, '화면에 보이는 결과: ', h('b', { class: 'shown-q' }, `"${result.q}"`), ` (${result.ms}ms 걸림)`),
           h('div', null, '지금 입력된 검색어: ', h('b', null, `"${query}"`)),
           h('div', { class: 'verdict' }, wrong ? '✗ 입력과 결과가 다릅니다 — 늦게 온 옛 응답이 최신 결과를 덮어썼어요.' : '✓ 입력과 결과가 일치합니다.')]
        : [h('div', { class: 'muted' }, '검색어를 입력하면 결과가 여기 나타납니다.')]
    ),
    h('ol', { class: 'log race-log' },
      events.map((e, i) => h('li', { key: i, class: e.type },
        e.type === 'send' ? `→ "${e.q}" 요청 보냄` : e.type === 'show' ? `← "${e.q}" 응답 (${e.ms}ms) 화면에 표시` : `← "${e.q}" 응답 (${e.ms}ms) 무시함 (cleanup 됨)`
      ))
    )
  );
}

// ================================================================ 앱 4. 불변성과 Object.is
export function ImmutableApp({ onMemory = () => {} }) {
  const [items, setItems] = useState(['사과']);
  const renders = useRef(0);
  renders.current++;
  const fruits = ['바나나', '포도', '딸기', '복숭아', '귤', '수박'];
  const pick = () => fruits[(items.length - 1) % fruits.length];
  const mutate = () => {
    items.push(pick());            // 원본 배열을 직접 바꿈
    setItems(items);               // 같은 참조 → Object.is(prev, next) === true → 무시
    onMemory(items.length);
  };
  const copy = () => {
    const next = [...items, pick()]; // 새 배열
    setItems(next);
    onMemory(next.length);
  };
  const total = useMemo(() => items.length, [items]);
  return h('div', { class: 'lab-app immut' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'mutate', onClick: mutate }, 'push 하고 같은 배열로 setState'),
      h('button', { type: 'button', class: 'copy', onClick: copy }, '[...items, 새것] 으로 setState'),
    ),
    h('div', { class: 'stats' },
      h('span', null, '화면에 보이는 개수 ', h('b', { class: 'shown' }, total)),
      h('span', null, '렌더 횟수 ', h('b', { class: 'renders' }, renders.current)),
    ),
    h('ul', { class: 'chips' }, items.map((f, i) => h('li', { key: i }, f)))
  );
}

// ================================================================ 앱 5. Hook 순서
/** fixed=false 면 조건문 안에서 Hook 을 부른다 (규칙 위반) */
export function HookOrderApp({ fixed = false, onCalls = () => {} }) {
  // 부르기 "직전"에 이름을 적어 둔다 → 에러로 렌더가 중간에 멈춰도 어디까지 불렀는지 남는다
  const calls = [];
  onCalls(calls);
  calls.push('useState:on'); const [on, setOn] = useState(false);
  let memo = null;
  if (fixed) {
    calls.push('useRef:memo'); memo = useRef(null);
  } else if (on) {
    calls.push('useRef:memo'); memo = useRef(null);  // ← 조건부 Hook
  }
  calls.push('useState:n'); const [n, setN] = useState(0);
  calls.push('useMemo:doubled'); const doubled = useMemo(() => n * 2, [n]);
  return h('div', { class: 'lab-app hooks-order' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'toggle-on', onClick: () => setOn((v) => !v) }, on ? '메모 칸 끄기' : '메모 칸 켜기 (조건부 Hook)'),
      h('button', { type: 'button', class: 'inc', onClick: () => setN((v) => v + 1) }, `n = ${n}, n×2 = ${doubled}`),
    ),
    h('p', { class: 'small muted' }, fixed ? '고친 버전: useRef 는 항상 부르고, 쓸지 말지만 조건으로 정합니다.' : on ? '메모 칸이 켜져 있습니다.' : '메모 칸이 꺼져 있습니다.'),
    memo && on ? h('p', { class: 'small' }, '메모 칸 사용 중') : null,
  );
}
