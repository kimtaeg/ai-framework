// 미니 DBMS 핵심 코드 해설 데이터 (일반 스크립트: 파일을 더블클릭해서 열어도 동작)
// 코드 조각은 실제 코드에서 주석만 줄여 옮긴 것이다.
// must: 실제 파일에 반드시 있어야 하는 줄 — tests/week2-learning.test.js 가 확인한다 (해설과 코드가 어긋나지 않게)
window.WALKTHROUGH = {
  store: 'mini-dbms-walkthrough',
  sections: [
    {
      id: 'tokenize', group: 'Phase 1 · SQL 처리기', file: 'week2/dbms/sql.js',
      title: 'tokenize — SQL 을 토큰으로',
      summary: '글자를 하나씩 보며 공백·주석은 건너뛰고, 문자열·숫자·이름·기호를 토큰으로 자릅니다. 위치(행, 열)도 함께 저장합니다.',
      must: ["if (src[i + 1] === \"'\") { s += \"'\"; advance(2); continue; }", "tokens.push(KEYWORDS.has(up) ? { type: 'keyword'", "throw new SqlError(`알 수 없는 문자 '${c}'`, p);"],
      chunks: [
        { code: `if (c === "'") {
  advance();
  let s = '';
  for (;;) {
    if (i >= src.length) throw new SqlError('문자열의 따옴표가 닫히지 않았습니다.', p);
    if (src[i] === "'") {
      if (src[i + 1] === "'") { s += "'"; advance(2); continue; }
      advance(); break;
    }
    s += src[i]; advance();
  }`, note: "문자열 안의 '' 는 따옴표 하나(SQL 표준 이스케이프). 끝까지 안 닫히면 시작 위치를 담아 에러. 그래서 'O''Brien' 이 O'Brien 이 됩니다." },
        { code: `if (/[A-Za-z_]/.test(c)) {
  const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  const up = m[0].toUpperCase();
  tokens.push(KEYWORDS.has(up) ? { type: 'keyword', value: up, pos: p } : { type: 'ident', value: m[0], pos: p });`, note: '단어는 대문자로 바꿔 예약어 목록에 있으면 keyword(SELECT, FROM …), 아니면 ident(테이블·열 이름). 그래서 select 와 SELECT 가 같습니다.' },
      ],
      explain: { q: '토크나이저는 무엇을 하고 왜 필요한가요?', a: '문자열을 의미 있는 조각(예약어, 이름, 숫자, 문자열, 기호)으로 자르는 단계입니다. 공백·주석·이스케이프 같은 글자 수준의 일을 여기서 끝내 두면, 파서는 토큰 순서만 보고 문법을 판단할 수 있습니다. 각 토큰의 행·열을 저장해 에러 위치도 알려 줍니다.' },
    },
    {
      id: 'parse', group: 'Phase 1 · SQL 처리기', file: 'week2/dbms/sql.js',
      title: 'parse · select · condition — 재귀 하강 파서',
      summary: '문법 규칙 하나를 함수 하나로 씁니다. 토큰을 앞에서부터 기대하는 순서대로 소비하며 AST(구조화된 객체)를 만듭니다.',
      must: ['function select(start) {', "expect('keyword', 'FROM');", "if (is('keyword', 'BETWEEN')) {", "return { type: 'select', table, columns, where, limit, pos: start };"],
      chunks: [
        { code: `function select(start) {
  let columns;
  if (is('symbol', '*')) { next(); columns = '*'; }
  else { columns = [ident('열 이름')]; while (is('symbol', ',')) { next(); columns.push(ident('열 이름')); } }
  expect('keyword', 'FROM');
  const table = ident('테이블 이름');`, note: "SELECT 다음은 * 또는 '이름, 이름, …'. 그다음 반드시 FROM — expect() 는 다른 토큰이 오면 \"'FROM' 이(가) 필요한데 … 이(가) 있습니다 (1행 10열)\" 에러를 냅니다." },
        { code: `function condition() {
  const column = ident('열 이름');
  if (is('keyword', 'BETWEEN')) {
    next(); const lo = value(); expect('keyword', 'AND'); const hi = value();
    return [{ column, op: '>=', value: lo }, { column, op: '<=', value: hi }];
  }
  ...
  return [{ column, op, value: value() }];
}`, note: 'BETWEEN a AND b 는 파싱 단계에서 >= a 와 <= b 두 조건으로 풀어 둡니다. 실행기는 비교 연산만 알면 되고, 실행 계획도 범위 조건으로 자연스럽게 인덱스를 씁니다.' },
        { code: `return { type: 'select', table, columns, where, limit, pos: start };`, note: '결과는 { type, table, columns, where:[{column, op, value}], limit } 같은 평범한 객체(AST). 실행기는 문자열을 다시 보지 않고 이 구조만 씁니다.' },
      ],
      explain: { q: '파싱 결과(AST)는 어떻게 생겼고 왜 문자열 대신 이걸 실행하나요?', a: "예를 들어 SELECT name FROM users WHERE id = 3 은 { type:'select', table:'users', columns:['name'], where:[{column:'id', op:'=', value:3}] } 이 됩니다. 문법 검사가 끝난 구조라 실행기는 문자열 처리 없이 표·조건·열만 보고 동작하고, 계획(인덱스 사용 여부)도 이 구조로 정합니다." },
    },
    {
      id: 'insert', group: 'Phase 1 · SQL 처리기', file: 'week2/dbms/engine.js',
      title: 'Database.insert — 검사, id 부여, 저장, 인덱스 등록',
      summary: '모든 행을 먼저 검사하고(하나라도 틀리면 아무것도 저장 안 함), 그다음 id 를 붙여 파일 끝에 쓰고 B+ 트리에 위치를 등록합니다.',
      must: ['const prepared = st.rows.map((row, r) => {', 'const id = t.nextId++;', 'const loc = this.storage.append(t.name, encodeRow(values));', 't.index.insert(id, loc);'],
      chunks: [
        { code: `const prepared = st.rows.map((row, r) => {
  const values = new Array(t.columns.length).fill(null);
  row.forEach((v, k) => (values[colIdx[k]] = coerce(v, t.columns[colIdx[k]], st.pos)));
  return values;
});`, note: '저장 전에 모든 행의 형을 검사·변환합니다(INT 열에 글자 → 에러). 검사를 먼저 끝내니 여러 행 중 하나가 틀려도 반만 저장되는 일이 없습니다(문장 단위 원자성).' },
        { code: `for (const values of prepared) {
  const id = t.nextId++;
  values[0] = id;
  const loc = this.storage.append(t.name, encodeRow(values));
  t.index.insert(id, loc);
}`, note: 'id 는 1씩 자동 증가. 한 줄로 인코딩해 파일 끝에 붙이면 저장소가 그 줄의 시작 위치(바이트 offset)를 돌려주고, B+ 트리에 id → 위치를 등록합니다. 나중에 WHERE id = ? 가 이 위치로 바로 갑니다.' },
      ],
      explain: { q: 'INSERT 한 건이 처리되는 과정을 설명해 보세요.', a: '파서가 만든 AST 의 값들을 테이블 스키마에 맞춰 검사·변환하고, 통과하면 nextId 로 id 를 붙여 한 줄로 인코딩한 뒤 파일 끝에 추가합니다. 저장소가 돌려준 그 줄의 시작 위치를 B+ 트리에 id → 위치로 등록해서 이후 id 조회가 그 줄만 읽게 합니다.' },
    },
    {
      id: 'select', group: 'Phase 1 · SQL 처리기', file: 'week2/dbms/engine.js',
      title: 'select · choosePlan — 실행 계획',
      summary: 'id 조건이 있으면 B+ 트리, 없으면 파일 전체를 훑습니다. 어떤 계획을 썼고 몇 개를 읽었는지 결과에 남깁니다.',
      must: ["const eq = idConds.find((c) => c.op === '=');", "return { type: 'index-lookup', key: eq.value", "for (const [, loc] of t.index.range(plan.lo, plan.hi)) {", 'for (const [, line] of this.storage.scan(t.name)) {'],
      chunks: [
        { code: `function choosePlan(conds, t) {
  const idConds = conds.filter((c) => c.i === 0 && c.op !== '!=' && c.value !== null);
  const eq = idConds.find((c) => c.op === '=');
  if (eq) return { type: 'index-lookup', key: eq.value, ... };
  if (idConds.length) { /* lo, hi 계산 */ return { type: 'index-range', lo, hi, ... }; }
  return { type: 'full-scan', ... };
}`, note: 'id 열(0번)의 = 조건 → 인덱스 한 번 찾기, >,<,BETWEEN → 인덱스 범위, 그 외(name = …, id != …) → 전체 읽기. 아주 작은 규칙 기반 최적화기(planner)입니다.' },
        { code: `if (plan.type === 'index-lookup') {
  const loc = t.index.get(plan.key);
  if (loc !== undefined) take(this.storage.read(t.name, loc));
} else if (plan.type === 'index-range') {
  for (const [, loc] of t.index.range(plan.lo, plan.hi)) { take(this.storage.read(t.name, loc)); ... }
} else {
  for (const [, line] of this.storage.scan(t.name)) { take(line); ... }
}`, note: '어느 경로든 읽은 줄은 take() 로 들어가 디코딩 → 모든 WHERE 조건 검사 → 열 선택. 계획은 "어떤 줄을 읽을지" 만 정하고 조건 검사는 공통이라, 인덱스를 써도 다른 조건이 함께 적용됩니다.' },
      ],
      explain: { q: 'WHERE id = ? 와 WHERE email = ? 는 내부에서 어떻게 다르게 실행되나요?', a: 'choosePlan 이 id 의 = 조건을 보면 index-lookup 을 골라 B+ 트리에서 위치를 찾고 그 줄 하나만 읽습니다. email 은 인덱스가 없어서 full-scan 으로 파일을 처음부터 끝까지 읽으며 비교합니다. 100만 건에서 0.038ms 대 1초로 약 2만 7천 배 차이가 났습니다.' },
    },
    {
      id: 'file', group: 'Phase 1 · SQL 처리기', file: 'week2/dbms/storage-file.js',
      title: 'FileStorage.append · read — 위치(offset)로 한 줄 읽기',
      summary: '쓸 때는 지금 파일 크기가 곧 새 레코드의 위치입니다. 읽을 때는 그 위치부터 줄바꿈까지만 읽습니다.',
      must: ['const loc = f.size; // 이 레코드가 시작할 위치', 'if (f.bufferBytes >= FLUSH_AT) this.#flushFile(f);', 'const n = readSync(f.fd, buf, len, buf.length - len, loc + len);'],
      chunks: [
        { code: `append(table, line) {
  const f = this.#file(table);
  const bytes = Buffer.from(line + '\\n', 'utf8');
  const loc = f.size;      // 이 레코드가 시작할 위치
  f.size += bytes.length;
  f.buffer.push(bytes);
  if (f.bufferBytes >= FLUSH_AT) this.#flushFile(f);
  return loc;
}`, note: '파일 끝에 붙이므로 "지금 크기 = 새 줄의 시작 바이트". 글자 수가 아니라 UTF-8 바이트 수로 세야 한글이 있어도 위치가 맞습니다. 1MB 씩 모아 한 번에 써서 100만 건 INSERT 가 2초에 끝납니다.' },
        { code: `read(table, loc) {
  this.#flushFile(f);
  let buf = Buffer.alloc(256), len = 0;
  for (;;) {
    const n = readSync(f.fd, buf, len, buf.length - len, loc + len);
    const nl = buf.indexOf(10, len);
    if (nl !== -1 && nl < len + n) return buf.toString('utf8', 0, nl);
    len += n;  /* 줄이 더 길면 버퍼를 2배로 */
  }
}`, note: '위치부터 256바이트를 읽고 줄바꿈(10)이 보이면 거기까지가 레코드. 더 길면 버퍼를 키워 이어서 읽습니다. 파일 전체를 읽지 않으니 100만 건 파일에서도 한 번의 짧은 읽기.' },
      ],
      explain: { q: 'B+ 트리에는 무엇을 저장하고, 그걸로 어떻게 레코드를 읽나요?', a: 'id 마다 그 레코드가 파일에서 시작하는 바이트 위치(offset)를 저장합니다. 조회할 때는 그 위치로 바로 가서(readSync 의 position) 줄바꿈이 나올 때까지만 읽습니다. 한 줄 = 한 레코드 형식이라 가능하고, 위치는 쓸 때의 파일 크기로 정해집니다.' },
    },
    {
      id: 'bptree', group: 'Phase 2 · B+ 트리', file: 'week2/dbms/bptree.js',
      title: 'BPlusTree.insert — 분할과 위로 자라기',
      summary: '리프에 정렬해서 넣고, 넘치면 반으로 쪼개 부모에 키를 올립니다. 부모도 넘치면 위로 반복, 루트가 쪼개지면 높이 +1.',
      must: ['if (leaf.keys.length > this.maxKeys) this.#splitLeaf(leaf, path);', 'this.#insertIntoParent(leaf, right.keys[0], right, path);', 'const upKey = node.keys[mid];', "this.root = { leaf: false, keys: [key], children: [left, right] };"],
      chunks: [
        { code: `insert(key, value) {
  const path = [];
  const leaf = this.#findLeaf(key, path);
  const i = BPlusTree.lowerBound(leaf.keys, key);
  if (leaf.keys[i] === key) throw new Error(\`이미 있는 키입니다: \${key}\`);
  leaf.keys.splice(i, 0, key);
  leaf.values.splice(i, 0, value);
  if (leaf.keys.length > this.maxKeys) this.#splitLeaf(leaf, path);
}`, note: '루트에서 이진 탐색으로 내려가며 지나간 노드를 path 에 기억합니다(부모 포인터 대신). 리프의 정렬 위치에 넣고, 키가 차수-1 개를 넘으면 분할.' },
        { code: `#splitLeaf(leaf, path) {
  const mid = Math.ceil(leaf.keys.length / 2);
  const right = { leaf: true, keys: leaf.keys.splice(mid), values: leaf.values.splice(mid), next: leaf.next };
  leaf.next = right;
  this.#insertIntoParent(leaf, right.keys[0], right, path);
}`, note: '리프는 반으로 나누고 오른쪽의 첫 키를 "복사" 해서 부모로 올립니다(데이터는 리프에 남음). leaf.next 로 새 리프를 이어서 범위 검색용 연결 리스트를 유지합니다.' },
        { code: `#splitInternal(node, path) {
  const mid = Math.floor(node.keys.length / 2);
  const upKey = node.keys[mid];
  const right = { leaf: false, keys: node.keys.splice(mid + 1), children: node.children.splice(mid + 1) };
  node.keys.length = mid;
  this.#insertIntoParent(node, upKey, right, path);
}
// 부모가 없으면(루트였으면): this.root = { leaf: false, keys: [key], children: [left, right] }; height++`, note: '내부 노드는 가운데 키를 "이동" 해서 올립니다(양쪽 어디에도 안 남음). 루트까지 넘치면 새 루트가 생겨 높이가 1 늘어납니다 — 트리는 위로 자라서 모든 리프가 항상 같은 깊이.' },
      ],
      explain: { q: 'B+ 트리에서 노드가 꽉 찼을 때 어떻게 되나요?', a: '키가 차수-1 개를 넘으면 노드를 반으로 나눕니다. 리프는 오른쪽 첫 키를 복사해서, 내부 노드는 가운데 키를 이동해서 부모에 넣습니다. 부모도 넘치면 같은 일을 위로 반복하고, 루트가 쪼개지면 새 루트가 생겨 높이가 늘어납니다. 그래서 모든 리프가 같은 깊이를 유지해 검색이 항상 O(log n) 입니다.' },
    },
    {
      id: 'lock', group: 'Phase 3 · API 서버', file: 'week2/dbms/lock.js',
      title: 'RWLock.#drain — 읽기는 함께, 쓰기는 혼자',
      summary: '대기열 맨 앞부터 보면서 지금 들여보낼 수 있는 요청을 들여보냅니다. 맨 앞이 못 들어가면 뒤도 기다립니다(공정성).',
      must: ["if (head.mode === 'write') {", 'if (this.writer || this.readers > 0) return;', 'if (this.writer) return;', 'this.readers++;'],
      chunks: [
        { code: `#drain() {
  while (this.queue.length) {
    const head = this.queue[0];
    if (head.mode === 'write') {
      if (this.writer || this.readers > 0) return;   // 누가 있으면 기다림
      this.writer = true;
      this.queue.shift(); head.resolve(this.#release('write'));
      return;
    }
    if (this.writer) return;
    this.readers++;
    this.queue.shift(); head.resolve(this.#release('read'));
  }
}`, note: '쓰기는 아무도 없을 때만(배타). 읽기는 쓰는 중이 아니면 몇 개든(공유). 중요한 점: 맨 앞이 쓰기라 기다리면 그 뒤에 온 읽기도 못 들어갑니다 → 읽기가 끝없이 와도 쓰기가 굶지 않습니다.' },
        { code: `async acquire({ read = [], write = [] }) {
  ...
  const order = [...modes.keys()].sort();
  for (const t of order) releases.push(await this.#lock(t).acquire(modes.get(t)));
  return () => releases.reverse().forEach((r) => r());
}`, note: '(LockManager) 여러 테이블을 잠글 때는 항상 이름 순서로. 모두가 같은 순서로 잡으면 "A 를 쥐고 B 를 기다리는데 상대는 B 를 쥐고 A 를 기다리는" 교착 상태가 생길 수 없습니다.' },
      ],
      explain: { q: '읽기/쓰기 락은 어떻게 동작하고, 기아와 교착은 어떻게 막았나요?', a: '읽기끼리는 동시에 여러 개 허용하고 쓰기는 혼자만 들어가게 합니다. 대기열을 순서대로 처리해서 맨 앞의 쓰기가 기다리면 뒤의 읽기도 기다리게 해 쓰기 기아를 막고, 여러 테이블은 항상 이름 순서로 잠가 교착 상태를 막았습니다.' },
    },
    {
      id: 'pool', group: 'Phase 3 · API 서버', file: 'week2/dbms/pool.js',
      title: 'ThreadPool — 일 나눠 주기와 알림',
      summary: '요청은 큐에 넣고, 쉬는 워커를 돌아가며 찾아 맡깁니다. 워커가 죽으면 새로 만들고, 너무 오래 걸리면 끊습니다.',
      must: ['const job = this.queue.shift();', "slot.worker.postMessage({ type: 'task', seq: job.seq, task: job.task });", "for (const w of this.workers) if (w.id !== except) w.worker.postMessage({ type: 'notify', message });"],
      chunks: [
        { code: `#next() {
  while (this.queue.length) {
    /* rr 부터 돌며 ready && !busy 인 워커 찾기 */
    if (!slot) return;
    const job = this.queue.shift();
    job.timer = setTimeout(() => this.#crash(slot, new Error(...)), this.timeoutMs);
    slot.busy = job;
    slot.worker.postMessage({ type: 'task', seq: job.seq, task: job.task });
  }
}`, note: '쉬는 워커가 있는 동안 큐에서 꺼내 보냅니다. 모두 바쁘면 그대로 큐에 남고, 워커가 결과를 보내오면 다시 #next(). 시간 제한을 넘기면 그 워커를 끝내고 새로 만들어 서버 전체가 멈추지 않게 합니다.' },
        { code: `broadcast(message, except = -1) {
  for (const w of this.workers) if (w.id !== except) w.worker.postMessage({ type: 'notify', message });
}`, note: '모든 워커에 알림. 워커 하나가 받은 메시지는 보낸 순서대로 처리되므로, 알림을 먼저 보내면 그 뒤에 그 워커에게 가는 조회는 반드시 알림이 반영된 다음에 실행됩니다.' },
      ],
      explain: { q: '스레드 풀은 요청을 어떻게 처리하나요? 왜 요청마다 스레드를 만들지 않나요?', a: '처음에 워커 N 개를 만들어 두고, 요청이 오면 큐에 넣었다가 쉬는 워커에게 돌아가며 맡깁니다. 모두 바쁘면 큐에서 기다립니다. 요청마다 스레드를 만들면 생성 비용이 크고 요청이 몰릴 때 스레드가 끝없이 늘어 메모리와 CPU 가 바닥나기 때문입니다.' },
    },
    {
      id: 'service', group: 'Phase 3 · API 서버', file: 'week2/dbms/service.js',
      title: 'createDbService.query — 락 · 실행 · 인덱스 공유',
      summary: 'API 서버의 중심. 파싱으로 읽기/쓰기를 판단하고, 락을 잡고, 워커에 실행을 맡기고, 새 인덱스를 다른 워커에 알린 뒤 락을 풉니다.',
      must: ['const { writes, reads } = Database.analyze(sql);', 'const release = await locks.acquire({ read: reads, write: writes });', "if (res.type === 'insert' && res.entries.length) pool.broadcast({ type: 'index', table: res.table, entries: res.entries }, r.workerId);", 'release();'],
      chunks: [
        { code: `const { writes, reads } = Database.analyze(sql);   // 문법 에러는 여기서 바로
const release = await locks.acquire({ read: reads, write: writes });
try {
  const r = await pool.run({ sql, delayMs });`, note: '메인 스레드에서 먼저 파싱해 어떤 테이블을 읽고 쓰는지 알아냅니다. 문법이 틀리면 워커를 쓰지도 않고 400. 그다음 테이블별 읽기/쓰기 락을 잡고 워커에게 맡깁니다.' },
        { code: `  for (const res of r.result) {
    if (res.type === 'insert' && res.entries.length)
      pool.broadcast({ type: 'index', table: res.table, entries: res.entries }, r.workerId);
  }
  return { results, workerId: r.workerId, waitedMs: r.waitedMs, lockMs, execMs: r.execMs };
} finally {
  release();
}`, note: '워커마다 인덱스를 따로 들고 있으므로, INSERT 가 끝나면 새 (id → 위치) 를 다른 모든 워커에 알립니다 — 반드시 락을 풀기 "전에". finally 로 에러가 나도 락은 꼭 풀립니다.' },
      ],
      explain: { q: '여러 워커가 각자 인덱스를 가지는데, 한 워커가 넣은 행을 다른 워커가 어떻게 찾나요?', a: 'INSERT 를 실행한 워커가 새 id 와 파일 위치를 돌려주면, 메인 스레드가 쓰기 락을 쥔 채로 다른 모든 워커에 인덱스 갱신 메시지를 보냅니다. 워커는 메시지를 받은 순서대로 처리하므로, 락이 풀린 뒤 그 워커에 도착하는 조회는 항상 갱신된 인덱스로 실행됩니다.' },
    },
  ],
};
