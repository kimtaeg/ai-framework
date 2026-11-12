#!/usr/bin/env node
/**
 * 미니 DBMS 명령줄 (Phase 1 CLI)
 *
 *   node week2/dbms/cli.js run  query.sql          SQL 파일 실행
 *   node week2/dbms/cli.js exec "SELECT * FROM users WHERE id = 1"
 *   node week2/dbms/cli.js seed users 1000000      대용량 레코드 생성 (Phase 2 성능 테스트용)
 *   node week2/dbms/cli.js info                    테이블별 레코드 수, B+ 트리 높이
 *   type query.sql | node week2/dbms/cli.js run -  표준 입력에서 읽기
 *
 *   옵션: --data <폴더>   데이터 폴더 (기본 week2/data/db)
 *         --json          결과를 JSON 으로
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, formatResult } from './engine.js';
import { FileStorage } from './storage-file.js';
import { seedRows } from './seed.js';

export function runCli(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n') } = {}) {
  const args = [...argv];
  const take = (flag, def) => {
    const i = args.indexOf(flag);
    if (i === -1) return def;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const dataArg = take('--data', 'week2/data/db');
  if (!dataArg || dataArg.startsWith('--')) {
    err('오류: --data 뒤에 데이터 폴더를 지정하세요.');
    return 1;
  }
  const dataDir = resolve(dataArg);
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const [cmd, ...rest] = args;
  const usage = '사용법: cli.js run <파일.sql|-> | exec "<SQL>" | seed <테이블> <개수> | info   [--data 폴더] [--json]';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out(usage);
    return cmd ? 0 : 1;
  }
  let storage;
  try {
    storage = new FileStorage(dataDir);
    const db = new Database(storage);
    if (cmd === 'info') {
      out(json ? JSON.stringify(db.info()) : Object.entries(db.info()).map(([t, i]) => `${t}: ${i.rows.toLocaleString()}행, 다음 id ${i.nextId}, B+ 트리 높이 ${i.height}`).join('\n'));
      return 0;
    }
    if (cmd === 'seed') {
      const [table, nStr] = rest;
      const n = Number(nStr);
      if (!table || !Number.isInteger(n) || n <= 0) throw new Error('seed <테이블> <개수> 형식이어야 합니다.');
      const t0 = Date.now();
      const r = seedRows(db, table, n);
      out(`${table} 에 ${r.count.toLocaleString()}건 추가 (id ${r.first}~${r.last}) · ${((Date.now() - t0) / 1000).toFixed(2)}초`);
      return 0;
    }
    let sql;
    if (cmd === 'run') {
      const file = rest[0];
      if (!file) throw new Error('실행할 SQL 파일을 지정하세요.');
      sql = file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
    } else if (cmd === 'exec') {
      sql = rest.join(' ');
      if (!sql.trim()) throw new Error('실행할 SQL 을 넣으세요.');
    } else throw new Error(`알 수 없는 명령 '${cmd}'\n${usage}`);
    const results = db.execute(sql);
    if (json) out(JSON.stringify(results.map(({ entries, ...r }) => r)));
    else for (const r of results) out(formatResult(r));
    return 0;
  } catch (e) {
    err(`오류: ${e.message}`);
    return 1;
  } finally {
    storage?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
