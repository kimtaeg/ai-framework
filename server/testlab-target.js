// 테스트 실험실의 k6 작업이 두드리는 별도 서버: 임시 폴더의 데이터로 빈 포트에서 뜬다 (실제 week2/data 를 건드리지 않음)
//  비교 실험용 설정 (환경 변수, 정해진 값만):
//   TARGET_DB_WORKERS = 1 | 2 | 4 | 8   미니 DBMS 스레드 풀 크기
//   TARGET_FSYNC      = everysec | always | no   AOF 를 디스크에 쓰는 방식
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createWeek2 } from '../server.js';

const workers = ['1', '2', '4', '8'].includes(process.env.TARGET_DB_WORKERS) ? Number(process.env.TARGET_DB_WORKERS) : undefined;
const fsync = ['everysec', 'always', 'no'].includes(process.env.TARGET_FSYNC) ? process.env.TARGET_FSYNC : 'everysec';

const dir = mkdtempSync(join(tmpdir(), 'testlab-target-'));
const app = createApp({ week2: createWeek2(dir, { fsync, dbWorkers: workers }) });
app.listen(0, '127.0.0.1', () => {
  console.log(`TARGET_DIR=${dir}`);
  console.log(`TARGET_PORT=${app.address().port}`);
  console.log(`TARGET_CONFIG=workers:${workers ?? 'default'} fsync:${fsync}`);
});
const stop = async () => { await app.week2.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
