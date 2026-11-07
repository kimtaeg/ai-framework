/**
 * SQL 처리기 2단계: 실행기 (AST → 실제 동작)  +  B+ 트리 인덱스 연동
 * ------------------------------------------------------------------
 *   INSERT : 값 검사/형 변환 → id 자동 부여 → 파일 끝에 한 줄 추가 → B+ 트리에 (id → 위치) 등록
 *   SELECT : 실행 계획 선택
 *              WHERE id = ?             → index-lookup  (B+ 트리로 위치를 찾아 그 줄만 읽음)    O(log n)
 *              WHERE id >,<,BETWEEN     → index-range   (리프 연결 리스트를 따라 범위만 읽음)    O(log n + k)
 *              그 외 (name = ? 등)      → full-scan     (파일 처음부터 끝까지 읽으며 비교)       O(n)
 *            → 조건 검사 → 열 선택 → LIMIT
 *
 *  저장소(storage)는 바꿔 끼울 수 있다: 브라우저/테스트는 MemoryStorage, CLI/서버는 FileStorage (storage-file.js)
 *  → 실행기 코드는 "파일인지 메모리인지" 모른다. (Phase 1 처리기를 Phase 2·3 에서 그대로 쓰는 이유)
 */
import { parse, SqlError } from './sql.js';
import { BPlusTree } from './bptree.js';
import { encodeRow, decodeRow } from './storage.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Database {
  /**
   * @param {object} storage  storage.js 의 인터페이스를 따르는 저장소
   * @param {{ order?: number }} [opts]  B+ 트리 차수
   */
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.order = opts.order ?? 64;
    this.tables = {};
    const schema = storage.schema();
    for (const [name, def] of Object.entries(schema)) {
      const columns = def.columns.map((c) => ({ name: c.name, type: String(c.type).toUpperCase() }));
      if (columns[0]?.name !== 'id') throw new Error(`테이블 '${name}' 의 첫 열은 id 여야 합니다.`);
      this.tables[name] = { name, columns, index: new BPlusTree(this.order), nextId: 1 };
    }
    this.loadIndexes();
  }

  /** 파일을 한 번 훑어 B+ 트리 인덱스를 만든다 (서버 시작 시) */
  loadIndexes() {
    for (const t of Object.values(this.tables)) {
      t.index = new BPlusTree(this.order);
      t.nextId = 1;
      for (const [loc, line] of this.storage.scan(t.name)) {
        if (!line) continue;
        const comma = line.indexOf(',');
        const id = Number(comma === -1 ? line : line.slice(0, comma));
        if (!Number.isInteger(id)) continue;
        t.index.insert(id, loc);
        if (id >= t.nextId) t.nextId = id + 1;
      }
    }
  }

  table(name, pos) {
    const t = this.tables[name] ?? Object.values(this.tables).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!t) throw new SqlError(`테이블 '${name}' 이(가) 없습니다. (있는 테이블: ${Object.keys(this.tables).join(', ')})`, pos);
    return t;
  }

  /** SQL 문자열(여러 문장 가능) 실행 → 문장별 결과 배열 */
  execute(sql) {
    const statements = typeof sql === 'string' ? parse(sql) : sql;
    const results = [];
    try {
      for (const st of statements) results.push(st.type === 'insert' ? this.insert(st) : this.select(st));
    } finally {
      this.storage.flush();
    }
    return results;
  }

  /** 문장들이 건드리는 테이블과 쓰기 여부 (서버의 락 결정용) */
  static analyze(sql) {
    const statements = parse(sql);
    return {
      statements,
      writes: [...new Set(statements.filter((s) => s.type === 'insert').map((s) => s.table))],
      reads: [...new Set(statements.filter((s) => s.type === 'select').map((s) => s.table))],
    };
  }

  // ================================================================ INSERT
  insert(st) {
    const t0 = now();
    const t = this.table(st.table, st.pos);
    this.storage.refresh?.(t.name);
    const cols = st.columns ?? t.columns.slice(1).map((c) => c.name); // 열을 안 쓰면 id 를 뺀 나머지 순서대로
    if (cols.some((c) => c.toLowerCase() === 'id')) throw new SqlError('id 는 자동으로 부여되므로 직접 넣을 수 없습니다.', st.pos);
    const colIdx = cols.map((c) => {
      const i = t.columns.findIndex((x) => x.name.toLowerCase() === c.toLowerCase());
      if (i === -1) throw new SqlError(`테이블 '${t.name}' 에 열 '${c}' 이(가) 없습니다.`, st.pos);
      return i;
    });
    // 먼저 모든 행을 검사 → 하나라도 틀리면 아무것도 저장하지 않는다 (문장 단위 원자성)
    const prepared = st.rows.map((row, r) => {
      if (row.length !== cols.length) throw new SqlError(`${r + 1}번째 행: 열은 ${cols.length}개인데 값은 ${row.length}개입니다.`, st.pos);
      const values = new Array(t.columns.length).fill(null);
      row.forEach((v, k) => (values[colIdx[k]] = coerce(v, t.columns[colIdx[k]], st.pos)));
      return values;
    });
    const ids = [];
    const entries = []; // [id, 위치] — 스레드 풀에서 다른 워커의 인덱스에 알려 줄 때 사용
    for (const values of prepared) {
      const id = t.nextId++;
      values[0] = id;
      const loc = this.storage.append(t.name, encodeRow(values));
      t.index.insert(id, loc);
      ids.push(id);
      entries.push([id, loc]);
    }
    return { type: 'insert', table: t.name, count: ids.length, ids, ms: now() - t0, entries };
  }

  /** 다른 스레드가 넣은 레코드를 이 인스턴스의 인덱스에도 반영 (Phase 3 스레드 풀) */
  applyIndex(table, entries) {
    const t = this.table(table);
    for (const [id, loc] of entries) {
      if (!t.index.has(id)) t.index.insert(id, loc);
      if (id >= t.nextId) t.nextId = id + 1;
    }
  }

  // ================================================================ SELECT
  select(st) {
    const t0 = now();
    const t = this.table(st.table, st.pos);
    const colIndex = (name) => {
      const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      if (i === -1) throw new SqlError(`테이블 '${t.name}' 에 열 '${name}' 이(가) 없습니다.`, st.pos);
      return i;
    };
    const outCols = st.columns === '*' ? t.columns.map((_, i) => i) : st.columns.map(colIndex);
    const conds = st.where.map((c) => {
      const i = colIndex(c.column);
      // 비교에서는 INT 열과 실수(2.5)를 비교해도 된다 (저장할 때만 정수 검사)
      const col = t.columns[i];
      const value = c.value.kind === 'null' ? null : col.type === 'INT' && c.value.kind === 'number' ? c.value.value : coerce(c.value, col, st.pos);
      return { i, op: c.op, value, column: col.name };
    });

    const plan = choosePlan(conds, t);
    const rows = [];
    let scanned = 0;
    const limit = st.limit ?? Infinity;
    const take = (line) => {
      scanned++;
      const rec = typed(decodeRow(line), t.columns);
      if (conds.every((c) => test(rec[c.i], c.op, c.value))) rows.push(outCols.map((i) => rec[i]));
    };
    if (limit > 0) {
      if (plan.type === 'index-lookup') {
        const loc = plan.empty ? undefined : t.index.get(plan.key);
        if (loc !== undefined) take(this.storage.read(t.name, loc));
      } else if (plan.type === 'index-range') {
        if (!plan.empty) {
          for (const [, loc] of t.index.range(plan.lo, plan.hi)) {
            take(this.storage.read(t.name, loc));
            if (rows.length >= limit) break;
          }
        }
      } else {
        for (const [, line] of this.storage.scan(t.name)) {
          if (!line) continue;
          take(line);
          if (rows.length >= limit) break;
        }
      }
    }
    return {
      type: 'select',
      table: t.name,
      columns: outCols.map((i) => t.columns[i].name),
      rows: rows.slice(0, limit),
      plan: { ...plan, scanned, total: t.index.size, height: t.index.height },
      ms: now() - t0,
    };
  }

  /** 시각화/테스트용 */
  info() {
    return Object.fromEntries(Object.values(this.tables).map((t) => [t.name, { rows: t.index.size, nextId: t.nextId, height: t.index.height, columns: t.columns }]));
  }
}

