/**
 * 샌드박스: 틀(템플릿)과 조각(스니펫)
 *  - 틀: 버튼 하나로 편집기 전체를 바꾸는 시작 코드
 *  - 조각: 커서 위치에 끼워 넣는 코드 한 덩어리
 */

export const TEMPLATES = [
  {
    id: 'blank',
    name: '빈 틀',
    desc: 'App 함수 하나만 있는 가장 작은 시작점입니다.',
    try: ['오른쪽 "조각 넣기" 버튼으로 useState, 버튼, 리스트 등을 끼워 넣어 보세요.'],
    code: `// 사용할 수 있는 것: h, useState, useEffect, useLayoutEffect, useMemo,
//                   useCallback, useRef, useReducer, createContext, useContext
// 규칙: App 이라는 이름의 함수가 루트 컴포넌트입니다. Hook 은 App 안에서만!

function App() {
  return h('div', { class: 'box' },
    h('h2', null, '안녕하세요 👋'),
    h('p', null, '여기서부터 원하는 기능을 만들어 보세요.'),
  );
}
`,
  },
  {
    id: 'counter',
    name: '카운터',
    desc: 'useState 의 가장 기본. 버튼을 누르면 state 가 바뀌고, 바뀐 숫자 텍스트만 patch 됩니다.',
    try: [
      '−1 버튼을 추가해 보세요.',
      'setCount(count + 1) 를 세 번 연속 호출하면 몇이 오를까요? setCount(c => c + 1) 은?',
      'Inspector 의 "이번 렌더의 원인" 을 보세요.',
    ],
    code: `function App() {
  const [count, setCount] = useState(0);

  return h('div', { class: 'box' },
    h('h2', null, \`카운트: \${count}\`),
    h('button', { onClick: () => setCount(count + 1) }, '+1'),
    h('button', { onClick: () => setCount(0) }, '초기화'),
  );
}
`,
  },
  {
    id: 'todo',
    name: '할 일 목록',
    desc: '제어 입력창 + 리스트. 항목에 key 를 줘서 추가/삭제 시 바뀐 항목만 INSERT / REMOVE 됩니다.',
    try: [
      'key: t.id 를 지우고 맨 위 항목을 삭제해 보세요. 패치가 어떻게 달라지나요?',
      '완료 체크 기능을 추가해 보세요. (힌트: { ...t, done: !t.done })',
      '남은 개수를 useMemo 로 계산해 보세요.',
    ],
    code: `function App() {
  const [todos, setTodos] = useState([
    { id: 1, text: 'Virtual DOM 공부' },
    { id: 2, text: 'Diff 구현' },
  ]);
  const [text, setText] = useState('');

  const add = () => {
    if (!text.trim()) return;
    setTodos((list) => [...list, { id: Date.now(), text: text.trim() }]);
    setText('');
  };
  const remove = (id) => setTodos((list) => list.filter((t) => t.id !== id));

  return h('div', { class: 'box' },
    h('form', { onSubmit: (e) => { e.preventDefault(); add(); } },
      h('input', { value: text, placeholder: '할 일', onInput: (e) => setText(e.target.value) }),
      h('button', { type: 'submit' }, '추가'),
    ),
    h('ul', null,
      todos.map((t) =>
        h('li', { key: t.id },
          t.text, ' ',
          h('button', { onClick: () => remove(t.id) }, '삭제'),
        ),
      ),
    ),
  );
}
`,
  },
  {
    id: 'timer',
    name: '타이머',
    desc: 'useEffect 로 setInterval 을 등록하고, cleanup 에서 clearInterval 합니다.',
    try: [
      'return () => clearInterval(id) 줄을 지우고 시작/정지를 반복해 보세요.',
      '의존성 배열 [running] 을 [] 로 바꾸면 어떻게 될까요?',
      'Inspector 타임라인에서 useEffect 가 화면을 그린 "뒤" 에 실행되는 것을 확인하세요.',
    ],
    code: `function App() {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id); // 정리(cleanup)
  }, [running]);

  return h('div', { class: 'box' },
    h('h2', null, \`\${seconds}초\`),
    h('button', { onClick: () => setRunning((r) => !r) }, running ? '정지' : '시작'),
    h('button', { onClick: () => setSeconds(0) }, '리셋'),
  );
}
`,
  },
  {
    id: 'filter',
    name: '검색 필터',
    desc: 'useMemo 로 검색 결과를 계산합니다. 관계없는 state 가 바뀌어도 다시 계산하지 않습니다.',
    try: [
      '"관계없는 리렌더" 를 눌러도 계산 횟수가 그대로인지 확인하세요.',
      'useMemo 의 의존성 배열을 지우면?',
      '정렬 기능(가나다 순)을 추가해 보세요.',
    ],
    code: `const FRUITS = ['사과', '바나나', '포도', '딸기', '수박', '참외', '복숭아', '자두', '망고', '키위'];

function App() {
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const count = useRef(0);

  const result = useMemo(() => {
    count.current++;
    return FRUITS.filter((f) => f.includes(query));
  }, [query]);

  return h('div', { class: 'box' },
    h('input', { value: query, placeholder: '검색', onInput: (e) => setQuery(e.target.value) }),
    h('button', { onClick: () => setTick((t) => t + 1) }, \`관계없는 리렌더 (\${tick})\`),
    h('p', null, \`필터 계산 \${count.current}회 · 결과 \${result.length}개\`),
    h('ul', null, result.map((f) => h('li', { key: f }, f))),
  );
}
`,
  },
  {
    id: 'props',
    name: '자식 컴포넌트 + props',
    desc: 'state 는 App 에만 두고, 자식은 props 와 콜백만 받는 순수 함수 (Lifting State Up).',
    try: [
      'Counter 를 하나 더 추가해 보세요. 두 개의 합계는 어디에 둬야 할까요?',
      'Counter 안에서 useState 를 호출하면 어떤 에러가 날까요?',
    ],
    code: `// 자식 컴포넌트: state 없이 props 만 받는다
function Counter({ label, value, onChange }) {
  return h('div', { class: 'row' },
    h('b', null, \`\${label}: \${value}\`),
    h('button', { onClick: () => onChange(value - 1) }, '−'),
    h('button', { onClick: () => onChange(value + 1) }, '+'),
  );
}

function App() {
  const [apples, setApples] = useState(1);
  const [pears, setPears] = useState(2);

  return h('div', { class: 'box' },
    h(Counter, { label: '사과', value: apples, onChange: setApples }),
    h(Counter, { label: '배', value: pears, onChange: setPears }),
    h('p', null, \`합계: \${apples + pears}\`),
  );
}
`,
  },
  {
    id: 'reducer',
    name: 'useReducer',
    desc: '상태 변경 규칙을 reducer 한 곳에 모읍니다. 컴포넌트는 "무슨 일이 일어났는지" 만 dispatch.',
    try: ['"reset" 액션과 "double" 액션을 추가해 보세요.'],
    code: `function reducer(state, action) {
  switch (action.type) {
    case 'inc': return { count: state.count + action.step };
    case 'dec': return { count: state.count - action.step };
    default: return state;
  }
}

function App() {
  const [state, dispatch] = useReducer(reducer, { count: 0 });
  const [step, setStep] = useState(1);

  return h('div', { class: 'box' },
    h('h2', null, state.count),
    h('label', null, '한 번에 ',
      h('input', { type: 'number', value: step, style: { width: '60px' }, onInput: (e) => setStep(Number(e.target.value) || 1) }),
    ),
    h('button', { onClick: () => dispatch({ type: 'dec', step }) }, '−'),
    h('button', { onClick: () => dispatch({ type: 'inc', step }) }, '+'),
  );
}
`,
  },
  {
    id: 'context',
    name: '테마 (Context)',
    desc: 'createContext + useContext 로 중간 컴포넌트를 거치지 않고 값을 전달합니다.',
    try: ['UserContext 를 하나 더 만들어 사용자 이름도 전달해 보세요.'],
    code: `const Theme = createContext('light');

function Button({ children }) {
  const theme = useContext(Theme); // props 없이 바로 꺼냄
  return h('button', { class: theme === 'dark' ? 'dark' : '' }, children, \` (\${theme})\`);
}
function Toolbar() {
  return h('div', { class: 'row' }, h(Button, null, '저장'), h(Button, null, '취소'));
}

function App() {
  const [theme, setTheme] = useState('light');
  return h('div', { class: 'box' },
    h('button', { onClick: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')) }, '테마 바꾸기'),
    h(Theme.Provider, { value: theme }, h(Toolbar)),
  );
}
`,
  },
  {
    id: 'form',
    name: '폼 검증',
    desc: '입력값은 state, 에러 메시지는 계산값. 검증 결과에 따라 class 만 바뀝니다 (PROPS).',
    try: ['비밀번호 확인 칸을 추가해 보세요.', '제출하면 환영 화면으로 바뀌게 해 보세요 (REPLACE).'],
    code: `function App() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');

  const errors = useMemo(() => ({
    email: /^\\S+@\\S+\\.\\S+$/.test(email) ? '' : '이메일 형식이 아닙니다',
    pw: pw.length >= 8 ? '' : '8자 이상 입력하세요',
  }), [email, pw]);
  const ok = !errors.email && !errors.pw;

  return h('div', { class: 'box' },
    h('input', { value: email, placeholder: '이메일', class: errors.email ? 'bad' : 'good', onInput: (e) => setEmail(e.target.value) }),
    h('small', null, errors.email || '좋아요 ✓'),
    h('input', { type: 'password', value: pw, placeholder: '비밀번호', class: errors.pw ? 'bad' : 'good', onInput: (e) => setPw(e.target.value) }),
    h('small', null, errors.pw || '좋아요 ✓'),
    h('button', { disabled: !ok }, ok ? '가입하기' : '입력을 확인하세요'),
  );
}
`,
  },
];

