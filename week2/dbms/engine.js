/**
 * SQL 처리기 2단계: 실행기 (AST → 실제 동작)  +  B+ 트리 인덱스 연동
 * ------------------------------------------------------------------
 *   INSERT : 값 검사/형 변환 → id 자동 부여 → 파일 끝에 한 줄 추가 → B+ 트리에 (id → 위치) 등록
 *   SELECT : 실행 계획 선택
 *              WHERE id = ?             → index-lookup  (B+ 트리로 위치를 찾아 그 줄만 읽음)    O(log n)
 *              WHERE id >,<,BETWEEN     → index-range   (리프 연결 리스트를 따라 범위만 읽음)    O(log n + k)
 *              그 외 (name = ? 등)      → full-scan     (파일 처음부터 끝까지 읽으며 비교)       O(n)
 *              (autoIndex 옵션) 열 = ?  → hash-index    (그 열을 처음 조회할 때 값 → 위치 표를 만들어 둠)  O(1)
 *            → 조건 검사 → 열 선택 → LIMIT
 *
 *  저장소(storage)는 바꿔 끼울 수 있다: 브라우저/테스트는 MemoryStorage, CLI/서버는 FileStorage (storage-file.js)
 *  → 실행기 코드는 "파일인지 메모리인지" 모른다. (Phase 1 처리기를 Phase 2·3 에서 그대로 쓰는 이유)
 */
