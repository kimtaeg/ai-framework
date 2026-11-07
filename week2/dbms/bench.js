/**
 * Phase 2 성능 비교: 100만 건 INSERT 후 "id 로 찾기(B+ 트리)" vs "email 로 찾기(선형 탐색)"
 *
 *   node week2/dbms/bench.js [--rows 1000000] [--queries 200] [--keep]
 *
 *  임시 폴더에 새 데이터베이스를 만들어 측정한다 (week2/data 의 실제 데이터는 건드리지 않음).
 *  --keep 을 주면 끝난 뒤에도 임시 폴더를 남긴다.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './engine.js';
import { FileStorage } from './storage-file.js';
import { seedRows, rng } from './seed.js';

export function runBench({ rows = 1_000_000, queries = 200, scans = 5, dir = null, log = console.log } = {}) {
  const data = dir ?? mkdtempSync(join(tmpdir(), 'minidb-bench-'));
  const storage = new FileStorage(data);
  const db = new Database(storage);
  const rand = rng(7);
  const ms = (t0) => performance.now() - t0;

  log(`데이터 폴더: ${data}`);
  let t0 = performance.now();
  seedRows(db, 'users', rows);
  const insertMs = ms(t0);
  const fileMb = statSync(join(data, 'users.tbl')).size / 1024 / 1024;
  log(`INSERT ${rows.toLocaleString()}건: ${(insertMs / 1000).toFixed(2)}초 (초당 ${Math.round(rows / (insertMs / 1000)).toLocaleString()}건), 파일 ${fileMb.toFixed(1)}MB, B+ 트리 높이 ${db.tables.users.index.height}`);

  // 인덱스 재구성 시간 (서버를 다시 켤 때 걸리는 시간)
  t0 = performance.now();
  db.loadIndexes();
  const rebuildMs = ms(t0);

  // id 로 찾기 (B+ 트리)
  const ids = Array.from({ length: queries }, () => 1 + Math.floor(rand() * rows));
  t0 = performance.now();
  let found = 0;
  for (const id of ids) found += db.execute(`SELECT * FROM users WHERE id = ${id}`)[0].rows.length;
  const indexMs = ms(t0) / queries;

  // email 로 찾기 (선형 탐색) — 뒤쪽 레코드일수록 오래 걸리므로 무작위 위치
  const targets = Array.from({ length: scans }, () => 1 + Math.floor(rand() * rows));
  t0 = performance.now();
  let found2 = 0;
  for (const i of targets) found2 += db.execute(`SELECT * FROM users WHERE email = 'user${i}@jungle.test'`)[0].rows.length;
  const scanMs = ms(t0) / scans;

  // 범위 조회
  t0 = performance.now();
  const rangeRows = db.execute(`SELECT id, name FROM users WHERE id BETWEEN ${Math.floor(rows / 2)} AND ${Math.floor(rows / 2) + 999}`)[0].rows.length;
  const rangeMs = ms(t0);

  storage.close();
  const result = {
    rows, insertMs, rebuildMs, fileMb,
    height: db.tables.users.index.height,
    indexMs, scanMs, speedup: scanMs / indexMs,
    rangeMs, rangeRows,
    found: found === queries && found2 === scans,
    dir: data,
  };
  log('');
  log(`id = ?    (B+ 트리)   평균 ${indexMs.toFixed(3)}ms   (${queries}번)`);
  log(`email = ? (선형 탐색) 평균 ${scanMs.toFixed(1)}ms   (${scans}번)`);
  log(`→ 인덱스가 약 ${Math.round(result.speedup).toLocaleString()}배 빠름`);
  log(`id BETWEEN (1,000건 범위): ${rangeMs.toFixed(2)}ms`);
  log(`서버 재시작 시 인덱스 재구성: ${(rebuildMs / 1000).toFixed(2)}초`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : Number(process.argv[i + 1]);
  };
  const r = runBench({ rows: arg('rows', 1_000_000), queries: arg('queries', 200) });
  if (!process.argv.includes('--keep')) rmSync(r.dir, { recursive: true, force: true });
}