/** id 조건이 있으면 인덱스를 쓴다 */
function choosePlan(conds, t) {
  const idConds = conds.filter((c) => c.i === 0 && c.op !== '!=' && c.value !== null);
  const eq = idConds.find((c) => c.op === '=');
  if (eq) {
    // id = 3 AND id = 4 같은 모순도 처리: 다른 = 조건과 값이 다르면 결과 없음
    const empty = idConds.some((c) => c.op === '=' && c.value !== eq.value);
    return { type: 'index-lookup', key: eq.value, empty, reason: 'WHERE id = ? → B+ 트리로 바로 찾기' };
  }
  if (idConds.length) {
    let lo = -Infinity, hi = Infinity;
    for (const c of idConds) {
      if (c.op === '>') lo = Math.max(lo, Math.floor(c.value) + 1);
      if (c.op === '>=') lo = Math.max(lo, Math.ceil(c.value));
      if (c.op === '<') hi = Math.min(hi, Math.ceil(c.value) - 1);
      if (c.op === '<=') hi = Math.min(hi, Math.floor(c.value));
    }
    return { type: 'index-range', lo, hi, empty: lo > hi, reason: 'id 범위 조건 → B+ 트리 리프를 따라 범위만 읽기' };
  }
  return { type: 'full-scan', reason: conds.length ? '인덱스가 없는 열 조건 → 처음부터 끝까지 비교' : '조건 없음 → 전체 읽기' };
}

