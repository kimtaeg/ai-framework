/**
 * 위험 구간 집중 검증 — "문제가 생길 만한 곳" 만 골라 일부러 나쁜 상황을 만든다.
 *   node --test experiment/risk.test.js
 *  (npm test 의 tests/**  와 분리: 실패가 곧 "발견한 문제" 라서 기본 테스트를 깨지 않게)
 *
 *  R1~R3  RESP 클라이언트: Redis 가 연결을 끊거나 죽을 때 요청이 영원히 멈추지 않는가 · 다시 뜨면 재연결하는가
 *  R4~R7  app.js: 측정 중 초기화 · 동시 초기화 · 이상한 입력 · Redis 가 중간에 꺼질 때
 *  R8     app.js: ROWS 를 바꿔 다시 켤 때 정확히 그 건수로 맞추는가
 *  R9     analyze.js: 일부 실험만 있거나 env.json 이 없을 때
 *  R10    check.js: 쓰다 만(잘린) 결과 파일이 섞였을 때
 *  R11    compare-hosts.js: 같은 컴퓨터끼리 비교 · 결과가 크게 다를 때 결론이 데이터를 따르는가
 *  R12    export.js: 결과가 없을 때
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RespClient } from './resp.js';
import { startRedisServer } from '../week2/redis/server.js';

const EXP = dirname(fileURLToPath(import.meta.url));
const ROOT = join(EXP, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
/** promise 가 ms 안에 끝나지 않으면 'TIMEOUT' */
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(ms).then(() => 'TIMEOUT')]);
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/** 가짜 Redis (GET/SET/DEL/FLUSHALL/INFO). mode: 'normal' | 'silent'(받기만) */
function fakeRedis(listenPort = 0) {
  const store = new Map();
  const socks = new Set();
  let mode = 'normal';
  const srv = createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => socks.delete(sock));
    let buf = '';
    sock.on('data', (d) => {
      if (mode === 'silent') return;
      buf += d.toString('utf8');
      for (;;) {
        const m = buf.match(/^\*(\d+)\r\n/);
        if (!m) break;
        let p = m[0].length;
        const args = [];
        let ok = true;
        for (let i = 0; i < +m[1]; i++) {
          const l = buf.slice(p).match(/^\$(\d+)\r\n/);
          if (!l) { ok = false; break; }
          p += l[0].length;
          const bytes = Buffer.from(buf.slice(p), 'utf8');
          if (bytes.length < +l[1] + 2) { ok = false; break; }
          const v = bytes.subarray(0, +l[1]).toString('utf8');
          args.push(v);
          p += v.length + 2;
        }
        if (!ok) break;
        buf = buf.slice(p);
        const [c, k, v] = args;
        const C = c.toUpperCase();
        if (C === 'GET') sock.write(store.has(k) ? `$${Buffer.byteLength(store.get(k))}\r\n${store.get(k)}\r\n` : '$-1\r\n');
        else if (C === 'SET') { store.set(k, v); sock.write('+OK\r\n'); }
        else if (C === 'DEL') sock.write(`:${store.delete(k) ? 1 : 0}\r\n`);
        else if (C === 'FLUSHALL') { store.clear(); sock.write('+OK\r\n'); }
        else if (C === 'INFO') sock.write('$22\r\nredis_version:fake-0\r\n\r\n');
        else sock.write('-ERR\r\n');
      }
    });
  });
  return new Promise((r) => srv.listen(listenPort, '127.0.0.1', () => r({
    port: srv.address().port, store,
    setMode: (m) => { mode = m; },
    endAll: () => { for (const s of socks) s.end(); },       // 정상 종료 (FIN) — Redis 재시작 · 종료 때
    destroyAll: () => { for (const s of socks) s.destroy(); }, // 강제 끊김 (RST)
    close: () => { for (const s of socks) s.destroy(); srv.close(); },
  })));
}

