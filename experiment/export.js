import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const ENV_FILE = join(RESULTS, 'env.json');
const SUMMARY_FILE = join(RESULTS, 'summary.json');

if (!existsSync(SUMMARY_FILE) || !existsSync(ENV_FILE)) {
  console.error('\n❌ 벤치마크 결과 파일이 없습니다!');
  console.error('먼저 벤치마크를 실행하고 분석해 주세요:');
  console.error('  node experiment/run.js');
  console.error('  node experiment/analyze.js\n');
  process.exit(1);
}

const env = JSON.parse(readFileSync(ENV_FILE, 'utf8'));
const summary = JSON.parse(readFileSync(SUMMARY_FILE, 'utf8'));

const hostClean = (hostname() || 'teammate')
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '_');

const exportData = {
  exportedAt: new Date().toISOString(),
  hostId: hostClean,
  host: env.host,
  docker: env.docker,
  versions: env.versions,
  method: env.method,
  conditions: summary.conditions || [],
  models: summary.models || {},
  breakEven: summary.breakEven || {},
  driftCheck: summary.driftCheck || {},
  maxCvPct: summary.maxCvPct || 0
};

const outFile = join(RESULTS, `benchmark-export-${hostClean}.json`);
writeFileSync(outFile, JSON.stringify(exportData, null, 2), 'utf8');

console.log('\n=============================================================');
console.log('✅ 벤치마크 결과가 단일 파일로 성공적으로 내보내졌습니다!');
console.log(`📁 생성된 파일: ${outFile}`);
console.log('-------------------------------------------------------------');
console.log('[전달 및 비교 방법]');
console.log('1. 위 JSON 파일을 카카오톡, 슬랙, 구글드라이브 등으로 전달하세요.');
console.log('2. 데이터를 받을 PC의 "experiment/results-remote/" 폴더에 넣으세요.');
console.log('3. 받는 PC에서 다음 명령어를 실행하면 두 머신 간 비교 보고서가 자동 생성됩니다:');
console.log('   npm run bench:compare');
console.log('=============================================================\n');
