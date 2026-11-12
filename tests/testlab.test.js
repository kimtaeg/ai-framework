/**
 * 테스트 실험실: 비밀번호 잠금, 세션, 막힌 경로, 작업 실행
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createWeek2 } from '../server.js';
import { createTestLab, hashPassword, verifyPassword, writeEnvValue } from '../server/testlab.js';
import { readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = 'test-password-123';

async function start(labOpts, week2Opts) {
  const dir = mkdtempSync(join(tmpdir(), 'testlab-test-'));
  const app = createApp({ week2: createWeek2(dir, week2Opts), testlab: createTestLab({ resultsFile: join(dir, 'results.json'), ...labOpts }) });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.address().port}`;
  const close = async () => {
    app.testlab.stopJob();
    app.closeAllConnections?.();
    await new Promise((ok) => app.close(ok));
    await app.week2.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, base, close };
}
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
const login = async (base, password = PW) => {
  const r = await post(base, '/api/testlab/login', { password });
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

describe('비밀번호 해시', () => {
  test('맞는 비밀번호만 통과하고, 저장 형식에 비밀번호가 들어 있지 않다', () => {
    const h = hashPassword('abc12345');
    assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!h.includes('abc12345'));
    assert.equal(verifyPassword('abc12345', h), true);
    assert.equal(verifyPassword('abc12346', h), false);
    assert.equal(verifyPassword('abc12345', 'plain-text'), false);
    assert.notEqual(hashPassword('abc12345'), h, '소금이 매번 다름');
  });

  test('.env 에 값을 넣고 바꿀 때 다른 줄은 그대로 둔다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testlab-env-'));
    const f = join(dir, '.env');
    try {
      writeEnvValue(f, 'TESTLAB_PASSWORD_HASH', 'a');
      writeEnvValue(f, 'OTHER', 'x');
      writeEnvValue(f, 'TESTLAB_PASSWORD_HASH', 'b');
      assert.equal(readFileSync(f, 'utf8'), 'TESTLAB_PASSWORD_HASH=b\nOTHER=x\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('비밀번호가 설정되지 않았으면 잠긴 채로 열리지 않는다', () => {
  let s;
  before(async () => { s = await start({ passwordHash: '' }); });
  after(() => s.close());
  test('페이지 503, 로그인 503', async () => {
    assert.equal((await fetch(s.base + '/testlab/index.html', { redirect: 'manual' })).status, 503);
    assert.equal((await fetch(s.base + '/bench/index.html', { redirect: 'manual' })).status, 503);
    assert.equal((await post(s.base, '/api/testlab/login', { password: '' })).status, 503);
  });
});

describe('잠금과 로그인', () => {
  let s;
  before(async () => {
    s = await start({
      passwordHash: hashPassword(PW),
      jobs: {
        echo: { title: '에코', desc: 'x', run: ({ run }) => run(process.execPath, ['-e', "console.log('안녕'); console.error('에러 줄')"]) },
        slow: { title: '느림', desc: 'x', run: ({ run }) => run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']) },
        pick: { title: '옵션', desc: 'x', options: { a: 'A', b: 'B' }, run: ({ run, option }) => run(process.execPath, ['-e', `console.log('opt=${option}')`]) },
      },
    });
  });
  after(() => s.close());

  test('로그인 전: 실험실·벤치마크 페이지는 로그인으로, 파일은 401, 로그인 페이지와 다른 페이지는 열림', async () => {
    for (const p of ['/testlab/', '/testlab/index.html', '/bench/index.html', '/load/limit-report.html']) {
      const r = await fetch(s.base + p, { redirect: 'manual' });
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), `/testlab/login.html?next=${encodeURIComponent(p)}`);
    }
    for (const p of ['/testlab/main.js', '/bench/results.json', '/load/k6-mixed.js', '/%62ench/results.json', '/BENCH/results.json']) assert.equal((await fetch(s.base + p)).status, 401, p);
    for (const p of ['/%62ench/index.html', '/BENCH/index.html']) assert.equal((await fetch(s.base + p, { redirect: 'manual' })).status, 302, p);
    assert.equal((await fetch(s.base + '/testlab/login.html')).status, 200);
    assert.equal((await fetch(s.base + '/index.html')).status, 200, '다른 페이지는 그대로');
    assert.equal((await fetch(s.base + '/api/testlab/state')).status, 401);
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'echo' })).status, 401);
  });

  test('틀린 비밀번호는 401, 맞으면 HttpOnly · SameSite=Strict 쿠키', async () => {
    const bad = await post(s.base, '/api/testlab/login', { password: 'nope' });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).left, 4);
    const { r, cookie } = await login(s.base);
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    assert.equal((await fetch(s.base + '/testlab/index.html', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(s.base + '/bench/results.json', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(s.base + '/testlab/index.html', { headers: { cookie: 'testlab=forged' }, redirect: 'manual' })).status, 302, '가짜 쿠키');
  });

  test('다른 사이트(Origin)에서 온 POST 는 거절', async () => {
    const r = await post(s.base, '/api/testlab/login', { password: PW }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  test('작업: 정해진 것만, 출력이 쌓이고, 끝나면 기록에 남는다 · 옵션도 정해진 것만', async () => {
    const { cookie } = await login(s.base);
    const H = { cookie };
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'rm -rf /' }, H)).status, 400);
    assert.equal((await post(s.base, '/api/testlab/run', { job: '__proto__' }, H)).status, 400);
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'pick', option: '; calc' }, H)).status, 400);
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'echo' }, H)).status, 200);
    let st;
    for (let i = 0; i < 100; i++) {
      st = await (await fetch(s.base + '/api/testlab/state', { headers: H })).json();
      if (st.current.status !== 'running') break;
      await sleep(50);
    }
    assert.equal(st.current.status, 'passed');
    assert.ok(st.current.lines.includes('안녕'));
    assert.ok(st.current.lines.includes('에러 줄'));
    assert.equal(st.history[0].job, 'echo');
    const part = await (await fetch(s.base + `/api/testlab/state?from=${st.current.total - 1}`, { headers: H })).json();
    assert.equal(part.current.lines.length, 1, 'from 부터만');
    assert.ok(st.jobs.pick.options);
  });

  test('한 번에 하나: 도는 중에 또 실행하면 409, 멈추기로 끝낸다', async () => {
    const { cookie } = await login(s.base);
    const H = { cookie };
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'slow' }, H)).status, 200);
    assert.equal((await post(s.base, '/api/testlab/run', { job: 'echo' }, H)).status, 409);
    assert.equal((await (await post(s.base, '/api/testlab/stop', {}, H)).json()).stopped, true);
    let st;
    for (let i = 0; i < 100; i++) {
      st = await (await fetch(s.base + '/api/testlab/state', { headers: H })).json();
      if (st.current.status !== 'running') break;
      await sleep(50);
    }
    assert.equal(st.current.status, 'stopped');
  });

  test('실험실 페이지끼리 서로 이어져 있고, 링크가 모두 열린다 · 홈에서 실험실로 들어갈 수 있다', async () => {
    const { cookie } = await login(s.base);
    const pages = ['/testlab/', '/bench/index.html'];
    const hrefsOf = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith('/') && !h.startsWith('//'));
    const seen = new Set();
    for (const p of pages) {
      const html = await (await fetch(s.base + p, { headers: { cookie } })).text();
      const links = hrefsOf(html);
      for (const want of ['/index.html', '/testlab/', '/bench/index.html', '/testlab/#reports']) assert.ok(links.includes(want), `${p} → ${want}`);
      for (const h of links) {
        const path = h.split('#')[0];
        if (seen.has(path)) continue;
        seen.add(path);
        assert.equal((await fetch(s.base + path, { headers: { cookie } })).status, 200, `${p} 의 링크 ${h}`);
      }
    }
    const lab = await (await fetch(s.base + '/testlab/', { headers: { cookie } })).text();
    for (const id of ['reports', 'log']) assert.match(lab, new RegExp(`id="${id}"`), `#${id} 자리`);
    const loginPage = await (await fetch(s.base + '/testlab/login.html')).text();
    assert.ok(hrefsOf(loginPage).includes('/index.html'), '로그인 페이지 → 사이트 홈');
    const home = await (await fetch(s.base + '/index.html')).text();
    assert.match(home, /class="lab-btn" href="testlab\/"/, '홈 왼쪽 메뉴 → 실험실');
  });

  test('로그아웃하면 그 쿠키는 더 못 쓴다', async () => {
    const { cookie } = await login(s.base);
    assert.equal((await post(s.base, '/api/testlab/logout', {}, { cookie })).status, 200);
    assert.equal((await fetch(s.base + '/api/testlab/state', { headers: { cookie } })).status, 401);
  });
});

describe('결과 저장 · 기술 있음 vs 없음 · 지난번과 비교', () => {
  let s, dir;
  const until = async (base, H) => {
    let st;
    for (let i = 0; i < 100; i++) {
      st = await (await fetch(base + '/api/testlab/state', { headers: H })).json();
      if (st.current?.status !== 'running') return st;
      await sleep(30);
    }
    return st;
  };
  let n = 0;
  const jobs = {
    cmp: { title: '비교', desc: 'x', compare: true, run: async ({ record }) => { n++; record({ a: { label: '있음', metrics: { rps: 100 * n, p95: 10 } }, b: { label: '없음', metrics: { rps: 20, p95: 50 } } }); return 0; } },
    single: { title: '하나', desc: 'x', run: async ({ record }) => { record({ metrics: { sec: 3 } }); return 0; } },
    broken: { title: '실패', desc: 'x', run: async ({ record }) => { record({ metrics: { sec: 1 } }); return 1; } },
    alt: { title: '대안', desc: 'x', alt: true, run: async ({ record }) => { record({ main: 'rangeMs', variants: [{ label: '우리', metrics: { rangeMs: 1 } }, { label: '다른 것', metrics: { rangeMs: 5 } }] }); return 0; } },
  };
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'testlab-results-'));
    s = await start({ passwordHash: hashPassword(PW), jobs, resultsFile: join(dir, 'history.json') });
  });
  after(async () => { await s.close(); rmSync(dir, { recursive: true, force: true }); });

  test('비교 작업을 두 번 돌리면 이번 · 지난번 결과가 둘 다 보이고, 실패한 실행은 남지 않는다', async () => {
    const { cookie } = await login(s.base);
    const H = { cookie };
    for (const job of ['cmp', 'cmp', 'single', 'broken', 'alt']) {
      assert.equal((await post(s.base, '/api/testlab/run', { job }, H)).status, 200);
      await until(s.base, H);
    }
    const st = await until(s.base, H);
    const cmp = st.results.find((g) => g.job === 'cmp');
    assert.equal(cmp.runs.length, 2);
    assert.equal(cmp.runs[0].a.metrics.rps, 200, '이번');
    assert.equal(cmp.runs[1].a.metrics.rps, 100, '지난번');
    assert.equal(cmp.runs[0].b.label, '없음');
    assert.equal(cmp.runs[0].compare, true);
    assert.ok(st.results.find((g) => g.job === 'single'));
    assert.ok(!st.results.find((g) => g.job === 'broken'), '실패는 비교 기준이 되지 않음');
    assert.equal(st.metrics.rps.better, 'high');
    assert.equal(st.jobs.cmp.compare, true);
    const alt = st.results.find((g) => g.job === 'alt');
    assert.equal(alt.runs[0].alt, true, '대안 비교 표시');
    assert.equal(alt.runs[0].variants.length, 2);
    assert.equal(alt.runs[0].main, 'rangeMs');
    assert.equal(st.jobs.alt.alt, true);
    assert.equal(st.metrics.rangeMs.better, 'low');
  });

  test('결과는 파일에 남아서, 서버를 다시 켜도 지난번과 비교할 수 있다', () => {
    const saved = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
    assert.equal(saved.filter((r) => r.job === 'cmp').length, 2);
    const lab2 = createTestLab({ passwordHash: hashPassword(PW), jobs, resultsFile: join(dir, 'history.json') });
    assert.ok(lab2, '다시 열기');
  });
});

describe('서버 두 개가 같은 결과 파일을 써도 서로 지우지 않는다', () => {
  test('A 가 저장하고 B 가 저장해도 둘 다 남고, 각자 화면에 둘 다 보인다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testlab-shared-'));
    const file = join(dir, 'history.json');
    const mk = (label) => ({ [label]: { title: label, desc: 'x', run: async ({ record }) => { record({ metrics: { sec: 1 } }); return 0; } } });
    // 두 서버 모두 파일이 비어 있을 때 켜짐 (예전 코드는 여기서 읽은 빈 목록으로 덮어씀)
    const a = await start({ passwordHash: hashPassword(PW), jobs: mk('fromA'), resultsFile: file });
    const b = await start({ passwordHash: hashPassword(PW), jobs: mk('fromB'), resultsFile: file });
    try {
      for (const [s, job] of [[a, 'fromA'], [b, 'fromB']]) {
        const { cookie } = await login(s.base);
        await post(s.base, '/api/testlab/run', { job }, { cookie });
        for (let i = 0; i < 100; i++) {
          const st = await (await fetch(s.base + '/api/testlab/state', { headers: { cookie } })).json();
          if (st.current?.status !== 'running') break;
          await sleep(30);
        }
      }
      const saved = JSON.parse(readFileSync(file, 'utf8')).map((r) => r.job).sort();
      assert.deepEqual(saved, ['fromA', 'fromB']);
      const { cookie } = await login(a.base);
      const st = await (await fetch(a.base + '/api/testlab/state', { headers: { cookie } })).json();
      assert.deepEqual(st.results.map((g) => g.job).sort(), ['fromA', 'fromB'], 'A 의 화면에도 B 의 결과');
    } finally {
      await a.close(); await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('비교 실험용 서버 설정', () => {
  let s;
  before(async () => { s = await start({ passwordHash: '' }, { dbWorkers: 1, fsync: 'always' }); });
  after(() => s.close());
  test('스레드 풀 워커 수를 바꿔서 띄울 수 있다', async () => {
    const st = await (await fetch(s.base + '/api/sql/status')).json();
    assert.equal(st.pool.size, 1);
  });
});

describe('비밀번호를 5번 틀리면 막힌다', () => {
  let s;
  before(async () => { s = await start({ passwordHash: hashPassword(PW) }); });
  after(() => s.close());
  test('5번 틀린 뒤에는 맞는 비밀번호도 429', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post(s.base, '/api/testlab/login', { password: `x${i}` })).status, 401);
    const r = await post(s.base, '/api/testlab/login', { password: PW });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /분 동안/);
  });
});
