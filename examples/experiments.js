/**
 * "일부러 망가뜨리기" 실험
 * ------------------------------------------------------------------
 * flags 의 값을 켜면 apps.js 의 해당 앱이 "잘못 짠 코드" 처럼 동작한다.
 * 실험을 켜거나 끌 때마다 그 앱을 새로 마운트하므로, 한 번의 렌더 안에서는 flag 가 바뀌지 않는다.
 */

export const flags = {
  cartMutate: false,           // 장바구니: state 를 직접 수정 (불변성 위반)
  cartHookInChild: false,      // 장바구니: 자식 컴포넌트에서 Hook 호출
  formConditionalHook: false,  // 회원가입: 조건문 안에서 Hook 호출
  kanbanNoKey: false,          // 칸반: 카드 key 제거
  listNoMemo: false,           // 1,000행: useMemo 끄기
  stopwatchNoCleanup: false,   // 스톱워치: useEffect cleanup 제거
  stopwatchIndexKey: false,    // 스톱워치: 랩 key 를 index 로
};

/** cleanup 없이 등록되어 새어 나간 타이머. 복구할 때 정리한다. */
export const leakedTimers = new Set();

export function clearLeakedTimers() {
  for (const id of leakedTimers) clearInterval(id);
  leakedTimers.clear();
}

