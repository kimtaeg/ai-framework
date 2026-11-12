/**
 * 테스트 실험실 (나만 들어가는 페이지)
 *  - 비밀번호는 서버에서만 확인한다. 저장하는 것은 scrypt 해시뿐 (.env 의 TESTLAB_PASSWORD_HASH).
 *    해시가 없으면 실험실은 잠긴 채로 열리지 않는다.
 *  - 로그인하면 HttpOnly · SameSite=Strict 세션 쿠키 (12시간). 15분 안에 5번 틀리면 로그인 막힘.
 *  - 보호하는 경로: /testlab/ (로그인 페이지 제외), /bench/, /load/
 *  - 돌릴 수 있는 작업은 미리 정해 둔 명령뿐 (입력값으로 명령을 만들지 않는다). 한 번에 하나.
 *
 *  비밀번호 바꾸기:  node server/testlab.js --set-password   (입력은 화면에 보이지 않음)
 *
 *  POST /api/testlab/login   { password }      → 쿠키
 *  POST /api/testlab/logout
 *  GET  /api/testlab/state?from=N              → 작업 목록, 지금 작업과 그 출력(N줄부터), 기록, 리포트
 *  POST /api/testlab/run     { job, option? }
 *  POST /api/testlab/stop
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COOKIE = 'testlab';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_LINES = 5000;
const PROTECTED = ['/testlab/', '/bench/', '/load/'];
const PUBLIC_IN_LAB = new Set(['/testlab/login.html']);

// ------------------------------------------------------------------ 비밀번호 해시
export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const m = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[2], 'hex');
  const got = scryptSync(String(password), Buffer.from(m[1], 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

// ------------------------------------------------------------------ 작업
function findK6() {
  const candidates = [process.env.K6_PATH, 'C:\\Program Files\\k6\\k6.exe', '/usr/local/bin/k6', '/usr/bin/k6', '/opt/homebrew/bin/k6'].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const name of process.platform === 'win32' ? ['k6.exe'] : ['k6']) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** 결과에 쓰는 지표: 이름, 단위, 어느 쪽이 좋은지 (화면이 "몇 배 · 지난번보다" 를 계산할 때 씀) */
export const METRICS = {
  rps: { label: '초당 요청', unit: '/s', better: 'high' },
  p95: { label: 'p95 응답', unit: 'ms', better: 'low' },
  med: { label: '중앙값 응답', unit: 'ms', better: 'low' },
  fail: { label: '실패율', unit: '%', better: 'low' },
  cacheHit: { label: '캐시 HIT', unit: '%', better: 'high' },
  tests: { label: '테스트 수', unit: '개', better: 'high' },
  failed: { label: '실패한 테스트', unit: '개', better: 'low' },
  sec: { label: '걸린 시간', unit: '초', better: 'low' },
  indexMs: { label: '인덱스 조회', unit: 'ms', better: 'low' },
  scanMs: { label: '전체 읽기', unit: 'ms', better: 'low' },
  speedup: { label: '인덱스가 빠른 배수', unit: '배', better: 'high' },
  // 대안 기술 비교
  buildMs: { label: '10만 개 넣기', unit: 'ms', better: 'low' },
  lookupUs: { label: '점 조회 1번 (id = ?)', unit: 'μs', better: 'low' },
  rangeMs: { label: '범위 조회 1,000개 (BETWEEN)', unit: 'ms', better: 'low' },
  msPerQuery: { label: '쿼리 1개당', unit: 'ms', better: 'low' },
  mainBusy: { label: '메인 스레드 사용률', unit: '%', better: 'low' },
  writesPerSec: { label: '초당 쓰기', unit: '/s', better: 'high' },
  blockMs: { label: '서버가 멈춘 최대 시간', unit: 'ms', better: 'low' },
  fileKB: { label: '파일 크기', unit: 'KB', better: 'low' },
  recoverMs: { label: '다시 켤 때 복구', unit: 'ms', better: 'low' },
};

/** 대안 비교 (node load/alt-bench.js <what>) 의 마지막 줄 RESULT {json} 을 읽는다 */
const altNodeJob = (what) => async ({ run, lines, record }) => {
  const code = await run(process.execPath, ['load/alt-bench.js', what]);
  const m = lastMatch(lines, /^RESULT (\{.*\})$/);
  if (!code && m) record(JSON.parse(m[1]));
  return code || (m ? 0 : 1);
};

