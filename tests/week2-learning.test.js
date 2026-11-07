/**
 * 2주차 학습 페이지 (레디스 / DBMS 트랙): 예제 앱, 샌드박스, 코드 해설, 더 파고들기 실험, 이론 예제, 페이지 열기
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { MiniRedis } from '../week2/redis/miniredis.js';
import { Database } from '../week2/dbms/engine.js';
import { MemoryStorage } from '../week2/dbms/storage.js';
import { seedRows } from '../week2/dbms/seed.js';
import * as RX from '../week2/redis/examples/apps.js';
import * as DX from '../week2/dbms/examples/apps.js';
import { TEMPLATES as R_TPL, SNIPPETS as R_SNIP } from '../week2/redis/sandbox/templates.js';
import { TEMPLATES as D_TPL, SNIPPETS as D_SNIP } from '../week2/dbms/sandbox/templates.js';
import { createEnv, runCode } from '../week2/shared/sandbox-runner.js';
import * as RL from '../week2/redis/deepdive/labs.js';
import * as DL from '../week2/dbms/deepdive/labs.js';
import { openBundle } from './week2-pages.test.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clockRedis = () => {
  const clock = { t: 1_000_000 };
  return { clock, redis: new MiniRedis({ now: () => clock.t }) };
};
const POSTS = { posts: { columns: [{ name: 'id', type: 'INT' }, { name: 'title', type: 'TEXT' }, { name: 'author', type: 'TEXT' }] } };
const USERS = { users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] } };
const postsDb = (n) => {
  const db = new Database(new MemoryStorage(structuredClone(POSTS)), { order: 32 });
  if (n) db.insert({ type: 'insert', table: 'posts', columns: null, rows: Array.from({ length: n }, (_, i) => [{ kind: 'string', value: `p${i + 1}` }, { kind: 'string', value: 'a' }]) });
  return db;
};
const usersDb = () => new Database(new MemoryStorage(structuredClone(USERS)), { order: 32 });

// ================================================================ 레디스 예제
describe('미니 레디스 예제', () => {
  afterEach(RX.resetFlags);

  test('세션: 이동할 때마다 TTL 연장(슬라이딩), 가만히 두면 만료, 모든 기기 로그아웃', () => {
    const { clock, redis } = clockRedis();
    const s = new RX.SessionStore(redis, { ttl: 10 });
    const t = s.login({ id: 1, name: 'a' });
    const other = s.login({ id: 2, name: 'b' });
    clock.t += 8000;
    assert.equal(s.touch(t).name, 'a');
    assert.equal(s.ttlOf(t), 10);
    clock.t += 8000;
    assert.ok(s.touch(t));
    assert.equal(s.touch(other), null, '연장 안 한 세션은 만료');
    const t2 = s.login({ id: 1 });
    assert.equal(s.logoutAll(1), 2);
    assert.equal(s.touch(t2), null);
  });

  test('세션 망가뜨리기: TTL 없으면 영원히 남는다', () => {
    const { clock, redis } = clockRedis();
    RX.flags.sessionNoTtl = true;
    const s = new RX.SessionStore(redis, { ttl: 1 });
    const t = s.login({ id: 1 });
    clock.t += 1e9;
    assert.ok(s.touch(t));
    assert.equal(s.ttlOf(t), -1);
  });

  test('요청 제한: 창 안에서 한도까지, 창이 끝나면 다시 / EXPIRE 를 빼먹으면 영원히 막힘', () => {
    const { clock, redis } = clockRedis();
    const rl = new RX.RateLimiter(redis, { limit: 3, windowSec: 10 });
    assert.deepEqual([1, 2, 3, 4].map(() => rl.hit('ip').allowed), [true, true, true, false]);
    clock.t += 10_000;
    assert.equal(rl.hit('ip').allowed, true);
    RX.flags.limiterNoExpire = true;
    const bad = new RX.RateLimiter(redis, { limit: 1, windowSec: 1 });
    bad.hit('x');
    clock.t += 1e9;
    assert.equal(bad.hit('x').ttl, -1);
  });

  test('분산 락 시나리오: 정상 / 죽은 워커는 TTL 뒤 / TTL 없으면 교착 / 안전하지 않은 해제는 남의 락을 지움', async () => {
    const run = async (opts, flag) => {
      RX.resetFlags();
      if (flag) RX.flags[flag] = true;
      return RX.lockRace(new RX.LockService(new MiniRedis()), opts);
    };
    const ok = await run({ workMs: [60, 60], ttlMs: 300 });
    assert.deepEqual(ok.events.map((e) => e.event), ['acquire', 'release', 'acquire', 'release']);
    const crash = await run({ workMs: [60, 60], ttlMs: 150, crash: 0 });
    assert.ok(crash.events.some((e) => e.worker === 1 && e.event === 'release'));
    const dead = await run({ workMs: [60, 60], ttlMs: 150, crash: 0, giveUpMs: 300 }, 'lockNoTtl');
    assert.ok(dead.events.some((e) => e.event === 'give-up'));
    const safe = await run({ workMs: [400, 100, 250], ttlMs: 150 });
    assert.ok(!safe.events.some((e) => e.event === 'release-other'));
    const unsafe = await run({ workMs: [400, 100, 250], ttlMs: 150 }, 'lockUnsafeRelease');
    assert.ok(unsafe.events.some((e) => e.event === 'release-other'));
  });

  test('좋아요: INCR 은 정확히, GET → SET 으로 나누면 잃는다', async () => {
    const r = new MiniRedis();
    const ok = await RX.likeBurst(r, 80);
    assert.equal(ok.added, 80);
    RX.flags.likesNaive = true;
    const naive = await RX.likeBurst(r, 80, { key: 'likes:2' });
    assert.ok(naive.lost > 0, `잃은 수 ${naive.lost}`);
  });

  test('실험 설명이 모든 스위치에 있다', () => {
    assert.deepEqual(RX.EXPERIMENTS.map((e) => e.id).sort(), Object.keys(RX.flags).sort());
    for (const e of RX.EXPERIMENTS) for (const k of ['title', 'before', 'after', 'try', 'watch', 'why']) assert.ok(e[k], `${e.id}.${k}`);
  });
});

// ================================================================ DBMS 예제
describe('미니 DBMS 예제', () => {
  afterEach(DX.resetFlags);

  test("회원 가입: O'Brien 은 이스케이프로 정상 저장, 나이에 글자는 아무것도 저장 안 함", () => {
    const db = usersDb();
    assert.equal(DX.signup(db, { name: "O'Brien", age: '40', email: 'o@x' }).ok, true);
    const bad = DX.signup(db, { name: 'x', age: 'abc', email: 'x@x' });
    assert.equal(bad.ok, false);
    assert.equal(db.tables.users.index.size, 1);
    assert.equal(db.execute('SELECT name FROM users WHERE id = 1')[0].rows[0][0], "O'Brien");
  });

  test('회원 가입 망가뜨리기: 이스케이프 안 하면 따옴표 하나로 오류, 해커 입력으로 행이 몰래 추가 (SQL 인젝션)', () => {
    DX.flags.signupNoEscape = true;
    const db = usersDb();
    assert.equal(DX.signup(db, { name: "O'Brien", age: '1', email: 'o@x' }).ok, false);
    const hack = DX.signup(db, { name: "해커', 1, 'h@x'), ('관리자', 99, 'admin@x') -- ", age: '20', email: 'x@x' });
    assert.equal(hack.ok, true);
    assert.equal(hack.ids.length, 2, '한 번 가입에 두 행');
    assert.equal(db.execute('SELECT name FROM users WHERE id = 2')[0].rows[0][0], '관리자');
  });

  test('게시판: MISS → HIT, 글쓰기 후 무효화 / 무효화를 빼면 새 글이 안 보임', async () => {
    const board = new DX.BoardService(postsDb(10), new MiniRedis(), { latencyMs: 2, pageSize: 5 });
    assert.equal((await board.latest()).hit, false);
    assert.equal((await board.latest()).hit, true);
    const w = await board.write("it's new", '나');
    assert.deepEqual((await board.latest()).rows[0], [w.id, "it's new", '나']);
    DX.flags.boardNoInvalidate = true;
    const w2 = await board.write('안 보이는 글', '나');
    assert.ok(!(await board.latest()).rows.some(([id]) => id === w2.id));
  });

  test('페이지: id 기준은 10개만, 건너뛰기는 앞쪽을 다 읽음 (결과는 같음)', () => {
    const db = postsDb(5000);
    for (const page of [1, 50, 400]) {
      const off = DX.offsetPage(db, page);
      const ks = DX.keysetPage(db, (page - 1) * 10);
      assert.deepEqual(ks.rows, off.rows);
      assert.equal(ks.scanned, 10);
      assert.equal(off.scanned, page * 10);
    }
  });

  test('이메일 인덱스: 1개만 읽고, SET NX 로 중복 가입 거절 / 망가뜨리면 중복 가입', () => {
    const db = usersDb();
    seedRows(db, 'users', 3000);
    const idx = new DX.EmailIndex(db, new MiniRedis());
    assert.equal(idx.rebuild(), 3000);
    assert.equal(idx.find('user2500@jungle.test').scanned, 1);
    assert.equal(idx.scan('user2500@jungle.test').scanned, 2500);
    assert.equal(idx.signUp('x', 'USER7@jungle.test').ok, false);
    DX.flags.emailNoNx = true;
    assert.equal(idx.signUp('y', 'user7@jungle.test').ok, true);
    assert.equal(idx.countEmail('user7@jungle.test'), 2);
  });

  test('실험 설명이 모든 스위치에 있다', () => {
    assert.deepEqual(DX.EXPERIMENTS.map((e) => e.id).sort(), Object.keys(DX.flags).sort());
  });
});

// ================================================================ 샌드박스
describe('샌드박스 (레디스 · DBMS)', () => {
  for (const [track, list] of [['레디스', R_TPL], ['DBMS', D_TPL]]) {
    for (const t of list) {
      test(`${track} 틀 "${t.title}" 이 에러 없이 실행되고 "해볼 것" 이 있다`, async () => {
        const r = await runCode(t.code, createEnv());
        assert.equal(r.error, null, r.error?.message);
        if (t.id !== 'blank') assert.ok(r.logs.length > 0);
        assert.ok(t.try?.length >= 1);
      });
    }
  }

  test('DBMS 틀 "따옴표와 SQL 인젝션" 은 정말로 두 줄이 들어간다', async () => {
    const env = createEnv();
    await runCode(D_TPL.find((t) => t.id === 'escape').code, env);
    assert.equal(env.db.tables.users.index.size, 3, "O'Brien 1 + 해커 입력 2");
  });

  test('print · sql · time · tokenize · parse, 에러 줄 번호, 시간 제한', async () => {
    const env = createEnv();
    const r = await runCode("print('a');\nsql(\"INSERT INTO users (name) VALUES ('n')\");\nprint(tokenize('SELECT 1').length, parse('SELECT * FROM users')[0].type);\ntime('t', () => 1);", env);
    assert.deepEqual(r.logs.map((l) => l.type), ['log', 'table', 'log', 'time']);
    assert.match(r.logs[2].text, /3 select/);
    const bad = await runCode('const a = 1;\nconst b = 2;\nnope();', createEnv());
    assert.equal(bad.error.line, 3);
    const slow = await runCode('while (true) await sleep(10);', createEnv(), { timeoutMs: 100 });
    assert.match(slow.error.message, /끝나지 않았습니다/);
  });

  test('조각은 모두 문법이 맞다 (그룹으로 묶여 있다)', () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const groups of [R_SNIP, D_SNIP]) {
      for (const g of groups) {
        assert.ok(g.label && g.items.length);
        for (const [label, code] of g.items) assert.doesNotThrow(() => new AsyncFunction('redis', 'db', 'sql', 'print', 'sleep', 'time', 'HashTable', 'BPlusTree', 'seedRows', 'tokenize', 'parse', code), label);
      }
    }
  });
});

// ================================================================ 코드 해설
describe('코드 해설 (레디스 · DBMS)', () => {
  for (const [track, n] of [['redis', 7], ['dbms', 9]]) {
    test(`${track}: ${n}개 함수가 1주차와 같은 모양으로 그려지고, 핵심 줄이 실제 코드에 그대로 있다`, () => {
      const dom = new JSDOM('<aside id="wt-toc"></aside><article id="wt-content"></article>', { runScripts: 'outside-only' });
      dom.window.eval(read(`week2/${track}/walkthrough/sections.js`));
      const S = dom.window.WALKTHROUGH.sections;
      dom.window.eval(read('week2/shared/walkthrough-render.js'));
      const d = dom.window.document;
      assert.equal(S.length, n);
      assert.equal(d.querySelectorAll('.wt-sec').length, n);
      assert.equal(d.querySelectorAll('.wt-explain textarea').length, n);
      assert.ok(d.querySelectorAll('.wt-group').length >= 2, '묶음 제목');
      for (const s of S) {
        for (const m of s.must) {
          const [file, line] = Array.isArray(m) ? m : [s.file, m];
          assert.ok(read(file).includes(line), `${s.id}: ${file} 에 "${line}" 이 없음`);
        }
      }
      dom.window.close();
    });
  }
});

// ================================================================ 더 파고들기 실험
describe('미니 레디스 더 파고들기 실험', () => {
  test('해시 분포 · 부하율 · 리해시 · KEYS · 표본 · 스탬피드 · AOF', async () => {
    const keys = RL.makeKeys('anagram', 1000);
    assert.equal(RL.distribution(RL.HASHES.sum.fn, keys).max, 1000);
    assert.ok(RL.distribution(RL.HASHES.fnv1a.fn, keys).max < 60);
    const load = [0.5, 1, 4].map((a) => RL.measureLoad(a, 2048));
    assert.ok(load[0].probes < load[1].probes && load[1].probes < load[2].probes);
    assert.ok(RL.rehashLatency(50_000, 'incremental').maxMoved < 50);
    assert.ok(RL.rehashLatency(50_000, 'stop-the-world').maxMoved > 10_000);
    assert.ok(RL.blockingCost(20_000).couldServe > 100);
    assert.ok(RL.simulateActiveExpire({ sample: 100, cycles: 10 }).left.at(-1) < RL.simulateActiveExpire({ sample: 5, cycles: 10 }).left.at(-1));
    assert.equal((await RL.stampede({ clients: 30, protect: false, dbMs: 20 })).dbQueries, 30);
    assert.equal((await RL.stampede({ clients: 30, protect: true, dbMs: 20 })).dbQueries, 1);
    const aof = RL.aofGrowth(2000, 20);
    assert.ok(aof.compactLines <= 20 && aof.lines > 1900);
  });
});

describe('미니 DBMS 더 파고들기 실험', () => {
  test('차수와 높이 · 채움률 · 교착 · 스레드 수', async () => {
    const h = [4, 16, 64].map((o) => DL.heightFor(o, 20_000));
    assert.ok(h[0].height > h[1].height && h[1].height > h[2].height);
    const a = DL.fillFactor(16, 5000, 'sequential');
    const b = DL.fillFactor(16, 5000, 'random');
    assert.ok(a.fill < 0.6 && b.fill > a.fill);
    assert.equal((await DL.deadlockDemo({ sorted: false, holdMs: 20, timeoutMs: 120 })).deadlocked, true);
    assert.equal((await DL.deadlockDemo({ sorted: true, holdMs: 20 })).deadlocked, false);
    const cpu = [1, 4, 16].map((w) => DL.poolThroughput({ workers: w }).perSec);
    assert.equal(cpu[2], cpu[1]);
  });

  test('인덱스의 비용: B+ 트리 등록이 쓰기를 느리게 하고 노드를 더 쓴다', () => {
    const r = DL.indexCost(20_000);
    assert.ok(r.withMs > r.withoutMs * 0.9, `${r.withMs} vs ${r.withoutMs}`);
    assert.ok(r.nodes > 100);
  });

  test('선택도: 좁은 범위는 인덱스, 넓은 범위는 전체 읽기가 낫다', () => {
    const rows = DL.selectivity(10_000, [0.1, 50]);
    assert.ok(rows[0].indexMs < rows[0].scanMs);
    assert.ok(rows[1].indexMs > rows[1].scanMs);
    assert.equal(rows[1].indexReads, 5000);
  });

  test('계획기: 조건 순서와 상관없이 id 로 좁히고, != 는 전체, 모순은 0건', () => {
    const p = DL.plans();
    assert.equal(p[0].plan, 'index-lookup');
    assert.equal(p[1].plan, 'index-lookup');
    assert.equal(p[2].scanned, 10);
    assert.equal(p[4].plan, 'full-scan');
    assert.equal(p[6].scanned, 0);
  });
});

// ================================================================ 페이지 열기
describe('2주차 학습 페이지 열기 (파일로 열었을 때)', () => {
  const click = (w, el) => el.dispatchEvent(new w.Event('click', { bubbles: true }));

  test('레디스 예제: 망가뜨리기 버튼이 1주차와 같은 실험실 막대로, 버튼이 동작한다', async () => {
    const { w, d, errors, dom } = openBundle('week2/redis/examples');
    try {
      assert.deepEqual(errors, []);
      assert.equal(d.querySelectorAll('.ex.card').length, 4);
      assert.equal(d.querySelectorAll('.lab-btn').length, RX.EXPERIMENTS.length);
      click(w, d.querySelector('#ses-login'));
      assert.match(d.querySelector('#ses-list').textContent, /로그인 · \d+초 남음/);
      click(w, d.querySelector('#rate-burst'));
      assert.match(d.querySelector('#stat-rate').textContent, /429/);
      click(w, d.querySelector('[data-flag="likesNaive"]'));
      assert.ok(d.querySelector('#ex-likes').classList.contains('broken'));
      assert.match(d.querySelector('#lab-count').textContent, /1개/);
      assert.ok(d.querySelector('#lab-likes .lab-panel'), '설명 패널');
      click(w, d.querySelector('#lab-reset-all'));
      assert.equal(d.querySelector('#lab-count').textContent, '모두 정상');
    } finally {
      dom.window.close();
      RX.resetFlags();
    }
  });

  test('DBMS 예제: 가입 · 페이지 · 이메일, 이스케이프 끄면 만들어지는 SQL 이 바뀐다', () => {
    const { w, d, errors, dom } = openBundle('week2/dbms/examples');
    try {
      assert.deepEqual(errors, []);
      click(w, d.querySelector('#su-quote'));
      assert.match(d.querySelector('#signup-sql').textContent, /'O''Brien'/);
      d.querySelector('#signup-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      assert.match(d.querySelector('#stat-signup').textContent, /가입 완료/);
      click(w, d.querySelector('[data-flag="signupNoEscape"]'));
      assert.match(d.querySelector('#signup-sql').textContent, /'O'Brien'/);
      click(w, d.querySelector('#page-go'));
      assert.match(d.querySelector('#page-out').textContent, /10개 읽음/);
      d.querySelector('#email-q').value = 'user123@jungle.test';
      click(w, d.querySelector('#email-find'));
      assert.match(d.querySelector('#stat-email').textContent, /찾음: #123/);
    } finally {
      dom.window.close();
      DX.resetFlags();
    }
  });

  for (const track of ['redis', 'dbms']) {
    test(`${track} 샌드박스: 1주차 샌드박스 구조, 틀을 실행하면 콘솔과 상태가 보인다`, async () => {
      const { w, d, errors, dom } = openBundle(`week2/${track}/sandbox`);
      try {
        assert.deepEqual(errors, []);
        for (const sel of ['.sb-bar', '.sb-edit .card-head', '#snip-list .snip-group', '#gutter', '.sb-tip #tpl-try li', '.sb-insp']) assert.ok(d.querySelector(sel), sel);
        d.querySelector('#code').value = "redis.exec('SET hello world');\nprint('done');";
        click(w, d.querySelector('#run'));
        for (let i = 0; i < 50 && !d.querySelector('#console').textContent.includes('끝'); i++) await sleep(20);
        assert.match(d.querySelector('#console').textContent, /done/);
        assert.match(d.querySelector('#sb-keys').textContent, /hello/);
      } finally {
        dom.window.close();
      }
    });

    test(`${track} 더 파고들기: 8개 주제 · 이해 체크 · 목차가 맞고 실험이 돈다`, () => {
      const { w, d, errors, dom } = openBundle(`week2/${track}/deepdive`);
      try {
        assert.deepEqual(errors, []);
        const ids = [...d.querySelectorAll('section.deep')].map((s) => s.id);
        assert.equal(ids.length, 8);
        assert.deepEqual([...d.querySelectorAll('input.got-it')].map((c) => c.dataset.id), ids);
        assert.deepEqual([...d.querySelectorAll('#toc a')].map((a) => a.getAttribute('href').slice(1)), ids);
        const run = track === 'redis' ? ['#aof-run', '#aof-out', /재작성 후/] : ['#plan-run', '#plan-out', /B\+ 트리 조회/];
        click(w, d.querySelector(run[0]));
        assert.match(d.querySelector(run[1]).textContent, run[2]);
      } finally {
        dom.window.close();
      }
    });

    test(`${track} 이론: 1주차 이론 페이지 구조 + 직접 해보는 예제`, () => {
      const { w, d, errors, dom } = openBundle(`week2/${track}/theory`);
      try {
        assert.deepEqual(errors, []);
        for (const sel of ['#progress', '.guide.card', '#toc #search', '#content .part', 'section.card[data-level] .sec-head .lv', '.one', '.easy', '.mini', '.sum', '#qa details.qa', '#to-top']) assert.ok(d.querySelector(sel), sel);
        assert.equal(d.querySelectorAll('.demo').length, 2);
        // 검색: 맞지 않는 섹션은 숨김
        d.querySelector('#search').value = track === 'redis' ? 'fsync' : 'MVCC';
        d.querySelector('#search').dispatchEvent(new w.Event('input'));
        return sleep(200).then(() => {
          const visible = [...d.querySelectorAll('#content section')].filter((s) => !s.classList.contains('hidden-by-search'));
          assert.ok(visible.length >= 1 && visible.length < d.querySelectorAll('#content section').length);
        });
      } finally {
        setTimeout(() => dom.window.close(), 300);
      }
    });
  }

  test('이론 예제: 해시 버킷 · 토큰과 실행 계획', () => {
    const r = openBundle('week2/redis/theory');
    r.d.querySelector('#hd-key').value = 'user:1';
    click(r.w, r.d.querySelector('#hd-add'));
    assert.match(r.d.querySelector('#hd-msg').textContent, /버킷 #\d/);
    r.dom.window.close();
    const d = openBundle('week2/dbms/theory');
    assert.ok(d.d.querySelectorAll('#pd-tokens .tok').length > 5);
    assert.match(d.d.querySelector('#pl-msg').textContent, /읽은 레코드 1 \/ 1,000/);
    d.dom.window.close();
  });

  test('한 장 요약은 1주차와 같은 모양(칸 10개), 설명서는 번호 목차 + 번호 섹션', () => {
    for (const t of ['redis', 'dbms']) {
      const cs = new JSDOM(read(`week2/${t}/cheatsheet/index.html`)).window.document;
      assert.equal(cs.querySelectorAll('.cs > div').length, 10);
      assert.ok(cs.querySelector('.cs-top .no-print'));
      const docs = new JSDOM(read(`week2/${t}/docs/index.html`)).window.document;
      const toc = [...docs.querySelectorAll('.doc .toc a')];
      const secs = [...docs.querySelectorAll('.doc article section.card')];
      assert.equal(toc.length, secs.length);
      secs.forEach((s, i) => assert.match(s.querySelector('h2').textContent, new RegExp(`^${i + 1}\\. `)));
    }
  });
});
