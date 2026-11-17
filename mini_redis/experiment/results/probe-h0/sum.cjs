// 사용: node sum.cjs  — out/*.json 을 설정 · 조건별 중앙값 표로
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'out');
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-').padStart(7);
for (const file of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'smoke.json').sort()) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  console.log(`\n== ${file.replace('.json', '')}`);
  console.log('조건          rps(중앙) 반복별                 메인% 워커%  도착시줄 대기ms 실행ms DB합ms GETms SETms 서버합ms 묶음');
  const keys = [...new Set(rows.map((r) => `${r.backend} d${r.delay}`))];
  for (const k of keys) {
    const rs = rows.filter((r) => `${r.backend} d${r.delay}` === k);
    const m = (fn) => med(rs.map((r) => { try { return fn(r.probe, r); } catch { return NaN; } }));
    console.log(k.padEnd(13), f(m((p, r) => r.rps), 0), rs.map((r) => r.rps.toFixed(0)).join(' ').padEnd(22),
      f(m((p) => p.mainElu * 100), 0), f(m((p) => (p.workerElu[0] + p.workerElu[1]) * 50), 0),
      f(m((p) => p.qAtArrive / p.n), 1), f(m((p) => p.waited / p.n)), f(m((p) => p.exec / p.n)), f(m((p) => p.db / p.n)),
      f(m((p) => p.cacheGet / p.n)), f(m((p) => p.cacheSet / p.n)), f(m((p) => p.total / p.reqs)), f(m((p) => p.n / p.posts), 1));
  }
}