export const EXPERIMENTS = [
  {
    id: 'cartMutate',
    app: 'cart',
    title: '불변성 깨기',
    concept: 'State 와 불변성',
    theory: '../theory/index.html#state',
    before: 'setItems(list => list.map(it => it.id === id ? { ...it, qty: it.qty + 1 } : it))',
    after: 'item.qty += 1;\nsetItems(items);   // 같은 배열을 그대로 다시 넣음',
    try: '수량 + 버튼을 눌러보세요. 그다음 쿠폰 칸에 아무 글자나 입력해 보세요.',
    watch: '+ 를 눌러도 화면이 안 바뀌고 렌더 횟수도 그대로입니다. 쿠폰 칸에 타이핑하면 그제야 수량 숫자는 바뀌는데, 합계는 여전히 옛날 값입니다.',
    why: 'setState 는 Object.is(이전, 다음) 로 바뀌었는지 봅니다. 같은 배열을 넣었으니 "안 바뀜"으로 판단해 렌더링을 건너뜁니다. 나중에 다른 이유로 렌더링되면 수정된 숫자는 보이지만, 합계의 useMemo 도 [items] 참조가 같다고 보고 다시 계산하지 않습니다.',
  },
  {
    id: 'cartHookInChild',
    app: 'cart',
    title: '자식 컴포넌트에서 Hook 호출',
    concept: 'Hook 은 루트에서만 (과제 제약)',
    theory: '../theory/index.html#hooks-rules',
    before: 'function CartRow({ item, ... }) {\n  return h(\'li\', ...);\n}',
    after: 'function CartRow({ item, ... }) {\n  useState(0);      // 자식에서 Hook!\n  return h(\'li\', ...);\n}',
    try: '켜기만 하면 됩니다.',
    watch: '장바구니 자리에 "최상위(루트) 컴포넌트에서만" 에러가 표시되고 앱이 그려지지 않습니다. 다른 예제는 정상입니다.',
    why: '이 과제에서는 state 를 루트 컴포넌트에서만 관리합니다 (Lifting State Up). miniReact 는 자식 컴포넌트를 렌더링하는 중에 Hook 이 불리면 바로 에러를 던져 이 규칙을 강제합니다.',
  },
  {
    id: 'formConditionalHook',
    app: 'form',
    title: '조건문 안에서 Hook 호출',
    concept: 'Hooks 규칙: 호출 순서',
    theory: '../theory/index.html#hooks-rules',
    before: 'const errors = useMemo(...);\nconst score = useMemo(...);',
    after: 'const errors = useMemo(...);\nconst score = useMemo(...);\nif (values.name.length >= 3) {\n  useMemo(() => 0, []);   // 조건부 Hook!\n}',
    try: '이름 칸에 글자를 하나씩 입력해 보세요.',
    watch: '두 글자까지는 괜찮다가, 세 번째 글자를 치는 순간 "Hook 호출 개수가 달라졌습니다" 에러가 나고 화면이 더 이상 바뀌지 않습니다.',
    why: 'Hook 은 이름이 아니라 호출 순서로 자기 칸(hooks 배열의 몇 번째)을 찾습니다. 렌더마다 호출 개수가 달라지면 칸이 어긋나기 때문에, miniReact 는 이를 감지해 에러를 냅니다.',
  },
  {
    id: 'kanbanNoKey',
    app: 'kanban',
    title: 'key 지우기',
    concept: 'key 의 역할',
    theory: '../theory/index.html#key',
    before: 'cards.map(c => h(KanbanCard, { key: c.id, card: c, ... }))',
    after: 'cards.map(c => h(KanbanCard, { card: c, ... }))   // key 없음',
    try: '"할 일" 열의 두 번째 카드에서 ▲ 를 눌러보세요. 망가뜨리기 전과 아래 막대를 비교하세요.',
    watch: '정상일 때는 MOVE 1개였는데, 이제 MOVE 가 없고 TEXT 와 PROPS 가 여러 개 생깁니다.',
    why: 'key 가 없으면 Diff 는 순서(위치)로 짝을 짓습니다. 카드 노드는 제자리에 둔 채 안의 제목과 data-id 를 서로 바꿔 씁니다. 화면은 같아 보여도 DOM 작업이 늘고, 카드 안에 입력값 같은 상태가 있었다면 엉뚱한 카드에 남습니다.',
  },
  {
    id: 'listNoMemo',
    app: 'list',
    title: 'useMemo 끄기',
    concept: 'useMemo 와 의존성',
    theory: '../theory/index.html#usememo',
    before: 'useMemo(() => filterAndSort(rows), [rows, query, team, sort])',
    after: 'useMemo(() => filterAndSort(rows))   // 의존성 배열 없음 = 매번 다시 계산',
    try: '"관계없는 리렌더" 버튼을 여러 번 눌러보세요.',
    watch: '정상일 때는 리렌더해도 "필터·정렬 계산" 횟수가 그대로인데, 이제는 누를 때마다 늘어나고 렌더 시간(ms)도 길어집니다. 화면은 똑같습니다.',
    why: 'useMemo 는 의존성 배열의 값이 그대로면 지난 결과를 재사용합니다. 의존성이 없으면 매 렌더마다 1,000행을 다시 필터링하고 정렬합니다. 결과는 같아도 계산 비용이 듭니다.',
  },
  {
    id: 'stopwatchNoCleanup',
    app: 'stopwatch',
    title: 'cleanup 지우기',
    concept: 'useEffect cleanup',
    theory: '../theory/index.html#useeffect',
    before: 'useEffect(() => {\n  const id = setInterval(tick, 31);\n  return () => clearInterval(id);\n}, [running]);',
    after: 'useEffect(() => {\n  const id = setInterval(tick, 31);\n  // return 없음 → 정지해도 해제 안 됨\n}, [running]);',
    try: '시작 → 정지를 눌러보세요. 그다음 다시 시작 → 정지.',
    watch: '정지를 눌러도 시간이 계속 흐르고 렌더 횟수가 계속 늘어납니다. 시작을 또 누르면 타이머가 하나 더 생겨 숫자가 들쭉날쭉해집니다.',
    why: 'cleanup 은 의존성이 바뀌어 effect 가 다시 실행되기 직전과 컴포넌트가 사라질 때 호출됩니다. cleanup 이 없으면 이전 interval 이 해제되지 않고 계속 쌓입니다 (메모리 누수). 복구하면 새어 나간 타이머도 정리됩니다.',
  },
  {
    id: 'stopwatchIndexKey',
    app: 'stopwatch',
    title: '랩 key 를 index 로',
    concept: 'index 를 key 로 쓰면 안 되는 이유',
    theory: '../theory/index.html#key',
    before: 'laps.map(l => h(\'li\', { key: l.id }, ...))',
    after: 'laps.map((l, i) => h(\'li\', { key: i }, ...))   // 순서를 key 로',
    try: '시작한 뒤 랩을 3~4번 눌러보세요. 새 랩은 맨 위에 추가됩니다.',
    watch: '아래 막대의 "최근 구조 변경" 칸을 보세요 (스톱워치는 계속 렌더링돼서 왼쪽 칸은 금방 시간 TEXT 1 로 덮입니다). 정상일 때는 랩을 누르면 INSERT 1 과 시간 TEXT 1 정도인데, 망가지면 기존 랩 행의 글자를 전부 다시 써서 TEXT 가 여러 개로 늘어나고, 새 행은 맨 아래에 추가됩니다.',
    why: '맨 앞에 추가하면 모든 항목의 index 가 하나씩 밀립니다. index 가 key 면 "0번 행은 원래 0번 행" 으로 보고 내용만 고쳐 씁니다. 고유 id 를 key 로 써야 "새 행 1개 추가" 로 정확히 인식합니다.',
  },
];
