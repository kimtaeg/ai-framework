import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const REMOTE_DIR = join(HERE, 'results-remote');
const LOCAL_SUMMARY_FILE = join(RESULTS, 'summary.json');
const LOCAL_ENV_FILE = join(RESULTS, 'env.json');

if (!existsSync(REMOTE_DIR)) {
  mkdirSync(REMOTE_DIR, { recursive: true });
}

if (!existsSync(LOCAL_SUMMARY_FILE)) {
  console.error('\n❌ 로컬 벤치마크 결과(results/summary.json)가 없습니다.');
  console.error('먼저 벤치마크를 실행해 주세요:');
  console.error('  node experiment/run.js && node experiment/analyze.js\n');
  process.exit(1);
}

const localEnv = existsSync(LOCAL_ENV_FILE) ? JSON.parse(readFileSync(LOCAL_ENV_FILE, 'utf8')) : {};
const localSummary = JSON.parse(readFileSync(LOCAL_SUMMARY_FILE, 'utf8'));

// 대상 원격 파일 탐색
let remotePath = process.argv[2];
if (!remotePath) {
  const remoteFiles = readdirSync(REMOTE_DIR).filter((f) => f.endsWith('.json'));
  if (remoteFiles.length > 0) {
    remotePath = join(REMOTE_DIR, remoteFiles[0]);
  } else {
    // 혹시 results/ 안에 export된 다른 파일이 있는지 탐색
    const exportedFiles = readdirSync(RESULTS).filter((f) => f.startsWith('benchmark-export-') && f.endsWith('.json'));
    if (exportedFiles.length > 0) {
      remotePath = join(RESULTS, exportedFiles[0]);
    }
  }
}

if (!remotePath || !existsSync(remotePath)) {
  console.log('\n=============================================================');
  console.log('ℹ️ 팀원의 벤치마크 데이터 파일이 아직 등록되지 않았습니다.');
  console.log('-------------------------------------------------------------');
  console.log('[팀원 데이터를 가져오는 방법]');
  console.log('1. 팀원 PC에서 다음 명령어를 실행하여 결과를 내보냅니다:');
  console.log('   npm run bench:export');
  console.log('2. 생성된 "benchmark-export-*.json" 파일을 받아 아래 폴더에 넣으세요:');
  console.log(`   ${REMOTE_DIR}`);
  console.log('3. 다시 아래 명령어를 실행하면 두 머신 간 비교 보고서가 생성됩니다:');
  console.log('   npm run bench:compare');
  console.log('=============================================================\n');
  process.exit(0);
}

const remoteData = JSON.parse(readFileSync(remotePath, 'utf8'));

const hostA = {
  name: '내 PC (Host A)',
  cpu: localEnv.host?.cpu || localSummary.env?.host?.cpu || 'Unknown CPU',
  cores: localEnv.host?.logicalCores || localSummary.env?.host?.logicalCores || '-',
  mem: localEnv.host?.memGB || localSummary.env?.host?.memGB || '-',
  os: localEnv.host?.os || localSummary.env?.host?.os || '-'
};

const hostB = {
  name: `팀원 PC (Host B: ${remoteData.hostId || 'Remote'})`,
  cpu: remoteData.host?.cpu || 'Unknown CPU',
  cores: remoteData.host?.logicalCores || '-',
  mem: remoteData.host?.memGB || '-',
  os: remoteData.host?.os || '-'
};

const localConds = localSummary.conditions || [];
const remoteConds = remoteData.conditions || [];

const findCond = (conds, exp, backend, extra = {}) => {
  return conds.find((c) =>
    c.exp === exp &&
    c.BACKEND === backend &&
    Object.entries(extra).every(([k, v]) => c[k] === v)
  );
};