import { parse, SqlError } from './sql.js';
import { BPlusTree } from './bptree.js';
import { encodeRow, decodeRow, decodeField } from './storage.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Database {
  /**
   * @param {object} storage  storage.js 의 인터페이스를 따르는 저장소
   * @param {{ order?: number, autoIndex?: boolean }} [opts]
   *   order: B+ 트리 차수
   *   autoIndex: id 가 아닌 열의 = 조건을 처음 만나면 그 열의 해시 인덱스를 만들어 다음부터 쓴다 (기본 끔.
   *              끄면 과제 그대로 "id 는 인덱스, 나머지는 선형 탐색". API 서버의 워커는 켠다)
   *   maxRows: SELECT 한 문장이 돌려주는 행 수의 상한 (기본 없음). LIMIT 없이 큰 테이블을 통째로 읽어
   *            메모리가 터지는 것을 막는다. 상한에 걸려 잘렸으면 결과에 truncated: true
   */
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.order = opts.order ?? 64;
    this.autoIndex = opts.autoIndex ?? false;
    this.maxRows = opts.maxRows > 0 ? opts.maxRows : Infinity;
    this.tables = {};
    const schema = storage.schema();
    for (const [name, def] of Object.entries(schema)) {
      const columns = def.columns.map((c) => ({ name: c.name, type: String(c.type).toUpperCase() }));
      if (columns[0]?.name !== 'id') throw new Error(`테이블 '${name}' 의 첫 열은 id 여야 합니다.`);
      // end: 확정된 내용의 끝 위치 (저장소가 지원할 때만. scan 은 여기까지만 읽는다). secondary: 열 번호 → Map(값의 키 → 위치 | 위치 배열)
      const numeric = columns.map((c) => c.type === 'INT' || c.type === 'REAL');
      this.tables[name] = { name, columns, numeric, index: new BPlusTree(this.order), nextId: 1, end: Infinity, secondary: new Map() };
    }
    this.loadIndexes();
  }

  /** 파일을 한 번 훑어 B+ 트리 인덱스를 만든다 (서버 시작 시 / 롤백 뒤에는 그 테이블만) */
  loadIndexes(only = null) {
    for (const t of Object.values(this.tables)) {
      if (only && !only.includes(t.name)) continue;
      t.index = new BPlusTree(this.order);
      t.nextId = 1;
      t.secondary = new Map(); // 보조 인덱스는 다음에 쓸 때 다시 만든다
      this.storage.dropCache?.(t.name); // 파일이 바뀌었을 수 있으니 버퍼 풀도 비운다
      this.setEnd(t, this.storage.end?.(t.name) ?? Infinity);
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

  /** 확정된 끝 위치를 바꾸고 저장소에도 알린다 */
  setEnd(t, end) {
    t.end = end;
    if (end !== Infinity) this.storage.limit?.(t.name, end);
  }

  table(name, pos) {
    const t = this.tables[name] ?? Object.values(this.tables).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!t) throw new SqlError(`테이블 '${name}' 이(가) 없습니다. (있는 테이블: ${Object.keys(this.tables).join(', ')})`, pos);
    return t;
  }

  /**
   * SQL 문자열(여러 문장 가능) 실행 → 문장별 결과 배열
   * 요청 단위 원자성: 중간에 한 문장이라도 실패하면 이 요청이 앞에서 넣은 레코드를 모두 되돌린다.
   *   (되돌리지 않으면 "에러" 응답을 받았는데 앞 문장의 INSERT 는 남아 있어서, 다시 시도하면 두 번 들어간다)
   */
  execute(sql, params = null) {
    const statements = typeof sql === 'string' ? parse(sql, params) : sql;
    const results = [];
    const marks = new Map(); // 테이블 → 이 요청이 처음 쓰기 전의 크기
    const canRollback = typeof this.storage.truncate === 'function' && typeof this.storage.size === 'function';
    try {
      for (const st of statements) {
        if (st.type !== 'insert') {
          results.push(this.select(st));
          continue;
        }
        const t = this.table(st.table, st.pos);
        if (canRollback && !marks.has(t.name)) {
          this.storage.refresh?.(t.name); // 다른 스레드가 덧붙인 것까지 반영한 크기가 기준점
          marks.set(t.name, this.storage.size(t.name));
        }
        // 이 요청에서 이미 파일 크기를 다시 읽었으면(위) insert 가 또 읽지 않게 한다 (INSERT 마다 시스템 콜 2번 절약)
        results.push(this.insert(st, canRollback));
      }
    } catch (e) {
      const dirty = [...marks].filter(([name, size]) => this.storage.size(name) !== size);
      for (const [name, size] of dirty) this.storage.truncate(name, size);
      if (dirty.length) this.loadIndexes(dirty.map(([name]) => name)); // 인덱스와 nextId 도 되돌린다
      throw e;
    } finally {
      this.storage.flush();
    }
    return results;
  }

  /** 문장들이 건드리는 테이블과 쓰기 여부 (서버의 락 결정용) */
  static analyze(sql, params = null) {
    const statements = parse(sql, params);
    return {
      statements,
      writes: [...new Set(statements.filter((s) => s.type === 'insert').map((s) => s.table))],
      reads: [...new Set(statements.filter((s) => s.type === 'select').map((s) => s.table))],
    };
  }

  // ================================================================ INSERT
  insert(st, refreshed = false) {
    const t0 = now();
    const t = this.table(st.table, st.pos);
    if (!refreshed) this.storage.refresh?.(t.name);
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
      for (const [col, idx] of t.secondary) addToIndex(idx, values[col], loc);
      ids.push(id);
      entries.push([id, loc]);
    }
    if (t.end !== Infinity) this.setEnd(t, this.storage.size(t.name));
    return { type: 'insert', table: t.name, count: ids.length, ids, ms: now() - t0, entries };
  }

  /** 다른 스레드가 넣은 레코드를 이 인스턴스의 인덱스에도 반영 (Phase 3 스레드 풀) */
  applyIndex(table, entries) {
    const t = this.table(table);
    // 한꺼번에 많이 들어왔으면 보조 인덱스는 버리고 다음에 쓸 때 다시 만든다 (레코드마다 파일을 읽지 않게)
    if (t.secondary.size && entries.length > 256) t.secondary = new Map();
    // 이미 확정된 구간 안의 위치가 새로 왔다 = 그 자리가 다시 쓰였다 (롤백 뒤) → 버퍼 풀을 믿지 않는다
    if (t.end !== Infinity && entries.some(([, loc]) => loc < t.end)) this.storage.dropCache?.(t.name);
    for (const [id, loc] of entries) {
      if (!t.index.has(id)) {
        t.index.insert(id, loc);
        if (t.secondary.size) {
          const line = this.storage.read(t.name, loc);
          for (const [col, idx] of t.secondary) addToIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
        }
      }
      if (id >= t.nextId) t.nextId = id + 1;
    }
    // 확정된 끝 = 방금 알게 된 레코드 중 가장 뒤에 있는 줄의 끝
    if (t.end !== Infinity && entries.length) {
      let last = -1;
      for (const [, loc] of entries) if (loc > last) last = loc;
      if (last >= t.end) {
        this.setEnd(t, last + byteLength(this.storage.read(t.name, last)) + 1);
      }
    }
  }

  /** col 번째 열의 해시 인덱스 (없으면 파일을 한 번 훑어 만든다) */
  secondaryIndex(t, col) {
    let idx = t.secondary.get(col);
    if (idx) return { idx, built: 0 };
    idx = new Map();
    let built = 0;
    for (const [loc, line] of this.storage.scan(t.name)) {
      if (!line) continue;
      built++;
      addToIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
    }
    t.secondary.set(col, idx);
    return { idx, built };
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

    const plan = choosePlan(conds, t, this.autoIndex);
    const rows = [];
    let scanned = 0;
    const asked = st.limit ?? Infinity;
    const limit = Math.min(asked, this.maxRows); // 서버가 정한 상한을 넘지 않게
    // 열마다 숫자로 바꿔야 하는지 미리 계산 (행마다 열 형식을 다시 보지 않게)
    const numeric = t.numeric;
    const nconds = conds.length;
    const take = (line) => {
      scanned++;
      // 조건에 쓰는 열만 먼저 꺼내서 검사 → 맞는 행만 전체를 읽는다 (전체 읽기에서 대부분의 행은 탈락)
      // 따옴표가 있는 줄은 형식 오류를 놓치지 않도록 처음부터 전체를 해석한다 (decodeField 가 그렇게 함)
      for (let k = 0; k < nconds; k++) {
        const c = conds[k];
        if (!test(typedValue(decodeField(line, c.i), c.i, numeric), c.op, c.value)) return;
      }
      const raw = decodeRow(line);
      rows.push(outCols.map((i) => typedValue(raw[i], i, numeric)));
    };
    if (limit > 0) {
      if (plan.type === 'index-lookup') {
        const loc = plan.empty ? undefined : t.index.get(plan.key);
        if (loc !== undefined) take(this.storage.read(t.name, loc));
      } else if (plan.type === 'index-range') {
        if (!plan.empty) {
          // 처음 몇 개는 한 줄씩 읽고(작은 범위 · LIMIT 은 이게 빠르다), 범위가 길면 덩어리로 이어 읽는다.
          // id 는 넣은 순서대로 커지므로 id 범위 = 파일에서 이어진 구간 → 레코드마다 read() 를 부르지 않아도 된다.
          let n = 0;
          let chunked = null; // 범위가 길어지면 여는 "덩어리 읽기" (null = 아직 안 엶, false = 못 씀)
          for (const [, loc] of t.index.range(plan.lo, plan.hi)) {
            let line;
            if (chunked === null && ++n > RANGE_SINGLE_READS) chunked = this.storage.scan(t.name, loc);
            if (chunked) {
              const next = chunked.next();
              if (!next.done && next.value[0] === loc) line = next.value[1];
              else chunked = false; // 파일 순서와 id 순서가 다르면(손으로 고친 파일 등) 한 줄씩 읽기로 돌아간다
            }
            take(line ?? this.storage.read(t.name, loc));
            if (rows.length >= limit) break;
          }
        }
      } else if (plan.type === 'hash-index') {
        const { idx, built } = this.secondaryIndex(t, plan.i);
        if (built) plan.built = built; // 인덱스를 만드느라 읽은 줄 수 (처음 한 번). 조회가 읽은 줄 수(scanned)와 따로 센다
        const hit = idx.get(indexKey(plan.key));
        if (typeof hit === 'number') take(this.storage.read(t.name, hit));
        else if (hit) {
          for (const loc of hit) {
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
      ...(rows.length >= limit && limit < asked ? { truncated: true } : {}), // 상한에 걸려 잘렸다 (더 있을 수 있음)
      plan: { ...plan, scanned, total: t.index.size, height: t.index.height },
      ms: now() - t0,
    };
  }

  /** 시각화/테스트용 */
  info() {
    return Object.fromEntries(Object.values(this.tables).map((t) => [t.name, { rows: t.index.size, nextId: t.nextId, height: t.index.height, columns: t.columns }]));
  }
}

const RANGE_SINGLE_READS = 8;
const byteLength = (s) => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length);

/**
 * 해시 인덱스의 키. 문자열은 그대로 넣지 않고 32bit 해시(FNV-1a) 숫자로 바꿔 넣는다.
 *   문자열 수십만 개를 표에 붙들고 있으면 메모리도 크고, 쓰레기 수집(GC)이 그것을 훑느라 가끔 요청이 수 ms 씩 멈춘다.
 *   숫자만 담으면 표가 작고 GC 가 볼 것도 없다. 해시가 우연히 겹친 다른 값은, 읽은 줄을 WHERE 조건으로
 *   다시 검사하는 단계(take)에서 걸러지므로 결과는 달라지지 않는다 (줄을 한두 개 더 읽을 뿐).
 */
function indexKey(value) {
  if (typeof value !== 'string') return value;
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return h;
}

/** 해시 인덱스에 (값 → 위치) 추가. 같은 값이 여러 번이면 위치 배열로 (넣은 순서 = 파일 순서) */
function addToIndex(idx, value, loc) {
  if (value == null) return; // NULL 은 = 로 찾지 않는다
  const key = indexKey(value);
  const prev = idx.get(key);
  if (prev === undefined) idx.set(key, loc);
  else if (typeof prev === 'number') idx.set(key, [prev, loc]);
  else prev.push(loc);
}

/** id 조건이 있으면 인덱스를 쓴다 */
function choosePlan(conds, t, autoIndex = false) {
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
  if (autoIndex) {
    const c = conds.find((x) => x.op === '=' && x.value !== null);
    if (c) return { type: 'hash-index', i: c.i, column: c.column, key: c.value, reason: `WHERE ${c.column} = ? → 해시 인덱스로 그 줄만 읽기 (처음 한 번은 파일을 훑어 만든다)` };
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

/** 저장된 값(문자열/null) 하나를 열 형식에 맞게: INT·REAL 열이면 숫자, 아니면 그대로 */
function typedValue(v, i, numeric) {
  if (v == null) return v; // null(NULL 값) 또는 undefined(줄에 그 열이 없음) 는 그대로
  return numeric[i] ? Number(v) : v;
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
  return p.type === 'index-lookup' ? 'B+ 트리 인덱스 조회' : p.type === 'index-range' ? 'B+ 트리 범위 조회' : p.type === 'hash-index' ? '해시 인덱스 조회' : '선형 탐색 (full scan)';
}

/** 한글 등 전각 문자는 터미널에서 두 칸 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
