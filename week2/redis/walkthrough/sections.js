// 미니 레디스 핵심 코드 해설 데이터 (일반 스크립트: 파일을 더블클릭해서 열어도 동작)
// 코드 조각은 실제 코드에서 주석만 줄여 옮긴 것이다.
// must: 실제 파일에 반드시 있어야 하는 줄 — tests/week2-learning.test.js 가 확인한다 (해설과 코드가 어긋나지 않게)
window.WALKTHROUGH = {
  store: 'mini-redis-walkthrough',
  sections: [
    {
      id: 'hash', group: '저장소 · 해시 테이블', file: 'week2/redis/hashtable.js',
      title: 'fnv1a · set — 해시 함수와 저장',
      summary: '키를 정수로 바꾸고(해시), 버킷 번호를 골라 그 버킷의 연결 리스트 맨 앞에 붙입니다. 이미 있는 키면 값만 바꿉니다.',
      must: ['h ^= str.charCodeAt(i);', 'h = Math.imul(h, 0x01000193);', 'const i = this.hash(key) & t.mask;', 't.buckets[i] = { key, value, next: t.buckets[i] };'],
      chunks: [
        { code: `export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // 32bit 곱셈
  }
  return h >>> 0;
}`, note: '글자마다 XOR 로 섞고 큰 소수를 곱해 비트를 퍼뜨립니다. Math.imul 은 32비트 정수 곱셈(넘치는 부분 버림), >>> 0 은 부호 없는 정수로. 비슷한 키도 전혀 다른 값이 나와 버킷에 고르게 퍼집니다.' },
        { code: `set(key, value) {
  this.#rehashStep();
  const found = this.#find(key, false);
  if (found) { found.value = value; return false; }
  this.#maybeGrow();`, note: '연산마다 리해시를 한 걸음 진행합니다. 같은 키가 있으면 값만 바꾸고 끝. 없으면 넣기 전에 "넣으면 부하율이 1 을 넘는가?" 를 확인해 확장을 시작합니다.' },
        { code: `  const t = this.tables[1] ?? this.tables[0];
  const i = this.hash(key) & t.mask;
  if (t.buckets[i]) this.stats.collisions++;
  t.buckets[i] = { key, value, next: t.buckets[i] };
  t.used++;
  return true;
}`, note: '리해시 중이면 새 테이블에 넣습니다(옛 테이블은 비워지는 중). 버킷 수가 2의 거듭제곱이라 hash & (크기-1) 이 나머지 연산과 같습니다. 새 노드를 체인 맨 앞에 붙여 O(1).' },
      ],
      explain: { q: '해시 테이블에 키를 저장하는 과정을 설명해 보세요.', a: '키를 FNV-1a 로 32비트 정수로 바꾸고, 버킷 수-1 과 AND 해서 버킷 번호를 구합니다. 같은 키가 있으면 값만 바꾸고, 없으면 그 버킷의 연결 리스트 맨 앞에 노드를 붙입니다. 넣기 전에 부하율이 1 을 넘을 것 같으면 2배 테이블을 만들어 점진적 리해시를 시작합니다.' },
    },
    {
      id: 'rehash', group: '저장소 · 해시 테이블', file: 'week2/redis/hashtable.js',
      title: '#find · #rehashStep — 두 테이블과 점진적 리해시',
      summary: '확장 중에는 테이블이 두 개입니다. 찾을 때는 둘 다 보고, 연산이 올 때마다 옛 테이블의 버킷 하나를 새 테이블로 옮깁니다.',
      must: ['for (const t of this.tables) {', 'if (n.key === key) return n;', 'from.buckets[this.rehashIdx] = null;', 'this.tables = [to, null];'],
      chunks: [
        { code: `#find(key, step = true) {
  if (step) this.#rehashStep();
  for (const t of this.tables) {
    if (!t || t.used === 0) continue;
    for (let n = t.buckets[this.hash(key) & t.mask]; n; n = n.next)
      if (n.key === key) return n;
  }
  return null;
}`, note: '옛 테이블 → 새 테이블 순서로 봅니다. 아직 안 옮긴 키는 옛 테이블에, 옮긴 키와 새로 넣은 키는 새 테이블에 있으니 둘 다 보면 절대 놓치지 않습니다. 체인은 키가 같을 때까지 따라갑니다.' },
        { code: `#rehashStep(steps = STEP) {
  if (!this.isRehashing) return;
  const [from, to] = this.tables;
  while (steps > 0 && from.used > 0) {
    while (from.buckets[this.rehashIdx] === null) { this.rehashIdx++; if (--emptyLeft <= 0) return; }
    let n = from.buckets[this.rehashIdx];
    while (n) { /* 노드를 새 테이블의 제 위치로 */ }
    from.buckets[this.rehashIdx] = null;
    this.rehashIdx++; steps--;
  }`, note: 'rehashIdx 는 "다음에 옮길 옛 버킷 번호". 한 번에 버킷 1개(빈 버킷은 최대 10개까지 건너뜀)만 옮겨서, 원소가 100만 개여도 연산 하나가 길어지지 않습니다.' },
        { code: `  if (from.used === 0) {
    this.tables = [to, null];
    this.rehashIdx = -1;
  }
}`, note: '다 옮기면 새 테이블이 "지금 테이블" 이 되고 리해시가 끝납니다. Redis 의 dict 도 ht[0], ht[1] 로 똑같이 합니다.' },
      ],
      explain: { q: '왜 리해시를 한 번에 하지 않고 나눠서 하나요? 그동안 조회는 어떻게 되나요?', a: '한 번에 옮기면 원소 수만큼 걸리는 동안 모든 요청이 멈춥니다. 그래서 테이블 두 개를 두고 연산마다 버킷 하나씩 옮깁니다. 조회와 삭제는 두 테이블을 모두 보고, 추가는 새 테이블에만 해서 키를 놓치지 않습니다.' },
    },
    {
      id: 'lookup', group: '명령 · 만료', file: 'week2/redis/miniredis.js',
      title: 'command · #lookup — 명령 실행과 지연 삭제',
      summary: '모든 명령은 command() 한 곳으로 들어오고, 키를 읽는 모든 명령은 #lookup() 을 거칩니다. 만료된 값은 여기서 걸러집니다.',
      must: ["const name = String(args[0]).toUpperCase();", "return this[`cmd_${name}`](a);", 'if (entry.expireAt !== null && entry.expireAt <= this.now()) {', 'this.stats.expiredLazy++;'],
      chunks: [
        { code: `command(args) {
  const name = String(args[0]).toUpperCase();
  const spec = COMMANDS[name];
  if (!spec) throw err(\`알 수 없는 명령 '\${args[0]}'\`);
  const a = args.slice(1).map(String);
  if (a.length < spec.min) throw err(\`'\${name}' 명령의 인자 개수가 부족합니다.\`);
  return this[\`cmd_\${name}\`](a);
}`, note: '명령 이름 → 규칙 표(COMMANDS)에서 최소 인자 수를 확인하고 cmd_SET 같은 메서드를 부릅니다. 동기 함수라서 실행 도중 다른 요청이 끼어들 수 없습니다 → 명령 하나는 원자적.' },
        { code: `#lookup(key) {
  const entry = this.data.get(key);
  if (!entry) return null;
  if (entry.expireAt !== null && entry.expireAt <= this.now()) {
    this.#remove(key, entry);
    this.stats.expiredLazy++;
    this.#log(['DEL', key]);
    return null;
  }
  return entry;
}`, note: '읽는 순간 만료 시각을 확인해서 지났으면 그 자리에서 지우고 "없음". 그래서 GET, EXISTS, INCR, SET NX 모두 만료된 값을 절대 보지 않습니다. 지운 것은 AOF 에도 DEL 로 남깁니다. now 는 바꿔 끼울 수 있어 테스트에서 가짜 시계를 씁니다.' },
      ],
      explain: { q: '만료된 키를 GET 하면 무슨 일이 일어나나요?', a: 'GET 은 #lookup 을 거치는데, 저장된 expireAt 이 현재 시각 이하면 그 자리에서 해시 테이블·만료 테이블·태그 색인에서 지우고 AOF 에 DEL 을 기록한 뒤 null 을 돌려줍니다. 그래서 만료된 값은 절대 응답으로 나가지 않습니다.' },
    },
    {
      id: 'active', group: '명령 · 만료', file: 'week2/redis/miniredis.js',
      title: 'activeExpireCycle — 주기 삭제',
      summary: '아무도 안 읽는 만료 키를 치우는 청소부. 전부 훑지 않고 표본을 뽑습니다.',
      must: ['const n = Math.min(this.sample, this.expires.size);', 'const pick = this.expires.randomEntry(this.random);', 'if (expired / n <= 0.25) break;'],
      chunks: [
        { code: `for (let round = 0; round < 16; round++) {
  const n = Math.min(this.sample, this.expires.size);
  if (n === 0) break;
  let expired = 0;
  for (let i = 0; i < n; i++) {
    const pick = this.expires.randomEntry(this.random);
    const [key, at] = pick;
    if (at <= now) { this.#remove(key); expired++; }
  }
  if (expired / n <= 0.25) break;
}`, note: 'TTL 이 있는 키만 모아 둔 expires 테이블에서 20개를 무작위로 뽑아 만료된 것을 지웁니다. 25% 넘게 만료돼 있었다면 아직 많이 남았다는 뜻이니 한 번 더(최대 16번). 전체를 훑지 않으니 키가 아무리 많아도 짧게 끝납니다.' },
      ],
      explain: { q: '지연 삭제만 있으면 안 되나요? 주기 삭제는 왜 표본을 뽑나요?', a: '지연 삭제만 있으면 아무도 안 읽는 만료 키가 메모리에 영원히 남습니다. 주기 삭제로 이를 치우는데, 전부 훑으면 키가 많을 때 그 순간 서버가 멈추므로 TTL 키 20개만 무작위로 뽑고, 만료 비율이 25% 를 넘을 때만 반복해서 비용을 짧게 유지합니다.' },
    },
    {
      id: 'set', group: '명령 · 만료', file: 'week2/redis/miniredis.js',
      title: 'cmd_SET · #stateRecord — 옵션과 AOF 기록',
      summary: 'SET 의 EX/PX/NX/XX/KEEPTTL 을 해석하고, 성공하면 "결과를 다시 만들 수 있는 명령" 을 AOF 로 보냅니다.',
      must: ["expireAt = opt === 'EX' ? this.now() + n * 1000", 'if ((nx && prev) || (xx && !prev)) return null;', "if (entry.expireAt !== null) rec.push('PXAT', String(entry.expireAt));"],
      chunks: [
        { code: `expireAt = opt === 'EX' ? this.now() + n * 1000
         : opt === 'PX' ? this.now() + n
         : opt === 'EXAT' ? n * 1000 : n;`, note: '"10초 뒤" 같은 상대 시간을 바로 "언제"(절대 시각, ms)로 바꿔 저장합니다. 만료 검사가 단순한 비교 한 번이 됩니다.' },
        { code: `const prev = this.#lookup(key);
if ((nx && prev) || (xx && !prev)) return null;
if (keep && prev) expireAt = prev.expireAt;
const entry = this.#write(key, value, expireAt, prev && keep ? prev.tags : []);
this.#log(this.#stateRecord(key, entry));
return 'OK';`, note: 'NX(없을 때만)·XX(있을 때만) 조건이 안 맞으면 null. 락(SET NX)과 "가입 이메일 중복 방지"가 이 한 줄에 기대고 있습니다. 성공하면 AOF 에 기록.' },
        { code: `#stateRecord(key, entry) {
  const rec = ['SET', key, entry.value];
  if (entry.expireAt !== null) rec.push('PXAT', String(entry.expireAt));
  return rec;
}`, note: 'AOF 에는 받은 명령 그대로가 아니라 "지금 상태를 만드는 명령" 을 씁니다. TTL 은 PXAT(절대 시각)이라 서버가 꺼져 있던 시간도 반영되고, INCR 도 결과 값을 SET 으로 적어 다시 실행해도 같은 결과(멱등)입니다.' },
      ],
      explain: { q: 'AOF 에 TTL 을 "EX 10" 대신 "PXAT 시각" 으로 적는 이유는?', a: 'EX 10 을 그대로 적으면 서버를 다시 켜서 재생할 때 그 시점부터 10초가 다시 시작돼 꺼져 있던 시간만큼 오래 살아남습니다. 절대 시각으로 적으면 재생해도 원래 만료 시각이 유지되고, 이미 지났으면 바로 만료됩니다.' },
    },
    {
      id: 'aof', group: '영속성 · API', file: 'week2/redis/persistence.js',
      title: 'AofFile · loadAof — 디스크 기록과 복원 (loadAof 는 miniredis.js)',
      summary: 'fsync 정책대로 파일 끝에 한 줄씩 쓰고, 재시작하면 처음부터 다시 실행합니다. 쓰다 만 마지막 줄은 버립니다.',
      // [파일, 줄] 형태는 그 파일에서 확인 (loadAof 는 miniredis.js 에 있음)
      must: ["if (this.policy === 'always') {", 'fsyncSync(this.fd);', 'renameSync(tmp, this.path);', ['week2/redis/miniredis.js', 'if (i >= lines.length - 2) truncated = true;']],
      chunks: [
        { code: `append(args) {
  const line = JSON.stringify(args) + '\\n';
  if (this.policy === 'always') {
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    return;
  }
  this.buffer += line;   // everysec: 1초마다 flush
}`, note: 'always 는 명령마다 write + fsync(운영체제 캐시가 아니라 디스크에 확정)라 가장 안전하고 가장 느립니다. everysec 는 메모리 버퍼에 모았다가 1초마다 → 죽으면 최대 1초 분량 손실.' },
        { code: `rewrite(content) {
  this.flush();
  const tmp = \`\${this.path}.tmp\`;
  writeFileSync(tmp, content);
  /* tmp 를 fsync */
  closeSync(this.fd);
  renameSync(tmp, this.path);
  this.fd = openSync(this.path, 'a');
}`, note: '재작성은 임시 파일에 다 쓰고 fsync 한 뒤 rename 으로 바꿔치기합니다. rename 은 원자적이라 쓰는 도중 죽어도 원래 파일이 멀쩡합니다.' },
        { code: `lines.forEach((line, i) => {
  let args;
  try { args = JSON.parse(line); }
  catch { if (i >= lines.length - 2) truncated = true; else errors++; return; }
  this.command(args);
});`, note: '복원은 줄마다 JSON 을 풀어 그대로 command() 로 실행합니다. replaying 동안에는 다시 AOF 에 쓰지 않습니다. 마지막 줄이 깨졌으면 "쓰다 죽은 줄" 로 보고 버립니다.' },
      ],
      explain: { q: '서버가 갑자기 죽었다가 다시 켜지면 데이터는 어떻게 돌아오나요?', a: 'AOF 파일을 처음부터 읽어 한 줄씩 command() 로 다시 실행해 메모리 상태를 재구성합니다. 마지막 줄이 쓰다 만 상태면 버리고, 복원 후 현재 상태만 담은 파일로 원자적으로 재작성합니다. 잃는 양은 fsync 정책에 따라 0(always)~약 1초(everysec)입니다.' },
    },
    {
      id: 'api', group: '영속성 · API', file: 'week2/redis/api.js',
      title: 'createRedisApi — 외부에서 쓰는 HTTP API',
      summary: '주소와 메서드로 명령을 고르고, 입력을 검사하고, 결과를 상태 코드로 구분해 JSON 으로 돌려줍니다.',
      must: ["if (value === null) return send(res, 404, { error: 'NOT_FOUND'", "if (typeof body.value !== 'string') throw new HttpError(400, 'BAD_VALUE'", "if (r === null) return send(res, 409, { error: 'CONDITION'"],
      chunks: [
        { code: `if (!sub && req.method === 'GET') {
  const value = run(['GET', key]);
  if (value === null) return send(res, 404, { error: 'NOT_FOUND', message: '키가 없거나 만료되었습니다.', key });
  return send(res, 200, { key, value, ttl: run(['TTL', key]) });
}`, note: 'GET /keys/:key → 내부적으로는 그냥 GET 명령. 없거나 만료면 404. 클라이언트 라이브러리는 404 를 null 로 바꿔 줍니다.' },
        { code: `const body = await readJson(req);
if (typeof body.value !== 'string') throw new HttpError(400, 'BAD_VALUE', ...);
const args = ['SET', key, body.value];
if (ttl) args.push('EX', String(ttl));
if (body.nx) args.push('NX');
const r = run(args);
if (r === null) return send(res, 409, { error: 'CONDITION', ... });`, note: 'PUT 은 본문을 검사(1MB 제한, JSON 객체, 문자열 값, 양의 정수 ttl)한 뒤 SET 명령으로 바꿉니다. NX/XX 실패는 409. 잘못된 입력이 저장소에 닿기 전에 막는 것이 API 층의 일입니다.' },
      ],
      explain: { q: '외부에서 쉽게 쓰도록 API 를 어떻게 설계했나요?', a: '자원 중심 주소(/keys/:key)에 GET·PUT·DELETE 를 붙여 메서드만 봐도 의미가 보이게 했고, 결과는 200/201/404/409/400/413 상태 코드와 { error, message } 형식으로 통일했습니다. 고급 사용을 위해 명령 그대로(/command)와 원자적 묶음(/pipeline)도 열어 두고, HTTP 세부를 숨긴 client.js 도 제공합니다.' },
    },
  ],
};