/** 대안 비교 (k6): 같은 부하를 여러 방식으로, 매번 새 대상 서버에서 */
const altK6Job = ({ mode, variants, main = 'rps' }) => async ({ log, startTarget, runK6, record, option }) => {
  if (!needK6(log)) return 1;
  const out = [];
  for (const [v, label] of variants) {
    log(`── ${label}`);
    const target = await startTarget();
    try {
      const r = await runK6('load/k6-compare.js', { MODE: mode, VARIANT: v, DURATION: option }, target.base);
      if (r.code || !r.metrics) return r.code || 1;
      out.push({ label, metrics: r.metrics });
      log(`   초당 ${r.metrics.rps.toLocaleString()}개 · p95 ${r.metrics.p95}ms · 실패 ${r.metrics.fail}%`);
    } finally {
      await target.stop();
    }
  }
  record({ main, variants: out });
  return 0;
};

/** k6 요약 파일(--summary-export) → 지표 */
function k6Metrics(file) {
  const m = JSON.parse(readFileSync(file, 'utf8')).metrics;
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return {
    rps: r2(m.http_reqs?.rate),
    p95: r2(m.http_req_duration?.['p(95)']),
    med: r2(m.http_req_duration?.med),
    fail: r2((m.http_req_failed?.value ?? 0) * 100),
    ...(m.cache_hit && (m.cache_hit.passes || m.cache_hit.fails) ? { cacheHit: r2(m.cache_hit.value * 100) } : {}),
  };
}

const needK6 = (log) => {
  const k6 = findK6();
  if (!k6) log('k6 가 설치되어 있지 않습니다. (Windows: winget install k6)');
  return k6;
};

/** k6 작업: 임시 데이터로 별도 서버를 띄우고, 그 서버를 대상으로 k6 를 돌린 뒤 서버를 끈다 */
const k6Job = (script, name) => async ({ log, startTarget, runK6, record }) => {
  if (!needK6(log)) return 1;
  const target = await startTarget();
  try {
    mkdirSync(join(ROOT, 'load', 'reports'), { recursive: true });
    const report = `load/reports/${name}-${stamp()}.html`;
    log(`대상 서버: ${target.base} (임시 데이터, 실제 데이터는 건드리지 않음)`);
    log(`실시간 대시보드: http://127.0.0.1:5665 (이 PC 에서만) · 끝나면 리포트: /${report}`);
    log('※ 대시보드를 열어 두면 테스트가 끝난 뒤에도 그 탭을 닫을 때까지 작업이 끝나지 않습니다.');
    const r = await runK6(script, {}, target.base, { K6_WEB_DASHBOARD: 'true', K6_WEB_DASHBOARD_HOST: '127.0.0.1', K6_WEB_DASHBOARD_PORT: '5665', K6_WEB_DASHBOARD_PERIOD: '2s', K6_WEB_DASHBOARD_EXPORT: report });
    if (r.metrics) record({ metrics: r.metrics, report: `/${report}` });
    return r.code;
  } finally {
    await target.stop();
  }
};

/**
 * 비교 실험: 같은 부하를 "기술 있음(a)" 과 "없음(b)" 으로 한 번씩. 매번 새 대상 서버를 띄워 조건을 같게 한다.
 * @param {{mode, a, b, targetA?, targetB?}} spec  a/b = 화면에 보일 이름
 */
const compareJob = ({ mode, a, b, targetA = {}, targetB = {} }) => async ({ log, startTarget, runK6, record, option }) => {
  if (!needK6(log)) return 1;
  const out = {};
  for (const [v, label, tenv] of [['a', a, targetA], ['b', b, targetB]]) {
    log(`── ${v === 'a' ? '기술 있음' : '기술 없음'}: ${label}`);
    const target = await startTarget(tenv);
    try {
      const r = await runK6('load/k6-compare.js', { MODE: mode, VARIANT: v, DURATION: option }, target.base);
      if (r.code || !r.metrics) return r.code || 1;
      out[v] = { label, metrics: r.metrics };
      log(`   초당 ${r.metrics.rps.toLocaleString()}개 · p95 ${r.metrics.p95}ms · 실패 ${r.metrics.fail}%`);
    } finally {
      await target.stop();
    }
  }
  const x = out.a.metrics.rps / Math.max(out.b.metrics.rps, 0.01);
  log(`→ 기술 있음이 초당 요청 ${x.toFixed(1)}배, p95 는 ${(out.b.metrics.p95 / Math.max(out.a.metrics.p95, 0.01)).toFixed(1)}배 빠름`);
  record({ a: out.a, b: out.b });
  return 0;
};

