/**
 * 미니 DBMS 샌드박스 틀과 조각
 *  쓸 수 있는 것: sql(text), db, tokenize, parse, BPlusTree, seedRows, print, sleep, time, redis
 *  테이블: users(id, name, age, email) · products(id, name, price, category) · posts(id, title, author)
 */
export const TEMPLATES = [
  {
    id: 'sql',
    title: 'SQL 실행',
    desc: 'INSERT 후 여러 가지 SELECT. 실행 계획(인덱스 / 범위 / 선형)을 확인하세요.',
    try: ["WHERE name = '박레디스' 를 WHERE id = 3 으로 바꿔 실행 계획 비교", 'LIMIT 1 붙여 보기', '에러가 나는 SQL 을 일부러 써서 행·열 위치 보기'],
    code: `sql(\`INSERT INTO users (name, age, email) VALUES
  ('김정글', 25, 'jungle@ex.com'), ('이리액트', 31, 'react@ex.com'), ('박레디스', 28, NULL)\`);

sql('SELECT * FROM users WHERE id = 2');                 // B+ 트리
sql('SELECT name FROM users WHERE id BETWEEN 1 AND 2'); // 범위
sql("SELECT * FROM users WHERE name = '박레디스'");      // 선형 탐색

// 에러도 확인해 보세요
try { sql('SELECT phone FROM users'); } catch (e) { print('에러:', e.message); }`,
  },
  {
    id: 'parse',
    title: '토큰과 AST 보기',
    desc: 'SQL 이 토큰으로 잘리고 AST(구조)로 바뀌는 과정을 직접 출력합니다.',
    try: ["문자열에 'O''Brien' 을 넣고 토큰 확인", 'BETWEEN 이 AST 에서 어떻게 바뀌는지', '일부러 FROM 을 빼서 에러 메시지 읽기'],
    code: `const text = "SELECT name, age FROM users WHERE age >= 20 AND id BETWEEN 1 AND 9 LIMIT 3";

print('① 토큰:');
print(tokenize(text).map((t) => t.type + ':' + t.value).join('  '));

print('② AST:');
const [ast] = parse(text);
print({ type: ast.type, table: ast.table, columns: ast.columns, where: ast.where.map((w) => \`\${w.column} \${w.op} \${w.value.value}\`), limit: ast.limit });

try { parse('SELECT * users'); } catch (e) { print('③ 에러:', e.message); }`,
  },
  {
    id: 'bptree',
    title: 'B+ 트리 직접 쓰기',
    desc: '차수 3 트리에 1~15 를 넣으며 높이와 분할을 출력합니다.',
    try: ['차수를 3 → 5 로', '1~15 대신 무작위 순서로 넣어 보기', 'range(5, 9) 를 다른 범위로'],
    code: `const t = new BPlusTree(3);
for (let k = 1; k <= 15; k++) {
  const h = t.height;
  t.insert(k, 'row' + k);
  if (t.height > h) print(k + ' 넣을 때 높이 ' + h + ' → ' + t.height);
}
print('층별 노드:');
t.levels().forEach((level, i) => print('  ' + i + '층', level.map((n) => '[' + n.keys.join(' ') + ']').join(' ')));
print('7 찾기 경로 길이:', t.trace(7).path.length, '/ 분할 횟수:', t.stats.splits);
print('범위 5~9:', [...t.range(5, 9)].map(([k]) => k));`,
  },
  {
    id: 'bench',
    title: '대용량 성능 비교',
    desc: '2만 건을 만들고 id 조회와 email 조회 시간을 비교합니다.',
    try: ['20000 → 100000 으로 늘려 두 시간이 어떻게 변하는지', '조회할 email 번호를 앞쪽(10)으로 바꾸면?', 'B+ 트리 높이 변화 보기'],
    code: `time('2만 건 INSERT', () => seedRows(db, 'users', 20000));

time('id 로 100번', () => {
  for (let i = 0; i < 100; i++) db.execute('SELECT * FROM users WHERE id = ' + (1 + i * 199));
});
time('email 로 5번', () => {
  for (let i = 0; i < 5; i++) db.execute(\`SELECT * FROM users WHERE email = 'user\${15000 + i}@jungle.test'\`);
});
print('B+ 트리 높이:', db.tables.users.index.height);`,
  },
  {
    id: 'escape',
    title: '따옴표와 SQL 인젝션',
    desc: '입력값을 그대로 이어 붙이면 무슨 일이 생기는지 직접 봅니다.',
    try: ['quote() 를 쓰는 줄과 안 쓰는 줄의 결과 비교', '해커 입력을 다른 문장으로 바꿔 보기', 'users 행 수를 출력해 몇 줄 늘었는지 확인'],
    code: `const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const hacker = "해커', 1, 'h@x'), ('관리자', 99, 'admin@x') -- ";

// 안전: 따옴표 이스케이프
sql(\`INSERT INTO users (name, age, email) VALUES (\${quote("O'Brien")}, 40, 'ob@ex.com')\`);

// 위험: 그대로 이어 붙임 → 한 번 가입에 두 줄!
sql(\`INSERT INTO users (name, age, email) VALUES ('\${hacker}', 20, 'x@x')\`);

sql('SELECT * FROM users');`,
  },
  {
    id: 'both',
    title: '레디스 + DBMS 함께',
    desc: 'SQL 결과를 레디스에 캐시하고, INSERT 하면 태그로 무효화합니다.',
    try: ['INVALIDATE 줄을 지우고 3) 결과 비교', 'EX 60 을 PX 100 으로 바꾸고 sleep 넣기', '캐시 HIT 일 때와 MISS 일 때 시간 재기'],
    code: `db.execute("INSERT INTO users (name) VALUES ('김정글'), ('이리액트')");

function latestUsers() {
  const hit = redis.exec('GET cache:users');
  if (hit) { print('  → 캐시 HIT'); return JSON.parse(hit); }
  print('  → 캐시 MISS, DB 조회');
  const [r] = db.execute('SELECT id, name FROM users WHERE id > 0 LIMIT 5');
  redis.command(['SET', 'cache:users', JSON.stringify(r.rows), 'EX', '60']);
  redis.exec('TAG cache:users users');
  return r.rows;
}
function addUser(name) {
  db.execute(\`INSERT INTO users (name) VALUES ('\${name}')\`);
  print('  → 무효화한 키:', redis.exec('INVALIDATE users'));
}

print('1)', latestUsers());
print('2)', latestUsers());
addUser('새회원');
print('3)', latestUsers());`,
  },
  {
    id: 'blank',
    title: '빈 틀',
    desc: '처음부터 직접. sql(), db, tokenize, parse, BPlusTree 를 쓸 수 있어요.',
    try: ['아래 조각 버튼으로 시작해 보기'],
    code: `// sql(), db, tokenize, parse, BPlusTree, seedRows, print(), sleep(), time() 을 쓸 수 있어요.
`,
  },
];

export const SNIPPETS = [
  { label: 'SQL', items: [['INSERT', "sql(\"INSERT INTO users (name, age, email) VALUES ('이름', 20, 'a@b.c')\");"], ['SELECT id', "sql('SELECT * FROM users WHERE id = 1');"], ['SELECT 범위', "sql('SELECT id, name FROM users WHERE id BETWEEN 1 AND 10');"], ['SELECT 조건', "sql(\"SELECT * FROM users WHERE age >= 20 LIMIT 5\");"]] },
  { label: '처리기', items: [['토큰', "print(tokenize('SELECT * FROM users').map((t) => t.value));"], ['AST', "print(parse('SELECT * FROM users WHERE id = 1')[0]);"], ['대용량', "seedRows(db, 'users', 10000);"]] },
  { label: 'B+ 트리', items: [['만들기', "const tree = new BPlusTree(4);\ntree.insert(1, 'a');\nprint(tree.levels());"], ['인덱스 보기', 'print(db.tables.users.index.levels().length, "층");']] },
  { label: '도구', items: [['시간 재기', "time('이름', () => {\n  // 잴 코드\n});"], ['반복', 'for (let i = 0; i < 10; i++) {\n  \n}'], ['기다리기', 'await sleep(500);']] },
];
