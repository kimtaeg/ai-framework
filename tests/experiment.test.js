/**
 * 캐시 실험 코드(experiment/) 무작위 검증 — 400 케이스
 *   node --test tests/experiment.test.js            (매번 다른 씨앗)
 *   SEED=12345 node --test tests/experiment.test.js  (실패한 씨앗 그대로 재현)
 *
 *  A. RESP 클라이언트 왕복 100   가짜 TCP 서버가 받은 명령을 검사하고, 응답을 무작위 조각으로 쪼개 보낸다
 *  B. check.js 신뢰도 60         무작위 회차 → 독립 계산한 신뢰도와 비교 (N/A 경우 포함)
 *  C. analyze.js 통계·공식 50     정답을 아는 합성 데이터 → 중앙값 · 신뢰구간 · 배율 · 공식 오차 · 손익분기
 *  D. charts.js SVG 40           무작위 시리즈 → 좌표가 그림 안 · NaN 없음 · 태그 짝 · 글자 이스케이프
 *  E. k6 Zipf · 해시 40          범위 · 결정성 · 1위 키 빈도가 이론값과 맞는지
 *  F. run.js 조건표 · 섞기 20     조건 개수 · 이름 중복 없음 · 섞기는 순열이고 씨앗마다 같음
 *  G. app.js 통합 90             실제 서버 + 미니 레디스 + 가짜 Redis 로 무작위 요청 → 독립 모델과 비교
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RespClient } from '../experiment/resp.js';
import { renderHitChart, renderBarChart } from '../experiment/charts.js';
import { startRedisServer } from '../week2/redis/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXP = join(ROOT, 'experiment');
const SEED = Number(process.env.SEED) || (Date.now() % 1_000_000_007);
console.log(`# experiment 검증 SEED=${SEED}  (재현: SEED=${SEED} node --test tests/experiment.test.js)`);

// ---------- 공통 도구 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // [lo, hi] 정수
const rf = (lo, hi) => lo + rand() * (hi - lo);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const T95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365];
const ci95 = (xs) => { const n = xs.length; if (n < 2) return 0; const m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return T95[n - 1] * sd / Math.sqrt(n); };
const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function randomText(maxLen = 12) {
  const parts = ['a', 'Z', '7', ' ', '-', ':', '\r\n', '\n', '한', '글', '😀', '$', '*', '+', '\\', '"'];
  let s = '';
  for (let i = ri(0, maxLen); i > 0; i--) s += pick(parts);
  return s;
}

// RESP 인코딩 (테스트 쪽 독립 구현)
function encodeReply(v) {
  if (v.t === 'simple') return `+${v.v}\r\n`;
  if (v.t === 'error') return `-${v.v}\r\n`;
  if (v.t === 'int') return `:${v.v}\r\n`;
  if (v.t === 'null') return '$-1\r\n';
  if (v.t === 'bulk') return `$${Buffer.byteLength(v.v)}\r\n${v.v}\r\n`;
  if (v.t === 'nullarr') return '*-1\r\n';
  return `*${v.v.length}\r\n${v.v.map(encodeReply).join('')}`;
}
function expectedOf(v) {
  if (v.t === 'simple' || v.t === 'bulk') return v.v;
  if (v.t === 'int') return v.v;
  if (v.t === 'null' || v.t === 'nullarr') return null;
  if (v.t === 'arr') return v.v.map(expectedOf);
  return undefined;
}
function randomReply(depth = 0) {
  const kinds = depth < 2 ? ['simple', 'error', 'int', 'bulk', 'null', 'arr', 'nullarr'] : ['simple', 'int', 'bulk', 'null'];
  const t = pick(kinds);
  if (t === 'simple') return { t, v: randomText(8).replace(/[\r\n]/g, '') };
  if (t === 'error') return { t, v: 'ERR ' + randomText(6).replace(/[\r\n]/g, '') };
  if (t === 'int') return { t, v: ri(-1e6, 1e6) };
  if (t === 'bulk') return { t, v: randomText(20) };
  if (t === 'arr') return { t, v: Array.from({ length: ri(0, 4) }, () => { let r; do r = randomReply(depth + 1); while (r.t === 'error'); return r; }) };
  return { t };
}
// 클라이언트가 보낸 명령(RESP 배열)을 읽는 독립 디코더
function decodeCommands(buf) {
  const out = [];
  let off = 0;
  for (;;) {
    if (off >= buf.length) break;
    const e = buf.indexOf('\r\n', off);
    if (e < 0) break;
    const n = Number(buf.toString('utf8', off + 1, e));
    let p = e + 2;
    const args = [];
    let complete = true;
    for (let i = 0; i < n; i++) {
      const e2 = buf.indexOf('\r\n', p);
      if (e2 < 0) { complete = false; break; }
      const len = Number(buf.toString('utf8', p + 1, e2));
      if (buf.length < e2 + 2 + len + 2) { complete = false; break; }
      args.push(buf.toString('utf8', e2 + 2, e2 + 2 + len));
      p = e2 + 2 + len + 2;
    }
    if (!complete) break;
    out.push(args);
    off = p;
  }
  return { cmds: out, rest: buf.subarray(off) };
}

// ---------- A. RESP 클라이언트 왕복 (100) ----------
describe('A. RESP 클라이언트: 명령 인코딩 · 응답 파싱 · 파이프라이닝 · 조각난 응답', () => {
  let server, port, client;
  const queue = []; // 서버가 다음에 돌려줄 응답들 (보낸 순서)
  const received = [];
  before(async () => {
    server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("error", () => {}); // 테스트 종료 때 끊기는 연결은 무시
      sock.on('data', async (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { cmds, rest } = decodeCommands(buf);
        buf = rest;
        for (const c of cmds) {
          received.push(c);
          const bytes = Buffer.from(encodeReply(queue.shift()));
          // 응답을 1~5조각으로 무작위로 쪼개 따로 보낸다 (경계가 토큰 한가운데 걸리게)
          let i = 0;
          while (i < bytes.length) {
            const n = Math.max(1, Math.min(bytes.length - i, ri(1, Math.ceil(bytes.length / 2) + 1)));
            sock.write(bytes.subarray(i, i + n));
            i += n;
            await new Promise((r) => setImmediate(r));
          }
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    client = new RespClient({ host: '127.0.0.1', port });
  });
  after(() => { client?.close(); server?.close(); });

  // 10 묶음 × 10 케이스: 같은 묶음은 동시에 보내서 파이프라이닝 순서도 검사
  for (let batch = 0; batch < 10; batch++) {
    const cases = Array.from({ length: 10 }, () => ({ args: Array.from({ length: ri(1, 4) }, () => randomText(10)), reply: randomReply() }));
    test(`묶음 ${batch + 1}: 10개 명령 동시 전송 → 순서대로 맞는 응답`, async () => {
      const start = received.length;
      for (const c of cases) queue.push(c.reply);
      const results = await Promise.allSettled(cases.map((c) => client.command(...c.args)));
      assert.deepEqual(received.slice(start), cases.map((c) => c.args), '서버가 받은 인자 (UTF-8 길이 포함)');
      results.forEach((r, i) => {
        const want = cases[i].reply;
        if (want.t === 'error') {
          assert.equal(r.status, 'rejected', `케이스 ${i}: 에러 응답은 reject`);
          assert.equal(r.reason.message, want.v);
        } else {
          assert.equal(r.status, 'fulfilled', `케이스 ${i}: ${r.reason?.message}`);
          assert.deepEqual(r.value, expectedOf(want), `케이스 ${i}`);
        }
      });
    });
  }
  for (let i = 0; i < 90; i++) {
    const args = Array.from({ length: ri(1, 5) }, () => randomText(16));
    const reply = randomReply();
    test(`단건 ${i + 1}: ${reply.t} 응답`, async () => {
      queue.push(reply);
      const start = received.length;
      const r = await client.command(...args).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      assert.deepEqual(received[start], args);
      if (reply.t === 'error') { assert.equal(r.ok, false); assert.equal(r.e.message, reply.v); }
      else { assert.equal(r.ok, true, r.e?.message); assert.deepEqual(r.v, expectedOf(reply)); }
    });
  }
});

// ---------- B. check.js 신뢰도 (60) ----------
describe('B. check.js: 무작위 회차 → 독립 계산과 같은 신뢰도', () => {
  for (let i = 0; i < 60; i++) {
    const keys = Array.from({ length: ri(0, 6) }, (_, k) => `E${ri(1, 4)}_k${k}_vu50`);
    const runs = [];
    for (const key of keys) {
      const base = rf(5, 20000);
      for (let r = 1, n = ri(1, 5); r <= n; r++) {
        const bad = rand() < 0.08;
        runs.push({ key, file: `${key}_r${r}.json`, rps: bad && rand() < 0.5 ? 0 : base * rf(0.7, 1.3), errorRate: bad ? rf(0.011, 0.5) : rf(0, 0.009) });
      }
    }
    test(`케이스 ${i + 1}: 조건 ${keys.length}개 · 회차 ${runs.length}개`, () => {
      const dir = tempDir('exp-check-');
      mkdirSync(join(dir, 'results', 'raw'), { recursive: true });
      copyFileSync(join(EXP, 'check.js'), join(dir, 'check.js'));
      for (const r of runs) writeFileSync(join(dir, 'results', 'raw', r.file), JSON.stringify({ rps: r.rps, errorRate: r.errorRate }));
      const out = spawnSync(process.execPath, [join(dir, 'check.js')], { encoding: 'utf8' }).stdout.trim();
      // 독립 계산
      const ok = runs.filter((r) => r.rps > 0 && r.errorRate < 0.01);
      const by = {};
      for (const r of ok) (by[r.key] ??= []).push(r.rps);
      let inBand = 0, counted = 0;
      for (const xs of Object.values(by)) if (xs.length >= 2) { const m = median(xs); for (const x of xs) { counted++; if (Math.abs((x - m) / m) <= 0.15) inBand++; } }
      if (!runs.length || !counted) {
        assert.match(out, /^RELIABILITY=N\/A/, '데이터가 부족하면 100% 가 아니라 N/A');
        return;
      }
      const want = Math.min(ok.length / runs.length, inBand / counted) * 100;
      const got = Number(out.match(/^RELIABILITY=([\d.]+)%/)?.[1]);
      assert.ok(Math.abs(got - want) <= 0.05 + 1e-9, `출력 ${out} · 기대 ${want.toFixed(2)}%`);
      assert.match(out, new RegExp(`\\(${inBand}/${counted}\\)`));
    });
  }
});

// ---------- C. analyze.js 통계 · 공식 (50) ----------
describe('C. analyze.js: 정답을 아는 합성 데이터로 통계 · 공식 · 손익분기 검사', () => {
  const HITS2 = [0, 0.5, 0.8, 0.9, 0.95, 0.99, 1];
  const HITS1 = [0, 0.5, 0.9, 0.99, 1];
  const HITS3 = [0, 0.9, 1];
  for (let i = 0; i < 50; i++) {
    const reps = ri(2, 7);
    const noise = i % 2 === 0 ? 0 : rf(0.001, 0.03); // 짝수 케이스는 잡음 0 → 공식 오차가 정확히 0 이어야 함
    const Xdb = rf(5, 60), Xc = { mini: rf(2000, 6000), redis: rf(8000, 30000) };
    const Tm = rf(30, 150), Th = { mini: rf(0.3, 1), redis: rf(0.1, 0.5) };
    const e3 = { none: rf(3000, 6000) };
    for (const b of ['mini', 'redis']) { const s = [rf(0.3, 1.1), rf(0.5, 3), rf(0.8, 4.5)].sort((a, z) => a - z); e3[b] = s.map((x) => x * e3.none); }
    test(`케이스 ${i + 1}: 반복 ${reps}회 · 잡음 ±${(noise * 100).toFixed(1)}%`, () => {
      const dir = tempDir('exp-analyze-');
      const raw = join(dir, 'results', 'raw');
      mkdirSync(raw, { recursive: true });
      for (const f of ['analyze.js', 'charts.js']) copyFileSync(join(EXP, f), join(dir, f));
      writeFileSync(join(dir, 'results', 'env.json'), JSON.stringify({ measuredAt: 'test', host: { cpu: 'test' }, docker: { version: 'test' }, method: { reps, durationSec: 10 } }));
      const truth = {}; // key → 회차별 rps
      const put = (exp, b, origin, h, vus, rpsOf, avgOf, extra = {}) => {
        const key = extra.WORKLOAD ? `${exp}_${b}_${origin}_ycsb${extra.WORKLOAD}_vu${vus}` : `${exp}_${b}_${origin}_h${h}_vu${vus}`;
        truth[key] = [];
        for (let r = 1; r <= reps; r++) {
          const jit = () => 1 + rf(-noise, noise);
          const rps = rpsOf() * jit();
          truth[key].push(rps);
          const avg = avgOf() * jit();
          writeFileSync(join(raw, `${key}_r${r}.json`), JSON.stringify({
            params: { BACKEND: b, ORIGIN: origin, MODE: extra.WORKLOAD ? 'ycsb' : 'hit', HIT: extra.WORKLOAD ? null : h, WORKLOAD: extra.WORKLOAD ?? null, VUS: vus },
            rps, lat: { avg, med: avg, 'p(95)': avg * 2, 'p(99)': avg * 3, min: avg / 2, max: avg * 4, count: 100 },
            hitRate: b === 'none' ? null : (extra.hit ?? h), errorRate: 0,
          }));
        }
      };
      put('E1', 'none', 'scan', 0, 1, () => 1000 / Tm, () => Tm);
      for (const b of ['mini', 'redis']) for (const h of HITS1) put('E1', b, 'scan', h, 1, () => 1000 / (h * Th[b] + (1 - h) * Tm), () => h * Th[b] + (1 - h) * Tm);
      put('E2', 'none', 'scan', 0, 50, () => Xdb, () => 50000 / Xdb);
      for (const b of ['mini', 'redis']) for (const h of HITS2) { const x = Math.min(h >= 1 ? Infinity : Xdb / (1 - h), Xc[b]); put('E2', b, 'scan', h, 50, () => x, () => 50000 / x); }
      put('E3', 'none', 'index', 0, 50, () => e3.none, () => 10);
      for (const b of ['mini', 'redis']) HITS3.forEach((h, k) => put('E3', b, 'index', h, 50, () => e3[b][k], () => 10));
      for (const b of ['none', 'mini', 'redis']) for (const w of ['A', 'B', 'C']) put('E4', b, 'index', null, 50, () => rf(1000, 9000), () => 5, { WORKLOAD: w, hit: rf(0.3, 0.9) });

      const res = spawnSync(process.execPath, [join(dir, 'analyze.js')], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      const s = JSON.parse(readFileSync(join(dir, 'results', 'summary.json'), 'utf8'));
      assert.equal(s.conditions.length, Object.keys(truth).length, '조건 개수');
      // 1) 조건마다 중앙값 · 95% 신뢰구간이 독립 계산과 같은지
      for (const c of s.conditions) {
        assert.ok(close(c.rps.median, median(truth[c.key])), `${c.key} 중앙값`);
        assert.ok(close(c.rps.ci95, ci95(truth[c.key]), 1e-6), `${c.key} 신뢰구간 ${c.rps.ci95} vs ${ci95(truth[c.key])}`);
        assert.equal(c.rps.n, reps);
      }
      // 2) 캐시 없음 대비 배율
      const none2 = median(truth['E2_none_scan_h0_vu50']);
      for (const c of s.conditions.filter((x) => x.exp === 'E2' && x.BACKEND !== 'none')) assert.ok(close(c.speedupRps, c.rps.median / none2), `${c.key} 배율`);
      // 3) 공식: 잡음이 0 이면 오차가 0, 잡음이 있으면 잡음 크기에 비례하는 범위 안
      for (const m of [...s.models.E1, ...s.models.E2]) {
        const lim = noise === 0 ? 1e-7 : 100 * (6 * noise + 1e-9);
        assert.ok(Math.abs(m.errorPct) <= lim, `${m.backend} h=${m.hitNominal} 공식 오차 ${m.errorPct}% (허용 ${lim}%)`);
      }
      assert.equal(s.models.E1.length, 10);
      assert.equal(s.models.E2.length, 14);
      // 4) 손익분기 (독립 계산: 0% 가 이미 같거나 빠르거나 신뢰구간이 겹치면 0, 100% 도 느리면 null, 아니면 선형 보간)
      const n3 = truth['E3_none_index_h0_vu50'];
      for (const b of ['mini', 'redis']) {
        const ys = HITS3.map((h) => truth[`E3_${b}_index_h${h}_vu50`]);
        const target = median(n3), m = ys.map(median);
        let want;
        if (m[0] >= target || target - m[0] <= ci95(ys[0]) + ci95(n3)) want = 0;
        else if (m[2] < target) want = null;
        else { const k = m[1] >= target ? 1 : 2; want = HITS3[k - 1] + (HITS3[k] - HITS3[k - 1]) * (target - m[k - 1]) / (m[k] - m[k - 1]); }
        if (want == null) assert.equal(s.breakEven[b], null, `${b} 손익분기`);
        else assert.ok(close(s.breakEven[b], want, 1e-6), `${b} 손익분기 ${s.breakEven[b]} vs ${want}`);
      }
      // 5) 그래프 4개가 만들어지고 NaN · undefined 가 없는지
      for (const f of ['e1-latency.svg', 'e2-throughput.svg', 'e3-light-query.svg', 'e4-ycsb.svg']) {
        const svg = readFileSync(join(dir, 'results', f), 'utf8');
        assert.ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'), f);
        assert.doesNotMatch(svg, /NaN|undefined|Infinity/, f);
      }
    });
  }
});

// ---------- D. charts.js SVG (40) ----------
function checkSvg(svg, label) {
  const [, W, H] = svg.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/, `${label}: 숫자가 아닌 좌표`);
  // 좌표 속성이 그림(viewBox) 안에 있는지
  for (const m of svg.matchAll(/\b(x|x1|x2|cx)="(-?[\d.]+)"/g)) assert.ok(+m[2] >= -0.5 && +m[2] <= W + 0.5, `${label}: ${m[1]}=${m[2]} 가 0~${W} 밖`);
  for (const m of svg.matchAll(/\b(y|y1|y2|cy)="(-?[\d.]+)"/g)) assert.ok(+m[2] >= -0.5 && +m[2] <= H + 0.5, `${label}: ${m[1]}=${m[2]} 가 0~${H} 밖`);
  for (const m of svg.matchAll(/points="([^"]*)"/g)) for (const p of m[1].trim().split(/\s+/)) { const [x, y] = p.split(',').map(Number); assert.ok(x >= -0.5 && x <= W + 0.5 && y >= -0.5 && y <= H + 0.5, `${label}: 꺾은선 점 ${p} 가 그림 밖`); }
  for (const m of svg.matchAll(/\bheight="(-?[\d.]+)"/g)) assert.ok(+m[1] >= 0, `${label}: 음수 높이 ${m[1]}`);
  // 태그 짝 맞추기
  const stack = [];
  for (const m of svg.matchAll(/<(\/?)([a-z]+)\b[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${label}: 닫는 태그 </${m[2]}> 짝이 안 맞음`);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, `${label}: 닫히지 않은 태그 ${stack}`);
}
describe('D. charts.js: 무작위 입력 → 올바른 SVG', () => {
  for (let i = 0; i < 20; i++) {
    const logY = rand() < 0.5;
    const series = ['mini', 'redis'].slice(0, ri(1, 2)).map((key) => ({
      key, color: '#123456',
      points: Array.from({ length: ri(1, 7) }, () => { const y = rf(0.05, 50000); return { h: rand(), y, ci: rand() < 0.3 ? 0 : rf(0, y * 1.5) }; }).sort((a, z) => a.h - z.h),
      model: Array.from({ length: ri(0, 6) }, () => ({ h: rand(), y: rf(0.05, 50000) })).sort((a, z) => a.h - z.h),
    }));
    test(`꺾은선 ${i + 1}: ${logY ? '로그' : '선형'} · 시리즈 ${series.length}개`, () => {
      const svg = renderHitChart({ title: `제목 <b>&${i}`, subtitle: 'a < b & c', yLabel: 'y<', series, baseline: rand() < 0.5 ? { y: rf(0.1, 1000), label: '기준<' } : null, logY, legendItems: [['a<', '#000'], ['b', '#111', true]] });
      checkSvg(svg, `꺾은선 ${i + 1}`);
      assert.match(svg, /제목 &lt;b>&amp;/, '제목의 < & 는 이스케이프');
    });
  }
  for (let i = 0; i < 20; i++) {
    const groups = Array.from({ length: ri(1, 4) }, (_, g) => ({ label: `그룹<${g}`, bars: ['none', 'mini', 'redis'].slice(0, ri(1, 3)).map((key) => { const y = rf(1, 30000); return { key, y, ci: rand() < 0.3 ? 0 : rf(0, y * 1.5) }; }) }));
    test(`막대 ${i + 1}: 그룹 ${groups.length}개`, () => {
      const svg = renderBarChart({ title: `막대 & ${i}`, subtitle: 's', yLabel: 'req/s', groups });
      checkSvg(svg, `막대 ${i + 1}`);
      const ticks = [...svg.matchAll(/text-anchor="end">([^<]+)</g)].map((m) => m[1]);
      assert.equal(ticks[0], '0', '세로축이 0 에서 시작');
      // 막대와 오차 막대는 값 0 인 가로축(첫 격자선) 아래로 내려가면 안 된다
      const axisY = Number(svg.match(/<line x1="[\d.]+" y1="([\d.]+)"/)[1]);
      for (const m of svg.matchAll(/<line [^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/g)) assert.ok(+m[1] <= axisY + 0.5 && +m[2] <= axisY + 0.5, `선이 0 아래로: y=${m[1]}~${m[2]}, 축 ${axisY}`);
      for (const m of svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)) assert.ok(+m[1] + +m[2] <= axisY + 0.5, `막대 아래끝 ${+m[1] + +m[2]} 이 축 ${axisY} 아래`);
    });
  }
});

// ---------- E. k6 Zipf · 해시 (40) ----------
describe('E. k6/cache.js 의 Zipf 생성기와 해시 섞기', () => {
  const src = readFileSync(join(EXP, 'k6', 'cache.js'), 'utf8');
  const body = src.slice(src.indexOf('const THETA'), src.indexOf('const rnd'));
  const load = (ROWS) => new Function('ROWS', 'MODE', `${body}; return { zipfRank, scramble, zetan, THETA };`)(ROWS, 'ycsb');
  for (let i = 0; i < 40; i++) {
    const ROWS = pick([2, 3, 10, 100, 1000]) * ri(1, 100) + ri(0, 9);
    test(`ROWS=${ROWS}`, () => {
      const z = load(ROWS);
      const N = 20000;
      let top = 0;
      const seenIds = new Set();
      for (let k = 0; k < N; k++) {
        const r = z.zipfRank();
        assert.ok(Number.isInteger(r) && r >= 0 && r < ROWS, `순위 ${r} 가 0~${ROWS - 1} 밖`);
        if (r === 0) top++;
        const id = z.scramble(r);
        assert.ok(Number.isInteger(id) && id >= 1 && id <= ROWS, `id ${id} 가 1~${ROWS} 밖`);
        assert.equal(z.scramble(r), id, '같은 순위는 항상 같은 id');
        seenIds.add(id);
      }
      // 1위 키가 뽑힐 이론 확률 = 1 / zeta(ROWS, θ). 이항분포 표준편차의 6배 안이면 통과
      const p = 1 / z.zetan;
      const sd = Math.sqrt(N * p * (1 - p));
      assert.ok(Math.abs(top - N * p) <= 6 * sd + 1, `1위 빈도 ${top} vs 이론 ${(N * p).toFixed(0)} ± ${(6 * sd).toFixed(0)}`);
      assert.ok(seenIds.size >= Math.min(ROWS, 2) * 0.3 || ROWS < 5, '인기 키가 한두 개 id 에 몰리지 않음');
    });
  }
});

// ---------- F. run.js 조건표 · 섞기 (20) ----------
describe('F. run.js 의 조건표와 반복 순서 섞기', () => {
  const src = readFileSync(join(EXP, 'run.js'), 'utf8');
  const body = src.slice(src.indexOf('const HITS_E1'), src.indexOf('function sh('));
  const load = (ONLY) => new Function('ONLY', `${body}; return { grid, id, shuffle };`)(ONLY);
  const PER = { E1: 11, E2: 15, E3: 7, E4: 9 };
  for (let i = 0; i < 20; i++) {
    const only = ['E1', 'E2', 'E3', 'E4'].filter(() => rand() < 0.6);
    const seed = ri(1, 50);
    test(`실험 [${only.join(',') || '없음'}] · 씨앗 ${seed}`, () => {
      const { grid, id, shuffle } = load(only);
      const g = grid();
      assert.equal(g.length, only.reduce((a, e) => a + PER[e], 0), '조건 개수');
      assert.equal(new Set(g.map(id)).size, g.length, '조건 이름(결과 파일 이름)이 겹치지 않음');
      for (const c of g) assert.ok(['none', 'mini', 'redis'].includes(c.BACKEND) && c.VUS > 0);
      const a = shuffle([...g], seed), b = shuffle([...g], seed);
      assert.deepEqual(a.map(id), b.map(id), '같은 씨앗 → 같은 순서 (재현 가능)');
      assert.deepEqual([...a.map(id)].sort(), [...g.map(id)].sort(), '섞기는 빠짐도 중복도 없는 순열');
    });
  }
});

// ---------- G. app.js 통합 (90) ----------
// 가짜 Redis: GET / SET [EX] / DEL / FLUSHALL / INFO 만 아는 RESP 서버
function startFakeRedis() {
  const store = new Map();
  const srv = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("error", () => {}); // app.js 를 끌 때 끊기는 연결은 무시
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { cmds, rest } = decodeCommands(buf);
      buf = rest;
      for (const [cmd, ...a] of cmds) {
        const c = cmd.toUpperCase();
        if (c === 'GET') sock.write(store.has(a[0]) ? encodeReply({ t: 'bulk', v: store.get(a[0]) }) : '$-1\r\n');
        else if (c === 'SET') { store.set(a[0], a[1]); sock.write('+OK\r\n'); }
        else if (c === 'DEL') { const had = store.delete(a[0]); sock.write(`:${had ? 1 : 0}\r\n`); }
        else if (c === 'FLUSHALL') { store.clear(); sock.write('+OK\r\n'); }
        else if (c === 'INFO') sock.write(encodeReply({ t: 'bulk', v: '# Server\r\nredis_version:fake-0\r\n' }));
        else sock.write(`-ERR unknown ${c}\r\n`);
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, store })));
}
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

describe('G. app.js 통합: 무작위 요청 90개 → 독립 모델과 비교', () => {
  const ROWS = 3000;
  const CATS = ['키보드', '마우스', '모니터', '케이블', '스탠드'];
  let app, base, fake, mini;
  // 모델: 캐시 키 → 저장된 응답 (backend 별로 따로), DB 행 수
  const cache = { mini: new Map(), redis: new Map() };
  let rowCount = ROWS, writes = 0;
  const writtenIds = new Map(); // INSERT 로 생긴 id → 이름
  before(async () => {
    fake = await startFakeRedis();
    mini = await startRedisServer({ port: 0, aofPath: null });
    const port = await freePort();
    const dir = tempDir('exp-app-');
    app = spawn(process.execPath, [join(EXP, 'app.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, ROWS: String(ROWS), DB_WORKERS: '2', MINI_URL: `http://127.0.0.1:${mini.port}`, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(fake.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    app.stderr.on('data', (d) => (err += d));
    base = `http://127.0.0.1:${port}`;
    for (let k = 0; k < 100; k++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* 아직 안 뜸 */ }
      await sleep(100);
    }
    throw new Error(`app.js 가 뜨지 않음: ${err}`);
  });
  after(async () => {
    if (app && app.exitCode === null) { const exited = new Promise((r) => app.once("exit", r)); app.kill(); await exited; }
    await mini?.close();
    fake?.srv.close();
  });

  const ops = [];
  ops.push({ kind: 'reset' });
  while (ops.length < 89) {
    const r = rand();
    if (r < 0.06) ops.push({ kind: 'reset' });
    else if (r < 0.30 && ops.length <= 86) {
      // 읽기(캐시 채움) → 쓰기 → 같은 키 다시 읽기: 쓰기가 캐시를 지웠다면 MISS 여야 한다
      const w = { backend: pick(['mini', 'redis', 'none']), origin: pick(['index', 'scan']), id: ri(1, 40) };
      ops.push({ kind: 'get', ...w, v: null }, { kind: 'write', ...w }, { kind: 'get', ...w, v: null });
    } else ops.push({ kind: 'get', backend: pick(['none', 'mini', 'redis', 'mini', 'redis']), origin: pick(['index', 'scan']), id: rand() < 0.1 ? ri(ROWS + 1, ROWS + 4) : rand() < 0.15 ? ri(ROWS + 5, ROWS + 50) : ri(1, 40), v: rand() < 0.2 ? String(ri(1, 3)) : null });
  }
  ops.push({ kind: 'info' });

  ops.forEach((op, i) => {
    test(`${i + 1}. ${op.kind} ${op.backend ?? ''} ${op.origin ?? ''} ${op.id ?? ''}${op.v ? ` v=${op.v}` : ''}`, async () => {
      if (op.kind === 'reset') {
        const r = await (await fetch(`${base}/admin/reset`, { method: 'POST' })).json();
        assert.equal(r.rows, ROWS, '되돌린 뒤 정확히 ROWS 건');
        cache.mini.clear(); cache.redis.clear(); rowCount = ROWS; writes = 0; writtenIds.clear();
        assert.equal(fake.store.size, 0, 'Redis 캐시도 비워짐');
        return;
      }
      if (op.kind === 'info') {
        const info = await (await fetch(`${base}/admin/info`)).json();
        assert.equal(info.rows.find((t) => t.table === 'products').rows, rowCount, '행 수 = ROWS + 쓰기 횟수');
        assert.equal(info.redisVersion, 'fake-0');
        return;
      }
      const url = `${base}/item/${op.id}?backend=${op.backend}&origin=${op.origin}${op.v ? `&v=${op.v}` : ''}`;
      const key = `item:${op.origin}:${op.id}`;
      if (op.kind === 'write') {
        const res = await fetch(url, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-cache'), 'WRITE');
        writes++; rowCount++;
        writtenIds.set(rowCount, `write ${writes}`);
        if (op.backend !== 'none') cache[op.backend].delete(key); // 쓰기는 그 키(꼬리표 없는 것)만 무효화
        return;
      }
      // GET: 독립 모델로 기대값 계산
      const truthRow = () => {
        if (op.id <= ROWS) return { id: op.id, name: `${CATS[op.id % 5]} ${op.id}`, category: CATS[op.id % 5] }; // 씨앗 행: index · scan 둘 다 찾음
        if (op.origin === 'index' && writtenIds.has(op.id)) return { id: op.id, name: writtenIds.get(op.id), category: null };
        return null; // scan 은 이름으로 찾으므로 INSERT 된 행("write n")은 못 찾음
      };
      const res = await fetch(url);
      const body = await res.json();
      const state = res.headers.get('x-cache');
      const ckey = op.v ? `${key}:${op.v}` : key;
      let want;
      if (op.backend === 'none') { assert.equal(state, 'BYPASS'); want = truthRow(); }
      else if (cache[op.backend].has(ckey)) { assert.equal(state, 'HIT', '전에 저장한 키는 HIT'); want = cache[op.backend].get(ckey); }
      else { assert.equal(state, 'MISS', '처음 보는 키는 MISS'); want = truthRow(); cache[op.backend].set(ckey, want); }
      if (want === null) { assert.equal(res.status, 404); return; }
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body[0], want.id, 'id');
      assert.equal(body[1], want.name, '이름');
      if (want.category) {
        assert.equal(body[3], want.category, '분류');
        assert.ok(Number.isInteger(body[2]) && body[2] >= 1000 && body[2] <= 300000 && body[2] % 1000 === 0, `가격 ${body[2]}`);
      }
      // 캐시를 거쳐도 원본과 같은 행인지: 같은 id 를 캐시 없이 한 번 더 조회해서 비교 (HIT 는 오래된 값일 수 있으니 MISS·BYPASS 일 때만)
      if (state !== 'HIT') {
        const direct = await (await fetch(`${base}/item/${op.id}?backend=none&origin=${op.origin}`)).json();
        assert.deepEqual(body, direct, '캐시 경로와 직접 조회가 같은 행');
      }
    });
  });
});