async function startApp({ rows, dir, redisPort, miniPort }) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(EXP, 'app.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ROWS: String(rows), DB_WORKERS: '2', MINI_URL: `http://127.0.0.1:${miniPort}`, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redisPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 150; k++) {
    if (child.exitCode !== null) throw new Error(`app.js 종료됨: ${log}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 아직 */ }
    await sleep(100);
  }
  const stop = async () => { if (child.exitCode === null) { const e = new Promise((r) => child.once('exit', r)); child.kill(); await e; } };
  return { base, child, stop, log: () => log };
}
const alive = async (base) => { try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };

// ---------------------------------------------------------------- R1~R3 RESP
describe('R1~R3. RESP 클라이언트: Redis 연결이 끊길 때', () => {
  test('R1. Redis 가 응답 전에 연결을 정상 종료(FIN)하면, 기다리던 요청이 2초 안에 실패해야 한다 (영원히 멈추면 안 됨)', async () => {
    const r = await fakeRedis();
    r.setMode('silent');
    const c = new RespClient({ port: r.port });
    const pending = c.command('GET', 'a');
    await sleep(100);
    r.endAll();
    const res = await within(pending, 2000);
    r.close(); c.close();
    assert.notEqual(res, 'TIMEOUT', '연결이 끊겼는데 요청이 끝나지 않고 계속 기다림 → API 서버 요청도 같이 멈춤');
    assert.ok(res.e, '실패(reject)로 끝나야 함');
  });
  test('R2. Redis 가 강제로 끊기면(RST), 기다리던 요청이 2초 안에 실패해야 한다', async () => {
    const r = await fakeRedis();
    r.setMode('silent');
    const c = new RespClient({ port: r.port });
    const pending = c.command('GET', 'a');
    await sleep(100);
    r.destroyAll();
    const res = await within(pending, 2000);
    r.close();
    assert.notEqual(res, 'TIMEOUT', '강제로 끊겼는데 요청이 계속 기다림');
    assert.ok(res.e);
  });
  test('R3a. Redis 가 꺼진 뒤 새로 보내는 요청은 2초 안에 실패해야 한다', async () => {
    const r = await fakeRedis();
    const c = new RespClient({ port: r.port });
    assert.equal(await c.command('SET', 'a', '1'), 'OK');
    r.close(); // 연결 끊고 더 이상 받지도 않음 (Redis 종료)
    await sleep(200);
    const res = await within(c.command('GET', 'a'), 2000);
    c.close();
    assert.notEqual(res, 'TIMEOUT', '끊긴 연결에 보낸 요청이 영원히 대기');
    assert.ok(res.e, '실패해야 함');
  });
  test('R3b. Redis 가 재시작(연결만 끊김)되면 다음 요청 때 다시 연결해서 정상 응답한다', async () => {
    const r = await fakeRedis();
    const c = new RespClient({ port: r.port });
    assert.equal(await c.command('SET', 'a', '1'), 'OK');
    r.endAll();
    await sleep(200);
    const res = await within(c.command('GET', 'a'), 2000);
    r.close(); c.close();
    assert.notEqual(res, 'TIMEOUT');
    assert.equal(res.v, '1', `다시 연결해서 값을 읽어야 함: ${res.e?.message}`);
  });
  test('R3c. close() 를 부른 뒤의 요청은 바로 실패한다', async () => {
    const r = await fakeRedis();
    const c = new RespClient({ port: r.port });
    await c.command('SET', 'a', '1');
    c.close();
    const res = await within(c.command('GET', 'a'), 500);
    r.close();
    assert.ok(res !== 'TIMEOUT' && res.e);
  });
});

// ---------------------------------------------------------------- R4~R7 app.js
describe('R4~R7. app.js: 초기화 · 이상한 입력 · Redis 중단', () => {
  const ROWS = 20000; // 전체 읽기가 수 ms 걸리도록
  let app, fr, mini;
  before(async () => {
    fr = await fakeRedis();
    mini = await startRedisServer({ port: 0, aofPath: null });
    app = await startApp({ rows: ROWS, dir: tempDir('risk-app-'), redisPort: fr.port, miniPort: mini.port });
  });
  after(async () => { await app?.stop(); await mini?.close(); fr?.close(); });

  test('R4. 무거운 요청 200개가 밀려 있는 중에 초기화해도 서버가 살아 있고, 정확히 ROWS 건으로 돌아온다', async () => {
    const inflight = Array.from({ length: 200 }, (_, i) => fetch(`${app.base}/item/${1 + i}?backend=none&origin=scan`, { signal: AbortSignal.timeout(30000) }).then((r) => r.status, () => 'ERR'));
    await sleep(30);
    const t0 = performance.now();
    const reset = await (await fetch(`${app.base}/admin/reset`, { method: 'POST', signal: AbortSignal.timeout(60000) })).json();
    const resetMs = performance.now() - t0;
    const statuses = await Promise.all(inflight);
    const tally = statuses.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
    console.log(`  R4: 초기화 ${resetMs.toFixed(0)}ms · 밀려 있던 요청 결과 ${JSON.stringify(tally)}`);
    assert.equal(reset.rows, ROWS);
    assert.ok(await alive(app.base), '초기화 뒤 서버가 죽음');
    assert.ok(resetMs < 60000, 'k6 준비 단계 제한(60초) 안에 초기화가 끝나야 함');
    const after = await fetch(`${app.base}/item/77?backend=none&origin=scan`);
    assert.equal(after.status, 200, '초기화 뒤 정상 조회');
  });

  test('R5. 초기화 요청 두 개가 동시에 와도 결과가 맞고, 이후 쿼리가 정상이다', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${app.base}/admin/reset`, { method: 'POST' }).then((r) => r.status === 200 ? r.json() : { status: r.status })));
    assert.equal(a.rows, ROWS, `첫 번째 초기화: ${JSON.stringify(a)}`);
    assert.equal(b.rows, ROWS, `두 번째 초기화: ${JSON.stringify(b)}`);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${app.base}/item/${i + 1}?backend=none&origin=index`).then((r) => r.status)));
    assert.deepEqual([...new Set(rs)], [200], '동시 초기화 뒤 조회가 모두 성공해야 함');
  });

  test('R6. 이상한 입력은 서버를 죽이지 않고 4xx (또는 404) 로 끝난다', async () => {
    const cases = [
      ['/item/0?backend=none', [404]],
      ['/item/99999999999999999999999?backend=none&origin=index', [400, 404]],
      ['/item/1?backend=evil', [400]],
      ['/item/1?backend=none&origin=evil', [200]],            // origin 은 모르면 index 로
      ['/item/abc?backend=none', [404]],
      ["/item/1'%20OR%201=1?backend=none", [404]],
      ['/admin/reset', [404]],                                  // GET 으로 초기화 불가
      ['/admin/warm?backend=none', [404, 400]],
    ];
    const got = [];
    for (const [path, ok] of cases) {
      const r = await fetch(app.base + path);
      got.push(`${path} → ${r.status}`);
      assert.ok(ok.includes(r.status), `${path} → ${r.status} (기대 ${ok})`);
    }
    assert.ok(await alive(app.base));
  });

  test('R7. Redis 가 측정 중에 꺼지면, backend=redis 요청이 3초 안에 에러로 끝나고 서버는 살아 있다', async () => {
    assert.equal((await fetch(`${app.base}/item/5?backend=redis&origin=index`)).status, 200, '꺼지기 전에는 정상');
    fr.close(); // Redis 종료 (연결 끊고 새 연결도 받지 않음)
    await sleep(200);
    const res = await within(fetch(`${app.base}/item/6?backend=redis&origin=index`).then((r) => r.status), 3000);
    assert.notEqual(res, 'TIMEOUT', 'Redis 가 꺼진 뒤 요청이 응답 없이 멈춤 → k6 가 시간 초과까지 기다림');
    assert.ok(res.v >= 500, `에러 상태여야 함: ${res.v}`);
    assert.ok(await alive(app.base), '서버는 살아 있어야 함');
    assert.equal((await fetch(`${app.base}/item/7?backend=mini&origin=index`)).status, 200, '다른 캐시(mini)는 계속 동작');
  });
  test('R7b. 꺼졌던 Redis 가 같은 포트로 다시 뜨면, 서버를 재시작하지 않아도 backend=redis 가 다시 동작한다', async () => {
    fr = await fakeRedis(fr.port);
    const res = await within(fetch(`${app.base}/item/8?backend=redis&origin=index`).then((r) => r.status), 3000);
    assert.equal(res.v, 200, `다시 연결되어야 함: ${JSON.stringify(res)}`);
  });
});

// ---------------------------------------------------------------- R8 ROWS 변경
describe('R8. app.js: ROWS 를 바꿔 다시 켤 때', () => {
  for (const [first, second] of [[3000, 2000], [1000, 2500]]) {
    test(`R8. ${first}건으로 만든 데이터를 ROWS=${second} 로 다시 켜면 정확히 ${second}건`, async () => {
      const fr = await fakeRedis();
      const mini = await startRedisServer({ port: 0, aofPath: null });
      const dir = tempDir('risk-rows-');
      let app = await startApp({ rows: first, dir, redisPort: fr.port, miniPort: mini.port });
      await fetch(`${app.base}/item/1?backend=none`, { method: 'POST' }); // 쓰기로 한 건 더
      await app.stop();
      app = await startApp({ rows: second, dir, redisPort: fr.port, miniPort: mini.port });
      const info = await (await fetch(`${app.base}/admin/info`)).json();
      const reset = await (await fetch(`${app.base}/admin/reset`, { method: 'POST' })).json();
      await app.stop(); await mini.close(); fr.close();
      assert.equal(info.rows.find((t) => t.table === 'products').rows, second, '켜자마자');
      assert.equal(reset.rows, second, '초기화 뒤');
    });
  }
});

// ---------------------------------------------------------------- R9 analyze 부분 데이터
describe('R9. analyze.js: 일부 실험만 있을 때', () => {
  const raw = (b, exp, origin, h, rps) => ({ params: { BACKEND: b, ORIGIN: origin, MODE: 'hit', HIT: h, WORKLOAD: null, VUS: 50 }, rps, lat: { avg: 10, med: 10, 'p(95)': 20, 'p(99)': 30 }, hitRate: b === 'none' ? null : h, errorRate: 0 });
  const run = (files, { env = true } = {}) => {
    const dir = tempDir('risk-an-');
    mkdirSync(join(dir, 'results', 'raw'), { recursive: true });
    for (const f of ['analyze.js', 'charts.js']) copyFileSync(join(EXP, f), join(dir, f));
    if (env) writeFileSync(join(dir, 'results', 'env.json'), JSON.stringify({ measuredAt: 't', host: { cpu: 't' }, docker: { version: 't' }, method: { reps: 2, durationSec: 10 } }));
    for (const [name, d] of Object.entries(files)) writeFileSync(join(dir, 'results', 'raw', name), JSON.stringify(d));
    return spawnSync(process.execPath, [join(dir, 'analyze.js')], { encoding: 'utf8' });
  };
  test('R9a. E3 만 있음 (팀원이 --only E3 로 돌린 경우)', () => {
    const files = {};
    for (const r of [1, 2]) {
      files[`E3_none_index_h0_vu50_r${r}.json`] = raw('none', 'E3', 'index', 0, 5000 + r);
      for (const b of ['mini', 'redis']) for (const h of [0, 0.9, 1]) files[`E3_${b}_index_h${h}_vu50_r${r}.json`] = raw(b, 'E3', 'index', h, 3000 + h * 4000 + r);
    }
    const res = run(files);
    assert.equal(res.status, 0, res.stderr.split('\n').slice(0, 6).join('\n'));
  });
  test('R9b. E2 에서 히트율 100% 조건이 빠짐 (측정 도중 멈춘 경우)', () => {
    const files = {};
    for (const r of [1, 2]) {
      files[`E2_none_scan_h0_vu50_r${r}.json`] = raw('none', 'E2', 'scan', 0, 20 + r);
      for (const h of [0, 0.5, 0.9]) files[`E2_mini_scan_h${h}_vu50_r${r}.json`] = raw('mini', 'E2', 'scan', h, 20 / (1 - h) + r);
    }
    const res = run(files);
    assert.equal(res.status, 0, res.stderr.split('\n').slice(0, 6).join('\n'));
  });
  test('R9c. 같은 조건이 1회뿐 (반복 1회)', () => {
    const res = run({ 'E3_none_index_h0_vu50_r1.json': raw('none', 'E3', 'index', 0, 5000), 'E3_mini_index_h0_vu50_r1.json': raw('mini', 'E3', 'index', 0, 2000), 'E3_mini_index_h1_vu50_r1.json': raw('mini', 'E3', 'index', 1, 4000) });
    assert.equal(res.status, 0, res.stderr.split('\n').slice(0, 6).join('\n'));
  });
  test('R9d. env.json 이 없으면 무엇이 문제인지 알려 주고 끝나야 함 (스택 추적만 던지지 않기)', () => {
    const res = run({ 'E3_none_index_h0_vu50_r1.json': raw('none', 'E3', 'index', 0, 5000) }, { env: false });
    assert.doesNotMatch(res.stderr, /at .*analyze\.js:\d+/, `알기 어려운 에러로 죽음:\n${res.stderr.split('\n').slice(0, 4).join('\n')}`);
  });
});

// ---------------------------------------------------------------- R10 check.js 잘린 파일
describe('R10. check.js: 쓰다 만 결과 파일', () => {
  test('R10. 잘린 JSON 이 하나 섞여도 점검이 죽지 않고, 그 파일을 실패로 센다', () => {
    const dir = tempDir('risk-ck-');
    mkdirSync(join(dir, 'results', 'raw'), { recursive: true });
    copyFileSync(join(EXP, 'check.js'), join(dir, 'check.js'));
    for (const r of [1, 2, 3]) writeFileSync(join(dir, 'results', 'raw', `E3_x_vu50_r${r}.json`), JSON.stringify({ rps: 100 + r, errorRate: 0 }));
    writeFileSync(join(dir, 'results', 'raw', 'E3_x_vu50_r4.json'), '{"rps": 10'); // k6 가 쓰다가 끊김
    const res = spawnSync(process.execPath, [join(dir, 'check.js')], { encoding: 'utf8' });
    assert.equal(res.status, 0, `점검 스크립트가 죽음: ${res.stderr.split('\n').slice(0, 3).join(' | ')}`);
    assert.match(res.stdout, /runs=4/);
  });
});

// ---------------------------------------------------------------- R11 compare-hosts
describe('R11. compare-hosts.js: 비교 보고서의 결론이 데이터를 따르는가', () => {
  const cond = (exp, b, h, rps, speedupRps) => ({ exp, BACKEND: b, HIT: h, rps: { median: rps }, speedupRps });
  const summaryWith = (scale, mini1) => ({ conditions: [
    cond('E2', 'mini', 0.9, 200 * scale, 9 * scale), cond('E2', 'redis', 0.9, 220 * scale, 9.5 * scale),
    cond('E3', 'mini', 1, 4500, mini1), cond('E3', 'redis', 1, 19000, 3.9),
  ] });
  const runCompare = (local, remote, remoteHost) => {
    const dir = tempDir('risk-cmp-');
    mkdirSync(join(dir, 'results'), { recursive: true });
    mkdirSync(join(dir, 'results-remote'), { recursive: true });
    copyFileSync(join(EXP, 'compare-hosts.js'), join(dir, 'compare-hosts.js'));
    writeFileSync(join(dir, 'results', 'summary.json'), JSON.stringify(local));
    writeFileSync(join(dir, 'results', 'env.json'), JSON.stringify({ host: { cpu: 'CPU-A', logicalCores: 8 } }));
    writeFileSync(join(dir, 'results-remote', 'r.json'), JSON.stringify({ hostId: remoteHost, host: { cpu: remoteHost === 'same' ? 'CPU-A' : 'CPU-B', logicalCores: 8 }, ...remote }));
    const res = spawnSync(process.execPath, [join(dir, 'compare-hosts.js')], { encoding: 'utf8' });
    return { res, report: existsSync(join(dir, 'results', 'cross-host-comparison.md')) ? readFileSync(join(dir, 'results', 'cross-host-comparison.md'), 'utf8') : '' };
  };
  test('R11a. 결과가 크게 다르면(배율 3배 차이, 미니 레디스가 한쪽에서만 이득) "재현됐다" 고 쓰면 안 된다', () => {
    const { res, report } = runCompare(summaryWith(1, 0.92), summaryWith(3, 1.8), 'other-pc');
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(report, /동일하게 입증|일관되게 재현|100% 재현/, '데이터가 다른데도 결론에 "재현/입증" 이라고 고정 문구를 씀');
  });
  test('R11b. 같은 컴퓨터(같은 CPU · 같은 호스트 이름)끼리 비교하면 경고해야 한다', () => {
    const s = summaryWith(1, 0.92);
    const { report } = runCompare(s, s, hostname().toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
    assert.match(report, /같은 (컴퓨터|머신|PC)|동일한 (컴퓨터|머신|PC)|same host/i, '자기 자신과 비교했는데 경고 없이 "서로 다른 머신" 으로 보고함');
  });
  test('R11c. 다른 컴퓨터에서 배율이 ±15% 안으로 같으면 두 발견 모두 "재현됨" 으로 판정한다', () => {
    const remote = summaryWith(1, 0.95);
    for (const c of remote.conditions) { c.rps.median *= 0.6; c.speedupRps *= 1.05; } // 느린 PC: 절대값은 다르고 배율은 비슷
    const { res, report } = runCompare(summaryWith(1, 0.92), remote, 'other-pc');
    assert.equal(res.status, 0, res.stderr);
    assert.match(report, /발견 1 재현됨/);
    assert.match(report, /발견 2 재현됨/);
    assert.doesNotMatch(report, /같은 컴퓨터끼리/);
  });
});

// ---------------------------------------------------------------- R12 export
describe('R12. export.js', () => {
  test('R12. 결과가 없으면 안내와 함께 실패 코드로 끝난다', () => {
    const dir = tempDir('risk-ex-');
    mkdirSync(join(dir, 'results'), { recursive: true });
    copyFileSync(join(EXP, 'export.js'), join(dir, 'export.js'));
    const res = spawnSync(process.execPath, [join(dir, 'export.js')], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /결과 파일이 없습니다/);
  });
});