// 같은 컴퓨터끼리 비교하면 '다른 머신에서 재현됐다' 는 근거가 될 수 없다
const localHostId = (hostname() || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
const sameName = !!remoteData.hostId && remoteData.hostId === localHostId;
const sameSpec = hostA.cpu === hostB.cpu && hostA.cores === hostB.cores && hostA.mem === hostB.mem && hostA.os === hostB.os;
const sameHost = sameName || sameSpec;

// 판정 기준: 두 머신의 '캐시 없음 대비 배율' 차이가 ±TOL 안이면 같은 결과로 본다
const TOL = 0.15;
const near = (a, b) => a > 0 && b > 0 && Math.abs(b - a) / a <= TOL;
const pct = (a, b) => `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`;
const verdict = (v) => (v == null ? '판정 불가 (데이터 없음)' : v ? '재현됨' : '재현 안 됨');

// 비교 분석 마크다운 생성
let report = '';
report += `# 💻 두 머신 간 벤치마크 재현성 비교 보고서\n\n`;
report += `> 같은 벤치마크 스크립트를 두 컴퓨터에서 실행한 실측 데이터를 나란히 놓고, 캐시 없음 대비 배율의 차이가 ±${TOL * 100}% 안인지로 재현 여부를 판정합니다.\n\n`;
if (sameHost) {
  const why = sameName ? `호스트 이름 ${remoteData.hostId} 가 같음` : 'CPU · 코어 · 메모리 · OS 가 모두 같음';
  report += `> ⚠️ **같은 컴퓨터끼리 비교한 결과입니다** (${why}).\n`;
  report += `> 같은 컴퓨터에서 다시 잰 반복 측정일 뿐, **다른 머신에서 재현됐다는 근거로 쓸 수 없습니다.** 팀원 PC 에서 \`npm run bench:export\` 로 만든 파일을 넣어 주세요.\n\n`;
}

report += `## 1. 측정 환경 (하드웨어 스펙 비교)\n\n`;
report += `| 항목 | ${hostA.name} | ${hostB.name} |\n`;
report += `| :--- | :--- | :--- |\n`;
report += `| **CPU 모델** | ${hostA.cpu} | ${hostB.cpu} |\n`;
report += `| **논리 코어 수** | ${hostA.cores} 코어 | ${hostB.cores} 코어 |\n`;
report += `| **메모리(RAM)** | ${hostA.mem} GB | ${hostB.mem} GB |\n`;
report += `| **운영체제** | ${hostA.os} | ${hostB.os} |\n\n`;

report += `## 2. 발견 1 · 무거운 쿼리: 히트율과 처리량 배율 $X_{db} \\div (1 - h)$\n\n`;
report += `| 히트율 | 이론 공식 | ${hostA.name} (미니 레디스 / Redis 7) | ${hostB.name} (미니 레디스 / Redis 7) | 배율 차이 (미니 / Redis) |\n`;
report += `| :---: | :---: | :--- | :--- | :---: |\n`;
const e2 = []; // 두 머신 모두 값이 있는 (캐시, 히트율) 쌍의 판정

for (const h of [0, 0.5, 0.9, 0.95, 0.99, 1]) {
  const lMini = findCond(localConds, 'E2', 'mini', { HIT: h });
  const lRedis = findCond(localConds, 'E2', 'redis', { HIT: h });
  const rMini = findCond(remoteConds, 'E2', 'mini', { HIT: h });
  const rRedis = findCond(remoteConds, 'E2', 'redis', { HIT: h });

  const pred = h === 1 ? '캐시 한계' : (1 / (1 - h)).toFixed(1) + '배';
  const lStr = `${lMini?.speedupRps ? lMini.speedupRps.toFixed(1) + '배 (' + Math.round(lMini.rps?.median || 0) + '/s)' : '-'} / ${lRedis?.speedupRps ? lRedis.speedupRps.toFixed(1) + '배 (' + Math.round(lRedis.rps?.median || 0) + '/s)' : '-'}`;
  const rStr = `${rMini?.speedupRps ? rMini.speedupRps.toFixed(1) + '배 (' + Math.round(rMini.rps?.median || 0) + '/s)' : '-'} / ${rRedis?.speedupRps ? rRedis.speedupRps.toFixed(1) + '배 (' + Math.round(rRedis.rps?.median || 0) + '/s)' : '-'}`;

  // 히트율 0% 는 정의상 둘 다 1배라 판정에서 뺀다
  const diff = [[lMini, rMini], [lRedis, rRedis]].map(([l, r]) => {
    if (!l?.speedupRps || !r?.speedupRps || h === 0) return '-';
    const ok = near(l.speedupRps, r.speedupRps);
    e2.push(ok);
    return `${pct(l.speedupRps, r.speedupRps)}${ok ? '' : ' ✗'}`;
  }).join(' / ');
  report += `| **${Math.round(h * 100)}%** | ${pred} | ${lStr} | ${rStr} | ${diff} |\n`;
}

const e2Ok = e2.filter(Boolean).length;
const finding1 = e2.length ? e2Ok === e2.length : null;
if (finding1 == null) report += `\n- **검증 결론**: 두 머신 모두에 있는 E2 조건이 없어 판정할 수 없습니다.\n\n`;
else if (finding1) report += `\n- **검증 결론**: 절대 처리량(req/s)은 다를 수 있지만, 캐시 없음 대비 배율은 ${e2.length}개 조건 모두 ±${TOL * 100}% 안에서 같았습니다 → **발견 1 재현됨.**\n\n`;
else report += `\n- **검증 결론**: 캐시 없음 대비 배율이 ±${TOL * 100}% 안에서 같은 조건은 ${e2Ok}/${e2.length}개뿐입니다 (✗ 표시) → **발견 1 은 재현되지 않았습니다.** 두 머신에서 병목이 다를 수 있습니다 (DB 가 병목이 아닌 경우 등).\n\n`;

report += `## 3. 발견 2 · 가벼운 쿼리: 미니 레디스의 역전 손해 (0.92배 재현 여부)\n\n`;
report += `| 캐시 구분 | 히트율 | ${hostA.name} 배율 (캐시 없음 대비) | ${hostB.name} 배율 (캐시 없음 대비) |\n`;
report += `| :--- | :---: | :---: | :---: |\n`;

for (const h of [0, 0.9, 1.0]) {
  const lMini = findCond(localConds, 'E3', 'mini', { HIT: h });
  const rMini = findCond(remoteConds, 'E3', 'mini', { HIT: h });
  const lVal = lMini?.speedupRps ? `${lMini.speedupRps.toFixed(2)}배 (${Math.round(lMini.rps?.median || 0)}/s)` : '-';
  const rVal = rMini?.speedupRps ? `${rMini.speedupRps.toFixed(2)}배 (${Math.round(rMini.rps?.median || 0)}/s)` : '-';
  report += `| **미니 레디스 (자체 제작)** | ${Math.round(h * 100)}% | ${lVal} | ${rVal} |\n`;
}

for (const h of [0, 0.9, 1.0]) {
  const lRedis = findCond(localConds, 'E3', 'redis', { HIT: h });
  const rRedis = findCond(remoteConds, 'E3', 'redis', { HIT: h });
  const lVal = lRedis?.speedupRps ? `${lRedis.speedupRps.toFixed(2)}배 (${Math.round(lRedis.rps?.median || 0)}/s)` : '-';
  const rVal = rRedis?.speedupRps ? `${rRedis.speedupRps.toFixed(2)}배 (${Math.round(rRedis.rps?.median || 0)}/s)` : '-';
  report += `| **Redis 7.4 (실제 엔진)** | ${Math.round(h * 100)}% | ${lVal} | ${rVal} |\n`;
}

const lE3 = findCond(localConds, 'E3', 'mini', { HIT: 1 })?.speedupRps;
const rE3 = findCond(remoteConds, 'E3', 'mini', { HIT: 1 })?.speedupRps;
const finding2 = lE3 == null || rE3 == null ? null : lE3 < 1 && rE3 < 1;
if (finding2 == null) report += `\n- **검증 결론**: 두 머신 모두에 E3 미니 레디스 히트율 100% 결과가 있어야 판정할 수 있습니다.\n\n`;
else if (finding2) report += `\n- **검증 결론**: 미니 레디스는 히트율 100% 에서도 캐시 없음보다 느렸습니다 (${lE3.toFixed(2)}배 / ${rE3.toFixed(2)}배) → **발견 2 재현됨.** 가벼운 쿼리 앞에서는 HTTP · JSON 비용이 DB 조회보다 큽니다.\n\n`;
else report += `\n- **검증 결론**: 미니 레디스 히트율 100% 배율이 ${lE3.toFixed(2)}배 / ${rE3.toFixed(2)}배로, 두 머신 모두 1배 미만은 아닙니다 → **발견 2 는 재현되지 않았습니다.**\n\n`;

report += `## 4. 최종 종합 평가\n\n`;
report += `| 발견 | 판정 |\n| :--- | :--- |\n`;
report += `| 1. 무거운 쿼리: 배율 ≈ 1 ÷ (1 − h) | ${verdict(finding1)} |\n`;
report += `| 2. 가벼운 쿼리: 미니 레디스가 손해 | ${verdict(finding2)} |\n\n`;
if (sameHost) report += `> ⚠️ 같은 컴퓨터끼리 비교했으므로, 위 판정은 **반복 측정이 안정적인지**만 보여 줍니다. 다른 머신에서의 재현 근거가 아닙니다.\n`;
else if (finding1 && finding2) report += `> 두 발견 모두 사양이 다른 두 머신에서 같은 결론이 나왔습니다 (배율 차이 ±${TOL * 100}% 기준). 두 대의 결과이므로, 더 많은 머신에서 확인하면 근거가 더 강해집니다.\n`;
else report += `> 재현되지 않았거나 판정할 수 없는 발견이 있습니다. 그 발견은 측정한 머신 환경에 한정해서 말해야 합니다.\n`;

const outMd = join(RESULTS, 'cross-host-comparison.md');
writeFileSync(outMd, report, 'utf8');

console.log('\n=============================================================');
console.log('🎉 두 머신 간 비교 보고서가 성공적으로 생성되었습니다!');
console.log(`📄 보고서 파일: ${outMd}`);
console.log('-------------------------------------------------------------');
console.log(`[Host A] ${hostA.name}: ${hostA.cpu} (${hostA.cores} 코어)`);
console.log(`[Host B] ${hostB.name}: ${hostB.cpu} (${hostB.cores} 코어)`);
console.log('-------------------------------------------------------------');
if (sameHost) console.log('⚠️ 같은 컴퓨터끼리 비교했습니다 — 다른 머신에서의 재현 근거로 쓸 수 없습니다.');
console.log(`판정: 발견 1 ${verdict(finding1)} · 발견 2 ${verdict(finding2)}`);
console.log('=============================================================\n');
