/**
 * 2주차 샌드박스 실행기 — 레디스 / DBMS 공용 (DOM 없음 → 테스트에서도 그대로 실행)
 *  사용자가 쓴 코드를 async 함수로 감싸 실행하고, print 출력과 에러를 모아 돌려준다.
 */
import { MiniRedis } from '../redis/miniredis.js';
import { HashTable } from '../redis/hashtable.js';
import { Database, planLabel } from '../dbms/engine.js';
import { MemoryStorage } from '../dbms/storage.js';
import { BPlusTree } from '../dbms/bptree.js';
import { seedRows } from '../dbms/seed.js';
import { tokenize, parse } from '../dbms/sql.js';

export const SANDBOX_SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
  posts: { columns: [{ name: 'id', type: 'INT' }, { name: 'title', type: 'TEXT' }, { name: 'author', type: 'TEXT' }] },
};

/** 새 실행 환경 (레디스 + DB) */
export function createEnv() {
  const redis = new MiniRedis();
  const db = new Database(new MemoryStorage(JSON.parse(JSON.stringify(SANDBOX_SCHEMA))), { order: 16 });
  return { redis, db };
}

export function formatValue(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return `[함수 ${v.name || ''}]`;
  try {
    return JSON.stringify(v, (k, x) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x), 2);
  } catch {
    return String(v);
  }
}

/** SELECT 결과를 글자 표로 */
export function textTable(r) {
  if (r.type === 'insert') return `INSERT ${r.count}건 → ${r.table} (id ${r.ids.join(', ')})`;
  const cells = [r.columns, ...r.rows.slice(0, 30).map((row) => row.map((v) => (v === null ? 'NULL' : String(v))))];
  const w = r.columns.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const line = (row) => row.map((v, i) => v.padEnd(w[i])).join(' | ');
  return [line(cells[0]), w.map((n) => '-'.repeat(n)).join('-+-'), ...cells.slice(1).map(line), `${r.rows.length}행 · ${planLabel(r.plan)} · 읽은 레코드 ${r.plan.scanned}/${r.plan.total}`].join('\n');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const NAMES = ['redis', 'db', 'sql', 'print', 'sleep', 'time', 'HashTable', 'BPlusTree', 'MiniRedis', 'seedRows', 'tokenize', 'parse'];

/**
 * @param {string} code
 * @param {{ redis, db }} env
 * @param {{ timeoutMs?: number, onLog?: (entry) => void }} [opts]
 * @returns {Promise<{ logs: Array<{ type: 'log'|'table'|'time'|'error', text: string }>, error: null|{ message, line } , ms: number }>}
 */
export async function runCode(code, env, opts = {}) {
  const logs = [];
  let stopped = false; // 시간 제한에 걸리면 true → sleep/print 가 코드를 멈춘다 (뒤에서 계속 도는 것 방지)
  const checkStop = () => {
    if (stopped) throw new Error('시간 제한으로 실행을 멈췄습니다.');
  };
  const push = (type, text) => {
    checkStop();
    const e = { type, text };
    logs.push(e);
    opts.onLog?.(e);
    if (logs.length > 2000) throw new Error('출력이 너무 많습니다 (2000줄). 반복문을 확인하세요.');
  };
  const print = (...args) => push('log', args.map(formatValue).join(' '));
  const sql = (text) => {
    const results = env.db.execute(text);
    for (const r of results) push('table', textTable(r));
    return results;
  };
  const sleep = (ms) => {
    checkStop();
    return new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 5000))).then(checkStop);
  };
  const time = (label, fn) => {
    const t0 = performance.now();
    const out = fn();
    push('time', `⏱ ${label}: ${(performance.now() - t0).toFixed(2)}ms`);
    return out;
  };
  const t0 = performance.now();
  let error = null;
  try {
    const fn = new AsyncFunction(...NAMES, `"use strict";\n${code}`);
    const run = fn(env.redis, env.db, sql, print, sleep, time, HashTable, BPlusTree, MiniRedis, seedRows, tokenize, parse);
    const limit = opts.timeoutMs ?? 15000;
    let timer;
    run.catch(() => {}); // 멈춘 뒤 나오는 에러는 무시
    await Promise.race([run, new Promise((_, no) => { timer = setTimeout(() => { stopped = true; no(new Error(`${limit / 1000}초 안에 끝나지 않았습니다.`)); }, limit); })]).finally(() => clearTimeout(timer));
  } catch (e) {
    if (stopped) {
      error = { message: e.message, line: null };
      logs.push({ type: 'error', text: `✗ ${e.message}` });
      opts.onLog?.(logs.at(-1));
      return { logs, error, ms: performance.now() - t0 };
    }
    const m = String(e.stack ?? '').match(/<anonymous>:(\d+):\d+/);
    error = { message: e.message, line: m ? Number(m[1]) - 3 : null }; // 감싼 함수의 머리 줄만큼 빼기
    push('error', `✗ ${e.name === 'SqlError' ? 'SQL 오류' : e.name}: ${e.message}${error.line > 0 ? ` (${error.line}번째 줄 근처)` : ''}`);
  }
  return { logs, error, ms: performance.now() - t0 };
}