/** 조각: { label, code } — code 의 들여쓰기는 커서가 있는 줄에 맞춰진다 */
export const SNIPPETS = [
  { group: 'Hook', label: 'useState', code: 'const [value, setValue] = useState(0);' },
  { group: 'Hook', label: 'useEffect', code: 'useEffect(() => {\n  // 화면을 그린 뒤 실행\n  return () => {\n    // 정리(cleanup)\n  };\n}, []);' },
  { group: 'Hook', label: 'useLayoutEffect', code: 'useLayoutEffect(() => {\n  // DOM 반영 직후, 그리기 전에 실행\n}, []);' },
  { group: 'Hook', label: 'useMemo', code: 'const computed = useMemo(() => {\n  return value * 2;\n}, [value]);' },
  { group: 'Hook', label: 'useRef', code: 'const ref = useRef(0); // ref.current 는 바꿔도 다시 그리지 않음' },
  { group: 'Hook', label: 'useReducer', code: 'const [state, dispatch] = useReducer((s, a) => (a.type === \'inc\' ? s + 1 : s), 0);' },
  { group: '화면', label: '버튼', code: "h('button', { onClick: () => setValue((v) => v + 1) }, '클릭'),", },
  { group: '화면', label: '입력창', code: "h('input', { value: text, placeholder: '입력', onInput: (e) => setText(e.target.value) }),", },
  { group: '화면', label: '체크박스', code: "h('label', null,\n  h('input', { type: 'checkbox', checked: on, onChange: (e) => setOn(e.target.checked) }),\n  ' 켜기',\n),", },
  { group: '화면', label: '리스트 + key', code: "h('ul', null,\n  items.map((item) => h('li', { key: item.id }, item.text)),\n),", },
  { group: '화면', label: '조건부 렌더링', code: "value > 3 && h('p', null, '3보다 커요!'),", },
  { group: '화면', label: 'style 객체', code: "h('div', { style: { color: 'tomato', fontSize: '20px' } }, '스타일'),", },
  { group: '구조', label: '자식 컴포넌트', code: "function Child({ label, onClick }) {\n  return h('button', { onClick }, label);\n}", },
  { group: '구조', label: 'Context', code: "const MyContext = createContext('기본값');\n// 감싸기: h(MyContext.Provider, { value: '값' }, h(Child))\n// 꺼내기: const v = useContext(MyContext);", },
  { group: '디버깅', label: 'console.log', code: "console.log('값:', value);", },
];