function coerce(v, col, pos) {
  if (v.kind === 'null') return null;
  if (col.type === 'INT') {
    if (v.kind !== 'number' || !Number.isInteger(v.value)) throw new SqlError(`열 '${col.name}' 은(는) 정수(INT)입니다: ${JSON.stringify(v.value)}`, pos);
    return v.value;
  }
  if (col.type === 'REAL') {
    if (v.kind !== 'number') throw new SqlError(`열 '${col.name}' 은(는) 숫자(REAL)입니다: ${JSON.stringify(v.value)}`, pos);
    return v.value;
  }
  return String(v.value); // TEXT: 숫자를 넣어도 문자열로
}

function typed(raw, columns) {
  return raw.map((v, i) => (v === null ? null : columns[i]?.type === 'INT' || columns[i]?.type === 'REAL' ? Number(v) : v));
}

function test(a, op, b) {
  if (b === null) return op === '=' ? a === null : op === '!=' ? a !== null : false; // col = NULL 을 IS NULL 처럼
  if (a === null) return false;
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

/** 결과를 CLI 표로 */
export function formatResult(r) {
  if (r.type === 'insert') return `INSERT ${r.count}건 → ${r.table} (id ${r.ids.length > 3 ? `${r.ids[0]}…${r.ids.at(-1)}` : r.ids.join(', ')})  ${r.ms.toFixed(2)}ms`;
  const cells = [r.columns, ...r.rows.map((row) => row.map((v) => (v === null ? 'NULL' : String(v))))];
  const width = r.columns.map((_, i) => Math.max(...cells.map((row) => displayWidth(row[i]))));
  const line = '+' + width.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (row) => '| ' + row.map((v, i) => v + ' '.repeat(width[i] - displayWidth(v))).join(' | ') + ' |';
  const out = [line, fmt(cells[0]), line, ...cells.slice(1).map(fmt), line];
  out.push(`${r.rows.length}행  ·  ${planLabel(r.plan)}  ·  읽은 레코드 ${r.plan.scanned}/${r.plan.total}  ·  ${r.ms.toFixed(2)}ms`);
  return out.join('\n');
}

export function planLabel(p) {
  return p.type === 'index-lookup' ? 'B+ 트리 인덱스 조회' : p.type === 'index-range' ? 'B+ 트리 범위 조회' : '선형 탐색 (full scan)';
}

/** 한글 등 전각 문자는 터미널에서 두 칸 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
