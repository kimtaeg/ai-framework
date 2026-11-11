/**
 * diff 가 어디에 시간을 쓰는지 (CPU 프로파일)
 *   node move/bench/profile.js v1   → 할당 제거 전 (diff-v1.js)
 *   node move/bench/profile.js v2   → 지금 (src/lib/diff.js)
 *  1만 줄을 바뀐 것 없이 다시 그리는 diff 를 4초 동안 반복하고, 함수별 자기 시간(self time) 비율을 출력한다.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ver = process.argv[2] === 'v1' ? 'v1' : 'v2';
if (process.argv[3] === '--target') {
  const { h } = await import('../../src/lib/index.js');
  const { diff } = await import(ver === 'v1' ? './diff-v1.js' : '../../src/lib/diff.js');
  const row = (it) => h('li', { key: it.id, class: 'row' }, h('span', { class: 'sw', style: { background: `hsl(${it.id % 360} 60% 50%)` } }), h('span', { class: 'id' }, `#${it.id}`), h('span', { class: 'label' }, it.label), h('input', { placeholder: '메모', value: '' }), h('button', { onClick: () => {} }, '삭제'));
  const items = Array.from({ length: 10000 }, (_, i) => ({ id: i, label: `항목 ${i}` }));
  const a = h('ul', null, items.map(row)), b = h('ul', null, items.map(row));
  const t = performance.now();
  while (performance.now() - t < 4000) diff(a, b);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'diff-prof-'));
  spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${dir}`, fileURLToPath(import.meta.url), ver, '--target'], { stdio: 'inherit' });
  const p = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.cpuprofile'))), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  const time = {};
  p.samples.forEach((id, i) => { time[id] = (time[id] || 0) + (p.timeDeltas[i] || 0); });
  const self = {};
  for (const n of p.nodes) {
    const { functionName, url, lineNumber } = n.callFrame;
    const file = (url || '').split('/').pop();
    const key = `${functionName || '(익명)'}${file ? ` ${file}:${lineNumber + 1}` : ''}`;
    self[key] = (self[key] || 0) + (time[n.id] || 0);
  }
  const total = Object.values(self).reduce((a, b) => a + b, 0);
  console.log(`diff ${ver} · 1만 줄 바뀐 것 없이 다시 그리기 · 함수별 자기 시간`);
  for (const [k, v] of Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