/** 출력 줄에서 지표 뽑기 (k6 가 아닌 작업) */
const lastMatch = (lines, re) => { for (let i = lines.length - 1; i >= 0; i--) { const m = re.exec(lines[i]); if (m) return m; } return null; };
const num = (s) => Number(String(s).replace(/,/g, ''));

const DURATIONS = { '20s': '20초씩', '60s': '60초씩 (더 안정적)' };

export const DEFAULT_JOBS = {
  unit: {
    title: '단위 · 기능 테스트',
    desc: '1주차 + 2주차 테스트 전부 (npm test 와 같음). 약 2분.',
    run: async ({ run, lines, record }) => {
      const code = (await run(process.execPath, ['build.js'])) || (await run(process.execPath, ['--test', '--test-timeout=20000', 'tests/**/*.test.js']));
      const t = lastMatch(lines, /^ℹ tests (\d+)/), f = lastMatch(lines, /^ℹ fail (\d+)/), d = lastMatch(lines, /^ℹ duration_ms ([\d.]+)/);
      if (t) record({ metrics: { tests: num(t[1]), failed: f ? num(f[1]) : null, sec: d ? Math.round(num(d[1]) / 100) / 10 : null } });
      return code;
    },
  },
  'k6-mixed': {
    title: '부하 테스트 (k6)',
    desc: '최대 200명이 페이지 · 레디스 · 캐시 · SQL 을 섞어서 요청. 약 1분 30초.',
    run: k6Job('load/k6-mixed.js', 'mixed'),
  },
  'k6-limit': {
    title: '한계 찾기 (k6)',
    desc: '초당 요청을 1,000 → 15,000 회로 계단식으로 올림. 약 3분 30초.',
    run: k6Job('load/k6-limit.js', 'limit'),
  },
  'dbms-bench': {
    title: 'DBMS 인덱스 vs 선형 탐색',
    desc: 'B+ 트리 인덱스와 전체 읽기 비교. 10만 건 약 10초, 100만 건 약 1~2분.',
    options: { '100000': '10만 건', '1000000': '100만 건' },
    run: async ({ run, option, lines, record }) => {
      const code = await run(process.execPath, ['week2/dbms/bench.js', '--rows', option]);
      const i = lastMatch(lines, /^id = \?.*평균 ([\d.]+)ms/), s = lastMatch(lines, /^email = \?.*평균 ([\d.]+)ms/), x = lastMatch(lines, /약 ([\d,]+)배 빠름/);
      if (i && s) record({ metrics: { indexMs: num(i[1]), scanMs: num(s[1]), speedup: x ? num(x[1]) : null } });
      return code;
    },
  },
  'cmp-cache': {
    title: '캐시 있음 vs 없음',
    desc: '같은 상품 조회를 미니 레디스 캐시로 (있음) vs 매번 느린 원본(120ms)에서 (없음). 50명.',
    compare: true,
    options: DURATIONS,
    run: compareJob({ mode: 'cache', a: '캐시 있음 (cache-aside)', b: '캐시 없음 (매번 원본)' }),
  },
  'cmp-index': {
    title: '인덱스 있음 vs 없음',
    desc: '1만 명 중 한 명 찾기를 id (B+ 트리) vs email (전체 읽기) 로. 50명.',
    compare: true,
    options: DURATIONS,
    run: compareJob({ mode: 'index', a: 'B+ 트리 인덱스 (id)', b: '전체 읽기 (email)' }),
  },
  'cmp-pool': {
    title: '스레드 풀 4개 vs 1개',
    desc: '같은 SQL 을 워커 4개 서버 (있음) vs 1개 서버 (없음) 에. 50명.',
    compare: true,
    options: DURATIONS,
    run: compareJob({ mode: 'pool', a: '워커 4개', b: '워커 1개', targetA: { TARGET_DB_WORKERS: '4' }, targetB: { TARGET_DB_WORKERS: '1' } }),
  },
  'cmp-aof': {
    title: 'AOF 묶어 쓰기 vs 매번 쓰기',
    desc: '같은 쓰기를 everysec (1초마다 묶어서) vs always (쓸 때마다 디스크). 50명.',
    compare: true,
    options: DURATIONS,
    run: compareJob({ mode: 'aof', a: 'everysec (묶어 쓰기)', b: 'always (매번 디스크)', targetA: { TARGET_FSYNC: 'everysec' }, targetB: { TARGET_FSYNC: 'always' } }),
  },
  'alt-cache': {
    title: '캐시: 미니 레디스 vs 서버 안 메모리',
    desc: '같은 상품 조회를 미니 레디스 / API 서버 안 Map / 캐시 없음 으로. 50명. 약 1분 10초.',
    why: "서버 안 Map 이 더 빠르다 (네트워크를 안 거침). 대신 서버가 여러 대면 캐시를 나눠 쓰지 못하고, 서버를 다시 켜면 비워지고, 태그로 한꺼번에 지울 수 없다. 미니 레디스는 여러 서버가 같이 쓰고 AOF 로 남는다.",
    alt: true,
    options: DURATIONS,
    run: altK6Job({ mode: 'altcache', variants: [['a', '미니 레디스 캐시 (우리)'], ['b', '서버 안 메모리 캐시 (Map)'], ['c', '캐시 없음']] }),
  },
  'alt-index': {
    title: '인덱스: B+ 트리 vs 해시 vs 정렬 배열',
    desc: '10만 개 키로 넣기 · 점 조회 · 범위 조회를 세 자료구조에서. 약 10초.',
    why: "해시는 점 조회(id = ?)만 빠르고 범위(BETWEEN · ORDER BY)는 전부 훑어야 한다. 정렬 배열은 조회는 좋지만 넣을 때마다 뒤를 밀어서 느리다. 둘 다 고르게 잘하는 것이 B+ 트리 — 그래서 실제 DB 도 쓴다.",
    alt: true,
    run: altNodeJob('index'),
  },
  'alt-pool': {
    title: '동시성: 스레드 풀 vs 요청마다 워커 vs 메인 스레드',
    desc: '같은 SQL 120개를 세 방식으로 · 메인 스레드가 얼마나 바빴는지도. 약 20초.',
    why: "메인 스레드에서 바로 하면 쿼리 도는 동안 서버가 다른 요청에 답을 못 하고(100%), 요청마다 워커를 새로 만들면 만들고 인덱스를 다시 읽는 비용이 매번 든다. 풀은 미리 만든 워커를 계속 쓴다.",
    alt: true,
    run: altNodeJob('pool'),
  },
  'alt-persist': {
    title: '영속성: AOF everysec vs always vs 스냅샷',
    desc: '키 10만 개에 쓰기를 퍼부으며 속도 · 멈춤 · 파일 크기 · 복구 시간. 약 15초.',
    why: "everysec 가 가장 빠르고 멈춤도 짧지만, 꺼지면 최대 1초치를 잃고 파일이 계속 커진다(재작성으로 줄임). always 는 잃는 것이 없지만 느리고, 스냅샷은 저장할 때마다 서버가 멈추고 저장 사이의 쓰기를 잃는다.",
    alt: true,
    run: altNodeJob('persist'),
  },
};

