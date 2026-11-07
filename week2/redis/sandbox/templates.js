/**
 * 미니 레디스 샌드박스 틀과 조각
 *  쓸 수 있는 것: redis (redis.exec('SET a 1'), redis.command(['GET','a'])), print, sleep, time, HashTable, MiniRedis
 */
export const TEMPLATES = [
  {
    id: 'basic',
    title: '기본 명령',
    desc: 'SET / GET / TTL / INCR 을 써 보고, 만료되는 것을 기다려 봅니다.',
    try: ['PX 300 을 PX 1000 으로 바꾸고 sleep 시간도 바꿔 보기', 'SET 에 NX 를 붙여 두 번 실행해 보기', 'INFO 결과에서 hits / misses 확인'],
    code: `redis.exec('SET user:1 "김정글"');
print(redis.exec('GET user:1'));

redis.exec('SET otp 482913 PX 300');   // 0.3초 뒤 만료
print('남은 시간(ms):', redis.exec('PTTL otp'));
await sleep(350);
print('0.35초 뒤:', redis.exec('GET otp'));   // null

for (let i = 0; i < 5; i++) redis.exec('INCR visits');
print('방문 수:', redis.exec('GET visits'));
print(redis.exec('INFO'));`,
  },
  {
    id: 'cache',
    title: '캐시 직접 만들기',
    desc: '느린 함수(DB 흉내) 앞에 캐시를 두고 몇 배 빨라지는지 잽니다.',
    try: ['slowDb 의 sleep 을 300 으로 늘려 차이 보기', "EX '30' 을 PX '50' 으로 바꾸고 중간에 sleep 넣어 보기", '가격을 바꾼 뒤 DEL 로 무효화하는 코드 추가하기'],
    code: `// 100ms 걸리는 "느린 DB"
async function slowDb(id) {
  await sleep(100);
  return { id, name: '상품 ' + id, price: id * 1000 };
}

// cache-aside: 캐시 → 없으면 DB → 캐시에 저장
async function getProduct(id) {
  const hit = redis.exec(\`GET product:\${id}\`);
  if (hit !== null) return JSON.parse(hit);
  const p = await slowDb(id);
  redis.command(['SET', \`product:\${id}\`, JSON.stringify(p), 'EX', '30']);
  return p;
}

let t = performance.now();
for (let i = 0; i < 10; i++) await slowDb(1);
print('캐시 없이 10번:', Math.round(performance.now() - t), 'ms');

t = performance.now();
for (let i = 0; i < 10; i++) await getProduct(1);
print('캐시 쓰고 10번:', Math.round(performance.now() - t), 'ms');`,
  },
  {
    id: 'limiter',
    title: '요청 횟수 제한 완성하기',
    desc: 'TODO 를 채워서 "10초에 3번까지" 를 만들어 보세요.',
    try: ['TODO 를 채우고 TTL 이 10 으로 나오는지 확인', '한도를 3 → 5 로 바꾸기', 'IP 를 두 개로 나눠 따로 세어지는지 확인'],
    code: `function allow(ip) {
  const count = redis.exec(\`INCR rate:\${ip}\`);
  // TODO: 첫 요청이면 10초 뒤에 사라지게 EXPIRE 를 붙이세요
  // if (count === 1) redis.exec(...);
  return count <= 3;
}

for (let i = 1; i <= 5; i++) print(i + '번째 요청:', allow('1.2.3.4') ? '200 OK' : '429 차단');
print('TTL:', redis.exec('TTL rate:1.2.3.4'), '(-1 이면 EXPIRE 를 안 붙인 것)');`,
  },
  {
    id: 'hashtable',
    title: '해시 테이블 직접 쓰기',
    desc: '좋은 해시와 나쁜 해시로 버킷 체인 길이와 조회 시간을 비교합니다.',
    try: ['나쁜 해시를 (s) => s.charCodeAt(s.length - 1) 로 바꿔 보기', '키를 2000 → 20000 개로', 'resize 횟수(snapshot().stats.resizes) 출력하기'],
    code: `function chains(table) {
  const snap = table.snapshot();
  const lens = (snap.tables[1] ?? snap.tables[0]).buckets.map((b) => b.length);
  return { 버킷: lens.length, 가장긴체인: Math.max(...lens), 빈버킷: lens.filter((n) => n === 0).length };
}

const good = new HashTable();                              // FNV-1a
const bad = new HashTable({ hash: (s) => s.length });      // 길이만 보는 나쁜 해시
for (let i = 0; i < 2000; i++) {
  good.set('user:' + i, i);
  bad.set('user:' + i, i);
}
good.finishRehash(); bad.finishRehash();
print('FNV-1a     ', chains(good));
print('길이 해시  ', chains(bad));
time('FNV-1a 2000번 조회', () => { for (let i = 0; i < 2000; i++) good.get('user:' + i); });
time('길이 해시 2000번 조회', () => { for (let i = 0; i < 2000; i++) bad.get('user:' + i); });`,
  },
  {
    id: 'invalidate',
    title: '태그로 무효화',
    desc: '상품 상세·목록 캐시에 태그를 붙이고 가격이 바뀌면 한꺼번에 지웁니다.',
    try: ['TAG 를 빼먹은 키가 남는 것 확인', 'DELPATTERN product:* 로 바꿔 보기', '태그를 두 개 붙이고 하나만 무효화'],
    code: `redis.exec('SET product:1 "키보드 89000"');
redis.exec('SET product:2 "마우스 32000"');
redis.exec('SET page:products "목록 HTML"');
redis.exec('SET user:7 "김정글"');
redis.exec('TAG product:1 products');
redis.exec('TAG product:2 products');
redis.exec('TAG page:products products');

print('무효화 전:', redis.exec('KEYS *'));
print('지운 키 수:', redis.exec('INVALIDATE products'));
print('무효화 후:', redis.exec('KEYS *'));   // user:7 만 남음`,
  },
  {
    id: 'aof',
    title: 'AOF 로 다시 켜기',
    desc: '쓰기 명령을 기록해 두었다가 새 레디스에서 재생해 복원합니다.',
    try: ['INCR 을 100번 하고 AOF 줄 수와 재작성 후 줄 수 비교', 'EX 1 키를 넣고 sleep(1100) 뒤 재생하면?', '마지막 줄을 잘라서(slice) 재생해 보기'],
    code: `const lines = [];
const a = new MiniRedis({ onWrite: (args) => lines.push(JSON.stringify(args)) });
a.exec('SET user:1 김정글');
a.exec('SET session:x abc EX 60');
for (let i = 0; i < 5; i++) a.exec('INCR visits');
print('AOF', lines.length + '줄:');
lines.forEach((l) => print('  ' + l));

// 서버가 죽었다가 다시 켜졌다고 치고, 새 레디스에서 재생
const b = new MiniRedis();
print('복원:', b.loadAof(lines.join('\\n')));
print('visits =', b.exec('GET visits'), '/ TTL session:x =', b.exec('TTL session:x'));
print('재작성하면:', a.rewriteAof().trim().split('\\n').length + '줄');`,
  },
  {
    id: 'blank',
    title: '빈 틀',
    desc: '처음부터 직접. redis, print(), sleep(), time() 을 쓸 수 있어요.',
    try: ['아래 조각 버튼으로 시작해 보기'],
    code: `// redis, print(), sleep(), time(), HashTable, MiniRedis 를 쓸 수 있어요.
`,
  },
];

export const SNIPPETS = [
  { label: '저장', items: [['SET EX', "redis.exec('SET key value EX 10');"], ['GET', "print(redis.exec('GET key'));"], ['DEL', "print(redis.exec('DEL key'));"], ['SET NX', "print(redis.exec('SET lock:job me NX PX 1000'));  // OK 또는 null"]] },
  { label: '숫자·만료', items: [['INCR', "print(redis.exec('INCR counter'));"], ['TTL', "print(redis.exec('TTL key'));"], ['EXPIRE', "redis.exec('EXPIRE key 5');"]] },
  { label: '무효화', items: [['TAG', "redis.exec('TAG key group');"], ['INVALIDATE', "print(redis.exec('INVALIDATE group'));"], ['KEYS', "print(redis.exec('KEYS *'));"]] },
  { label: '도구', items: [['시간 재기', "time('이름', () => {\n  // 잴 코드\n});"], ['반복', 'for (let i = 0; i < 10; i++) {\n  \n}'], ['기다리기', 'await sleep(500);'], ['해시 테이블', "const t = new HashTable();\nt.set('a', 1);\nprint(t.snapshot());"]] },
];
