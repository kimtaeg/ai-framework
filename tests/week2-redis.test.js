/**
 * 2주차 미니 레디스 — 단위 테스트: 해시 테이블, 명령, 만료, 무효화, AOF
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashTable, fnv1a, MIN_SIZE } from '../week2/redis/hashtable.js';
import { MiniRedis, parseCommandLine, globToRegExp, formatReply } from '../week2/redis/miniredis.js';
import { AofFile, openPersistentRedis } from '../week2/redis/persistence.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'miniredis-'));

// ================================================================ 해시 테이블
describe('해시 테이블', () => {
  test('FNV-1a: 같은 입력 → 같은 값, 32bit 부호 없는 정수', () => {
    assert.equal(fnv1a('hello'), fnv1a('hello'));
    assert.notEqual(fnv1a('a'), fnv1a('b'));
    assert.equal(fnv1a(''), 0x811c9dc5);
    for (const s of ['a', '한글', 'x'.repeat(1000)]) assert.ok(fnv1a(s) >= 0 && fnv1a(s) <= 0xffffffff);
  });

  test('저장 / 조회 / 덮어쓰기 / 삭제', () => {
    const t = new HashTable();
    assert.equal(t.set('a', 1), true);
    assert.equal(t.set('a', 2), false, '덮어쓰기는 false');
    assert.equal(t.get('a'), 2);
    assert.equal(t.get('없음'), undefined);
    assert.equal(t.has('a'), true);
    assert.equal(t.delete('a'), true);
    assert.equal(t.delete('a'), false);
    assert.equal(t.size, 0);
    assert.throws(() => t.set(1, 'x'), TypeError);
  });

  test('모든 키가 같은 버킷으로 가도(최악의 충돌) 체이닝으로 정확히 동작', () => {
    const t = new HashTable({ hash: () => 0 });
    for (let i = 0; i < 200; i++) t.set(`k${i}`, i);
    for (let i = 0; i < 200; i++) assert.equal(t.get(`k${i}`), i);
    for (let i = 0; i < 200; i += 2) assert.equal(t.delete(`k${i}`), true);
    assert.equal(t.size, 100);
    assert.equal(t.get('k1'), 1);
    assert.equal(t.get('k2'), undefined);
    assert.ok(t.stats.collisions > 0);
  });

  test('부하율이 1을 넘으면 2배로 커지고, 점진적으로 옮긴다', () => {
    const events = [];
    const t = new HashTable({ onEvent: (e) => events.push(e.type) });
    for (let i = 0; i < MIN_SIZE; i++) t.set(`k${i}`, i);
    assert.equal(t.isRehashing, false);
    t.set('trigger', 1); // 4개 → 5번째에서 확장 시작
    assert.equal(events[0], 'resize-start');
    assert.equal(t.isRehashing, true, '한 번에 다 옮기지 않는다');
    assert.equal(t.tables[1].size, MIN_SIZE * 2);
    // 리해시 중에도 모든 키가 보인다 (두 테이블을 다 본다)
    for (let i = 0; i < MIN_SIZE; i++) assert.equal(t.get(`k${i}`), i);
    t.finishRehash();
    assert.equal(t.isRehashing, false);
    assert.ok(events.includes('resize-end'));
    assert.equal(t.tables[0].size, MIN_SIZE * 2);
    assert.equal(t.size, MIN_SIZE + 1);
  });

  test('리해시 중 새 키는 새 테이블에만 들어간다', () => {
    const t = new HashTable();
    for (let i = 0; i < 5; i++) t.set(`k${i}`, i);
    assert.equal(t.isRehashing, true);
    t.set('new-key', 'v');
    const snap = t.snapshot();
    assert.ok(snap.tables[1].buckets.flat().includes('new-key'));
    assert.ok(!snap.tables[0].buckets.flat().includes('new-key'));
  });

  test('많이 지우면 줄어든다', () => {
    const t = new HashTable();
    for (let i = 0; i < 1000; i++) t.set(`k${i}`, i);
    t.finishRehash();
    const big = t.tables[0].size;
    for (let i = 0; i < 995; i++) t.delete(`k${i}`);
    t.finishRehash();
    assert.ok(t.tables[0].size < big, `${t.tables[0].size} < ${big}`);
    for (let i = 995; i < 1000; i++) assert.equal(t.get(`k${i}`), i);
  });

  test('무작위 연산 5,000번을 Map 과 비교 (퍼즈)', () => {
    const t = new HashTable();
    const ref = new Map();
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 5000; i++) {
      const k = `k${Math.floor(rand() * 300)}`;
      const r = rand();
      if (r < 0.55) { t.set(k, i); ref.set(k, i); }
      else if (r < 0.8) assert.equal(t.delete(k), ref.delete(k));
      else assert.equal(t.get(k), ref.get(k));
      assert.equal(t.size, ref.size);
    }
    assert.deepEqual([...t.entries()].sort(), [...ref.entries()].sort());
  });

  test('randomEntry 는 빈 테이블에서 null, 아니면 실제 원소', () => {
    const t = new HashTable();
    assert.equal(t.randomEntry(), null);
    t.set('only', 1);
    assert.deepEqual(t.randomEntry(), ['only', 1]);
  });
});

// ================================================================ 명령
describe('MiniRedis 명령', () => {
  const make = () => {
    const clock = { t: 1_000_000 };
    const r = new MiniRedis({ now: () => clock.t });
    return { r, clock };
  };

  test('SET / GET / DEL / EXISTS / DBSIZE', () => {
    const { r } = make();
    assert.equal(r.exec('SET name 정글'), 'OK');
    assert.equal(r.exec('GET name'), '정글');
    assert.equal(r.exec('GET none'), null);
    assert.equal(r.exec('EXISTS name none name'), 2);
    assert.equal(r.exec('DEL name none'), 1);
    assert.equal(r.exec('DBSIZE'), 0);
  });

  test('SET 옵션: NX, XX, KEEPTTL, 잘못된 조합', () => {
    const { r } = make();
    assert.equal(r.exec('SET a 1 NX'), 'OK');
    assert.equal(r.exec('SET a 2 NX'), null);
    assert.equal(r.exec('SET b 1 XX'), null);
    assert.equal(r.exec('SET a 3 XX'), 'OK');
    r.exec('EXPIRE a 100');
    r.exec('SET a 4 KEEPTTL');
    assert.equal(r.exec('TTL a'), 100);
    r.exec('SET a 5');
    assert.equal(r.exec('TTL a'), -1, '그냥 SET 하면 TTL 사라짐');
    assert.throws(() => r.exec('SET a 1 NX XX'), /NX 와 XX/);
    assert.throws(() => r.exec('SET a 1 EX 0'), /1 이상/);
    assert.throws(() => r.exec('SET a 1 EX 10 PX 10'), /하나만/);
    assert.throws(() => r.exec('SET a 1 EX abc'), /정수/);
    assert.throws(() => r.exec('SET a 1 WHAT'), /알 수 없습니다/);
  });

  test('빈 문자열, 공백, 한글, 긴 값도 그대로 저장', () => {
    const { r } = make();
    r.command(['SET', '', '']);
    assert.equal(r.command(['GET', '']), '');
    r.command(['SET', 'k e y', ' 앞뒤 공백 ']);
    assert.equal(r.command(['GET', 'k e y']), ' 앞뒤 공백 ');
    const big = '가'.repeat(100_000);
    r.command(['SET', '큰값', big]);
    assert.equal(r.command(['GET', '큰값']), big);
  });

  test('INCR / DECR / INCRBY: 정수가 아니면 에러, 범위 초과 에러, TTL 유지', () => {
    const { r } = make();
    assert.equal(r.exec('INCR c'), 1);
    assert.equal(r.exec('INCRBY c 10'), 11);
    assert.equal(r.exec('DECR c'), 10);
    assert.equal(r.exec('DECRBY c 20'), -10);
    r.exec('EXPIRE c 50');
    r.exec('INCR c');
    assert.equal(r.exec('TTL c'), 50);
    r.exec('SET s hello');
    assert.throws(() => r.exec('INCR s'), /정수가 아니어서/);
    r.exec(`SET big ${Number.MAX_SAFE_INTEGER}`);
    assert.throws(() => r.exec('INCR big'), /범위/);
  });

  test('MSET / MGET', () => {
    const { r } = make();
    r.exec('MSET a 1 b 2');
    assert.deepEqual(r.exec('MGET a b c'), ['1', '2', null]);
    assert.throws(() => r.exec('MSET a 1 b'), /쌍/);
  });

  test('KEYS: glob 패턴', () => {
    const { r } = make();
    r.exec('MSET user:1 a user:2 b user:10 c product:1 d');
    assert.deepEqual(r.exec('KEYS user:*'), ['user:1', 'user:10', 'user:2']);
    assert.deepEqual(r.exec('KEYS user:?'), ['user:1', 'user:2']);
    assert.deepEqual(r.exec('KEYS *:[12]'), ['product:1', 'user:1', 'user:2']);
    assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'), '. 은 글자 그대로');
  });

  test('명령 줄 파싱: 따옴표, 이스케이프, 닫히지 않은 따옴표', () => {
    assert.deepEqual(parseCommandLine(`SET "hello world" 'it''s'`), ['SET', 'hello world', 'its']);
    assert.deepEqual(parseCommandLine('SET k "a\\"b\\nc"'), ['SET', 'k', 'a"b\nc']);
    assert.deepEqual(parseCommandLine('SET k ""'), ['SET', 'k', '']);
    assert.throws(() => parseCommandLine('SET k "abc'), /따옴표/);
  });

  test('에러: 없는 명령, 인자 부족, 빈 명령', () => {
    const { r } = make();
    assert.throws(() => r.exec('FOO'), /알 수 없는 명령/);
    assert.throws(() => r.exec('SET a'), /부족/);
    assert.throws(() => r.command([]), /비어/);
    assert.equal(r.exec('ping'), 'PONG', '명령 이름은 대소문자 무관');
  });

  test('pipeline: 순서대로, 실패한 명령만 에러', () => {
    const { r } = make();
    const out = r.pipeline([['SET', 'a', '1'], ['INCR', 'a'], ['NOPE'], ['GET', 'a']]);
    assert.deepEqual(out[0], { ok: 'OK' });
    assert.deepEqual(out[1], { ok: 2 });
    assert.match(out[2].error, /알 수 없는/);
    assert.deepEqual(out[3], { ok: '2' });
  });

  test('formatReply 는 redis-cli 처럼 보여 준다', () => {
    assert.equal(formatReply(null), '(nil)');
    assert.equal(formatReply(3), '(integer) 3');
    assert.equal(formatReply('OK'), 'OK');
    assert.equal(formatReply([]), '(empty array)');
    assert.equal(formatReply(['a', null]), '1) "a"\n2) (nil)');
  });
});

// ================================================================ 만료
describe('만료 (TTL)', () => {
  const make = () => {
    const clock = { t: 1_000_000 };
    return { r: new MiniRedis({ now: () => clock.t }), clock };
  };

  test('TTL / PTTL: 키 없음 -2, 만료 없음 -1, 남은 시간', () => {
    const { r, clock } = make();
    assert.equal(r.exec('TTL none'), -2);
    r.exec('SET a 1');
    assert.equal(r.exec('TTL a'), -1);
    r.exec('SET b 1 PX 1500');
    assert.equal(r.exec('PTTL b'), 1500);
    assert.equal(r.exec('TTL b'), 2, '초 단위는 올림');
    clock.t += 1000;
    assert.equal(r.exec('PTTL b'), 500);
  });

  test('만료된 값은 절대 돌려주지 않는다 (지연 삭제)', () => {
    const { r, clock } = make();
    r.exec('SET s v EX 10');
    clock.t += 9999;
    assert.equal(r.exec('GET s'), 'v');
    clock.t += 1;
    assert.equal(r.exec('DBSIZE'), 1, '아직 메모리에는 있음');
    assert.equal(r.exec('GET s'), null, '읽는 순간 만료 확인');
    assert.equal(r.exec('DBSIZE'), 0, '그 자리에서 삭제됨');
    assert.equal(r.stats.expiredLazy, 1);
    assert.equal(r.exec('EXISTS s'), 0);
    assert.equal(r.exec('TTL s'), -2);
  });

  test('만료된 키는 KEYS, MGET, INCR, SET NX 에서도 없는 것으로', () => {
    const { r, clock } = make();
    r.exec('SET a 5 EX 1');
    r.exec('SET b 1');
    clock.t += 1000;
    assert.deepEqual(r.exec('KEYS *'), ['b']);
    assert.deepEqual(r.exec('MGET a'), [null]);
    assert.equal(r.exec('SET a new NX'), 'OK');
    r.exec('SET n 10 EX 1');
    clock.t += 1000;
    assert.equal(r.exec('INCR n'), 1, '만료된 값은 0 부터');
  });

  test('주기 삭제: 아무도 안 읽는 만료 키도 지운다, TTL 없는 키는 건드리지 않음', () => {
    const { r, clock } = make();
    for (let i = 0; i < 100; i++) r.exec(`SET tmp${i} v PX 100`);
    for (let i = 0; i < 50; i++) r.exec(`SET keep${i} v`);
    clock.t += 200;
    let total = 0;
    for (let k = 0; k < 20 && r.expires.size; k++) total += r.activeExpireCycle();
    assert.equal(total, 100);
    assert.equal(r.exec('DBSIZE'), 50);
    assert.equal(r.stats.expiredActive, 100);
  });

  test('EXPIRE 과거 시각 = 바로 삭제, PERSIST 로 만료 해제, 없는 키 0', () => {
    const { r, clock } = make();
    r.exec('SET a 1');
    assert.equal(r.exec(`PEXPIREAT a ${clock.t - 1}`), 1);
    assert.equal(r.exec('EXISTS a'), 0);
    r.exec('SET b 1 EX 5');
    assert.equal(r.exec('PERSIST b'), 1);
    assert.equal(r.exec('TTL b'), -1);
    assert.equal(r.exec('PERSIST b'), 0);
    assert.equal(r.exec('EXPIRE none 10'), 0);
  });

  test('start/stop: 실제 타이머로 주기 삭제', async () => {
    const r = new MiniRedis();
    r.exec('SET a 1 PX 20');
    r.start(10);
    await new Promise((ok) => setTimeout(ok, 80));
    r.stop();
    assert.equal(r.data.size, 0);
  });
});

// ================================================================ 무효화
describe('무효화 (태그, 패턴)', () => {
  test('TAG + INVALIDATE: 태그가 붙은 키만 지운다', () => {
    const r = new MiniRedis();
    r.exec('MSET product:1 a product:2 b user:1 c');
    r.exec('TAG product:1 products');
    r.exec('TAG product:2 products sale');
    r.exec('TAG user:1 users');
    assert.equal(r.exec('INVALIDATE products'), 2);
    assert.deepEqual(r.exec('KEYS *'), ['user:1']);
    assert.equal(r.tagIdx.get('products'), undefined, '빈 태그는 정리');
    assert.equal(r.tagIdx.get('sale'), undefined);
    assert.equal(r.exec('INVALIDATE none'), 0);
    assert.equal(r.exec('TAG none x'), 0);
  });

  test('키를 덮어쓰거나 지우면 태그 색인도 정리된다', () => {
    const r = new MiniRedis();
    r.exec('SET a 1');
    r.exec('TAG a t');
    r.exec('SET a 2'); // 새 값 → 태그 없음
    assert.equal(r.exec('INVALIDATE t'), 0);
    assert.equal(r.exec('GET a'), '2');
  });

  test('DELPATTERN: 패턴으로 한꺼번에', () => {
    const r = new MiniRedis();
    r.exec('MSET cache:home 1 cache:list 2 session:1 3');
    assert.equal(r.exec('DELPATTERN cache:*'), 2);
    assert.deepEqual(r.exec('KEYS *'), ['session:1']);
  });
});

// ================================================================ AOF
describe('AOF (서버가 꺼져도 데이터 유지)', () => {
  test('쓰기 명령만, 결과를 다시 만들 수 있는 형태로 기록', () => {
    const log = [];
    const clock = { t: 5000 };
    const r = new MiniRedis({ now: () => clock.t, onWrite: (a) => log.push(a) });
    r.exec('SET a 1 EX 10');
    r.exec('GET a');
    r.exec('INCR a');
    r.exec('DEL a');
    r.exec('SET b x');
    r.exec('EXPIRE b 5');
    assert.deepEqual(log, [
      ['SET', 'a', '1', 'PXAT', '15000'], // 상대 시간 → 절대 시각
      ['SET', 'a', '2', 'PXAT', '15000'], // INCR → 결과 값
      ['DEL', 'a'],
      ['SET', 'b', 'x'],
      ['PEXPIREAT', 'b', '10000'],
    ]);
  });

  test('재생하면 같은 상태 — 꺼져 있던 동안 지난 시간도 반영', () => {
    const clock = { t: 0 };
    const lines = [];
    const a = new MiniRedis({ now: () => clock.t, onWrite: (x) => lines.push(JSON.stringify(x)) });
    a.exec('SET long v EX 100');
    a.exec('SET short v EX 1');
    a.exec('SET plain 정글');
    a.exec('TAG plain t');
    clock.t = 5000; // 5초 뒤에 다시 켬
    const b = new MiniRedis({ now: () => clock.t });
    const r = b.loadAof(lines.join('\n') + '\n');
    assert.equal(r.applied, 4);
    assert.equal(b.exec('GET long'), 'v');
    assert.equal(b.exec('TTL long'), 95);
    assert.equal(b.exec('GET short'), null, '꺼져 있는 동안 만료됨');
    assert.equal(b.exec('GET plain'), '정글');
    assert.equal(b.exec('INVALIDATE t'), 1, '태그도 복원');
  });

  test('마지막 줄이 쓰다 만 상태(서버가 쓰는 도중 죽음)면 그 줄만 버린다', () => {
    const r = new MiniRedis();
    const out = r.loadAof('["SET","a","1"]\n["SET","b","2"]\n["SET","c"');
    assert.equal(out.applied, 2);
    assert.equal(out.truncated, true);
    assert.equal(r.exec('GET b'), '2');
  });

  test('재작성: 지금 상태만 남겨 파일을 줄인다', () => {
    const lines = [];
    const r = new MiniRedis({ onWrite: (x) => lines.push(JSON.stringify(x)) });
    for (let i = 0; i < 1000; i++) r.exec('INCR counter');
    r.exec('SET gone 1');
    r.exec('DEL gone');
    const compact = r.rewriteAof();
    assert.equal(lines.length, 1002);
    assert.equal(compact.trim().split('\n').length, 1);
    const b = new MiniRedis();
    b.loadAof(compact);
    assert.equal(b.exec('GET counter'), '1000');
  });

  test('파일: always 는 갑자기 죽어도 남고, everysec 는 버퍼 분량을 잃을 수 있다', () => {
    const dir = tmp();
    try {
      for (const [policy, survives] of [['always', true], ['everysec', false]]) {
        const path = join(dir, `${policy}.aof`);
        const { redis, aof } = openPersistentRedis(path, { fsync: policy });
        redis.exec('SET a 1');
        aof.crash(); // 버퍼를 버리고 강제 종료
        const again = openPersistentRedis(path, { fsync: policy });
        assert.equal(again.redis.exec('GET a'), survives ? '1' : null, policy);
        again.aof.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('파일: 정상 종료하면 남고, 다시 켤 때 잘린 줄을 정리해 압축한다', () => {
    const dir = tmp();
    const path = join(dir, 'r.aof');
    try {
      let s = openPersistentRedis(path, { fsync: 'no' });
      for (let i = 0; i < 50; i++) s.redis.exec(`SET k${i} ${i}`);
      s.redis.exec('SET 한글키 "값 있음"');
      s.aof.close();
      appendFileSync(path, '["SET","broken"'); // 쓰다 죽은 줄
      s = openPersistentRedis(path, { fsync: 'everysec' });
      assert.equal(s.restored.truncated, true);
      assert.equal(s.redis.exec('GET k49'), '49');
      assert.equal(s.redis.exec('GET 한글키'), '값 있음');
      assert.ok(!readFileSync(path, 'utf8').includes('broken'), '재작성으로 잘린 줄 제거');
      s.redis.exec('SET after restart');
      s.aof.close();
      s = openPersistentRedis(path);
      assert.equal(s.redis.exec('GET after'), 'restart');
      s.aof.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('알 수 없는 fsync 정책은 에러', () => {
    const dir = tmp();
    try {
      assert.throws(() => new AofFile(join(dir, 'x.aof'), { fsync: 'sometimes' }), /정책/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AOF 중간의 깨진 줄은 건너뛰고 errors 로 센다', () => {
    const r = new MiniRedis();
    const out = r.loadAof('["SET","a","1"]\nGARBAGE\n["NOPE"]\n["SET","b","2"]\n');
    assert.equal(out.applied, 2);
    assert.equal(out.errors, 2);
    assert.equal(out.truncated, false);
  });
});