// ------------------------------------------------------------------ 실험실
export function createTestLab({ root = ROOT, passwordHash, jobs = DEFAULT_JOBS, now = () => Date.now(), resultsFile = join(root, 'load', 'results', 'history.json') } = {}) {
  const getHash = () => passwordHash ?? process.env.TESTLAB_PASSWORD_HASH ?? '';
  const sessions = new Map(); // token → 만료 시각
  const fails = new Map(); // ip → { count, first }
  let current = null; // { id, job, title, status, lines, exitCode, startedAt, endedAt, children:Set }
  const history = [];
  let seq = 0;

  // --- 결과 저장 (서버를 다시 켜도 남는다 → "지난번과 비교")
  //  같은 파일을 서버 여러 개가 같이 쓸 수 있으므로(예: 5200 과 확인용 서버), 메모리에 들고 있지 않고
  //  읽을 때마다 파일에서 읽고, 저장할 때는 "방금 읽은 파일 + 새 결과" 를 임시 파일에 쓴 뒤 바꿔치기한다.
  const loadResults = () => {
    try { const r = JSON.parse(readFileSync(resultsFile, 'utf8')); return Array.isArray(r) ? r : []; } catch { return []; }
  };
  const saveResult = (rec) => {
    try {
      mkdirSync(join(resultsFile, '..'), { recursive: true });
      const merged = [rec, ...loadResults().filter((r) => r.id !== rec.id)].slice(0, 200);
      const tmp = `${resultsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 1));
      renameSync(tmp, resultsFile);
    } catch {}
  };
  /** 작업마다(옵션까지 같은 것끼리) 최근 결과와 그 전 결과 */
  const latestResults = () => {
    const out = {};
    for (const r of loadResults()) {
      const k = `${r.job}|${r.option ?? ''}`;
      (out[k] ??= { job: r.job, option: r.option ?? null, title: r.title, runs: [] }).runs.length < 2 && out[k].runs.push(r);
    }
    return Object.values(out);
  };

  const cookieOf = (req) => {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const authed = (req) => {
    const t = cookieOf(req);
    const exp = t && sessions.get(t);
    if (!exp) return false;
    if (exp < now()) { sessions.delete(t); return false; }
    return true;
  };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((ok, bad) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { bad(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { bad(new Error('bad json')); } });
    req.on('error', bad);
  });
  /** 다른 사이트에서 보낸 POST 는 거절 (Origin 이 있으면 Host 와 같아야 함) */
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };
  const ipOf = (req) => req.socket.remoteAddress || '?';

  // --- 작업 실행
  function startJob(name, option) {
    const def = jobs[name];
    const job = { id: ++seq, job: name, title: def.title, option: option ?? null, status: 'running', lines: [], exitCode: null, startedAt: now(), endedAt: null, children: new Set(), stopped: false };
    current = job;
    const log = (line) => {
      for (const l of String(line).split(/\r?\n/)) {
        if (!l.trim()) continue;
        job.lines.push(l);
        if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES), (job.dropped = (job.dropped || 0) + 1);
      }
    };
    const run = (cmd, args, { env = {} } = {}) => new Promise((ok) => {
      if (job.stopped) return ok(130);
      log(`$ ${[cmd === process.execPath ? 'node' : cmd.split(/[\\/]/).pop(), ...args].join(' ')}`);
      const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true });
      job.children.add(child);
      let buf = { out: '', err: '' };
      const feed = (k) => (d) => { buf[k] += d.toString('utf8'); const parts = buf[k].split(/\r?\n/); buf[k] = parts.pop(); parts.forEach(log); };
      child.stdout.on('data', feed('out'));
      child.stderr.on('data', feed('err'));
      child.on('error', (e) => log(`실행 실패: ${e.message}`));
      child.on('close', (code) => { log(buf.out); log(buf.err); job.children.delete(child); ok(code ?? 1); });
    });
    /** k6 를 돌리고 요약 파일에서 지표를 읽는다 */
    const runK6 = async (script, env, base, extraEnv = {}) => {
      const file = join(tmpdir(), `testlab-k6-${process.pid}-${job.id}-${Math.random().toString(36).slice(2)}.json`);
      const args = ['run', '--no-color', '--quiet', '--summary-export', file, '-e', `BASE=${base}`];
      for (const [k, v] of Object.entries(env)) if (v != null) args.push('-e', `${k}=${v}`);
      const code = await run(findK6(), [...args, script], { env: extraEnv });
      let metrics = null;
      try { metrics = k6Metrics(file); } catch {}
      try { rmSync(file, { force: true }); } catch {}
      return { code, metrics };
    };
    let pending = null;
    const record = (data) => { pending = data; };
    const startTarget = (env = {}) => new Promise((ok, bad) => {
      const child = spawn(process.execPath, [join(root, 'server', 'testlab-target.js')], { cwd: root, windowsHide: true, env: { ...process.env, ...env } });
      job.children.add(child);
      let dir = null, out = '';
      const stop = () => new Promise((done) => {
        if (child.exitCode != null) return done();
        child.once('close', () => done());
        child.kill();
      }).then(() => { job.children.delete(child); if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} });
      child.stdout.on('data', (d) => {
        out += d.toString('utf8');
        const port = /TARGET_PORT=(\d+)/.exec(out)?.[1];
        dir = /TARGET_DIR=(.+)/.exec(out)?.[1]?.trim() ?? dir;
        if (port) ok({ base: `http://127.0.0.1:${port}`, stop });
      });
      child.stderr.on('data', (d) => log(d.toString('utf8')));
      child.on('close', (code) => { if (!/TARGET_PORT=/.test(out)) bad(new Error(`대상 서버가 시작되지 않았습니다 (${code})`)); });
    });
    (async () => {
      let code = 1;
      try { code = await def.run({ run, log, startTarget, runK6, record, option, lines: job.lines }); } catch (e) { log(`오류: ${e.message}`); code = 1; }
      job.exitCode = code;
      job.status = job.stopped ? 'stopped' : code === 0 ? 'passed' : 'failed';
      job.endedAt = now();
      // 끝까지 성공한 실행만 결과로 남긴다 (멈추거나 실패한 실행은 비교 기준이 되면 안 됨)
      if (pending && job.status === 'passed') saveResult({ id: `${job.startedAt}-${job.id}`, job: job.job, title: job.title, option: job.option, compare: !!def.compare, alt: !!def.alt, at: job.startedAt, sec: Math.round((job.endedAt - job.startedAt) / 1000), ...pending });
      log(job.status === 'passed' ? '✓ 끝 (성공)' : job.status === 'stopped' ? '■ 멈춤' : `✗ 끝 (실패, 종료 코드 ${code})`);
      history.unshift({ id: job.id, job: job.job, title: job.title, option: job.option, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, summary: summarize(job.lines) });
      history.length = Math.min(history.length, 20);
    })();
    return job;
  }

  function stopJob() {
    if (!current || current.status !== 'running') return false;
    current.stopped = true;
    for (const c of current.children) try { c.kill(); } catch {}
    return true;
  }

  function reports() {
    const dir = join(root, 'load', 'reports');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => ({ path: `/load/reports/${f}`, name: f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 20);
  }

  const view = (from = 0) => ({
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, { title: v.title, desc: v.desc, options: v.options ?? null, compare: !!v.compare, alt: !!v.alt, why: v.why ?? null }])),
    metrics: METRICS,
    results: latestResults(),
    current: current && { id: current.id, job: current.job, title: current.title, option: current.option, status: current.status, exitCode: current.exitCode, startedAt: current.startedAt, endedAt: current.endedAt, total: current.lines.length, from, lines: current.lines.slice(from) },
    history,
    reports: reports(),
  });

  // --- 요청 처리: 처리했으면 true, 아니면 false (정적 파일로 넘어감)
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p.startsWith('/api/testlab/')) {
      const action = p.slice('/api/testlab/'.length);
      if (!getHash()) return json(res, 503, { error: '실험실 비밀번호가 설정되지 않았습니다. node server/testlab.js --set-password' }), true;
      if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: '다른 사이트에서 온 요청입니다.' }), true;

      if (action === 'login' && req.method === 'POST') {
        const ip = ipOf(req);
        const f = fails.get(ip);
        if (f && now() - f.first > FAIL_WINDOW_MS) fails.delete(ip);
        const ff = fails.get(ip);
        if (ff && ff.count >= MAX_FAILS) {
          const wait = Math.ceil((FAIL_WINDOW_MS - (now() - ff.first)) / 60000);
          return json(res, 429, { error: `비밀번호를 ${MAX_FAILS}번 틀려서 ${wait}분 동안 로그인할 수 없습니다.` }), true;
        }
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { error: '잘못된 요청' }), true; }
        if (typeof body.password !== 'string' || !verifyPassword(body.password, getHash())) {
          const cur = fails.get(ip) || { count: 0, first: now() };
          cur.count++;
          fails.set(ip, cur);
          return json(res, 401, { error: '비밀번호가 맞지 않습니다.', left: Math.max(0, MAX_FAILS - cur.count) }), true;
        }
        fails.delete(ip);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, now() + SESSION_MS);
        return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` }), true;
      }
      if (!authed(req)) return json(res, 401, { error: '로그인이 필요합니다.' }), true;

      if (action === 'logout' && req.method === 'POST') {
        sessions.delete(cookieOf(req));
        return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }), true;
      }
      if (action === 'state' && req.method === 'GET') {
        const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
        return json(res, 200, view(from)), true;
      }
      if (action === 'run' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { error: '잘못된 요청' }), true; }
        const def = Object.hasOwn(jobs, body.job) ? jobs[body.job] : null;
        if (!def) return json(res, 400, { error: '없는 작업입니다.' }), true;
        let option = null;
        if (def.options) {
          option = String(body.option ?? Object.keys(def.options)[0]);
          if (!Object.hasOwn(def.options, option)) return json(res, 400, { error: '없는 옵션입니다.' }), true;
        }
        if (current?.status === 'running') return json(res, 409, { error: `이미 "${current.title}" 이(가) 돌고 있습니다.` }), true;
        const job = startJob(body.job, option);
        return json(res, 200, { id: job.id }), true;
      }
      if (action === 'stop' && req.method === 'POST') return json(res, 200, { stopped: stopJob() }), true;
      return json(res, 404, { error: '없는 주소' }), true;
    }

    // --- 보호 경로의 정적 파일 (정적 파일 서빙과 동일하게 경로 디코딩·정규화 후 검사)
    let decoded;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad Request');
      return true;
    }
    const norm = posix.normalize(decoded.replace(/\\/g, '/'));
    const normLower = norm.toLowerCase();
    if (PROTECTED.some((pre) => normLower === pre.slice(0, -1) || normLower.startsWith(pre)) && !PUBLIC_IN_LAB.has(normLower)) {
      if (!getHash()) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('실험실 비밀번호가 설정되지 않았습니다. 서버 폴더에서: node server/testlab.js --set-password');
        return true;
      }
      if (authed(req)) return false; // 로그인됨 → 정적 파일 그대로
      const isPage = normLower.endsWith('/') || normLower.endsWith('.html') || normLower === '/testlab' || normLower === '/bench' || normLower === '/load';
      if (isPage && req.method === 'GET') {
        res.writeHead(302, { Location: `/testlab/login.html?next=${encodeURIComponent(norm)}`, 'Cache-Control': 'no-store' }).end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('로그인이 필요합니다.');
      }
      return true;
    }
    return false;
  }

  return { handle, stopJob, get current() { return current; }, sessions };
}

/** 출력에서 한 줄 요약을 뽑는다 (기록 목록용) */
function summarize(lines) {
  const pick = (re) => { for (let i = lines.length - 1; i >= 0; i--) { const m = re.exec(lines[i]); if (m) return m; } return null; };
  const cmp = pick(/^→ (기술 있음이 .*)$/);
  if (cmp) return cmp[1];
  const t = pick(/^ℹ tests (\d+)/), f = pick(/^ℹ fail (\d+)/);
  if (t) return `테스트 ${t[1]}개 · 실패 ${f ? f[1] : '?'}개`;
  const reqs = pick(/http_reqs\.*:\s*([\d,]+)\s+([\d.]+)\/s/), failed = pick(/http_req_failed\.*:\s*([\d.]+%)/);
  if (reqs) return `요청 ${Number(reqs[1].replace(/,/g, '')).toLocaleString()}개 (초당 ${Math.round(Number(reqs[2])).toLocaleString()}) · 실패 ${failed ? failed[1] : '?'}`;
  const idx = pick(/인덱스가 약 ([\d,]+)배 빠름/), b = pick(/^id = \?.*평균 ([\d.]+ms)/), sc = pick(/^email = \?.*평균 ([\d.]+ms)/);
  if (idx) return `인덱스 ${b ? b[1] : '?'} · 선형 ${sc ? sc[1] : '?'} → 약 ${idx[1]}배 빠름`;
  return '';
}

// ------------------------------------------------------------------ 비밀번호 설정 (node server/testlab.js --set-password)
async function readHidden(prompt) {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) { // 파이프로 받는 경우
    let s = '';
    for await (const c of stdin) s += c;
    process.stdout.write('\n');
    return s.replace(/\r?\n$/, '');
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((ok) => {
    let s = '';
    stdin.on('data', function on(d) {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return ok(s); }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    });
  });
}

export function writeEnvValue(file, key, value) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else { if (lines.length && lines.at(-1) === '') lines.pop(); lines.push(`${key}=${value}`, ''); }
  writeFileSync(file, lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--set-password')) {
  const pw = await readHidden('새 실험실 비밀번호: ');
  if (pw.length < 8) { console.error('8자 이상으로 정해 주세요.'); process.exit(1); }
  writeEnvValue(join(ROOT, '.env'), 'TESTLAB_PASSWORD_HASH', hashPassword(pw));
  console.log('저장했습니다 (.env 에는 해시만 들어갑니다). 서버를 다시 켜면 적용됩니다.');
}
