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
import { encodeRow, decodeRow, decodeField, fieldEqualsPlain, isPlainText } from './storage.js';

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
    this.tableMap = new Map();
    const schema = storage.schema();
    for (const [name, def] of Object.entries(schema)) {
      const columns = def.columns.map((c) => ({ name: c.name, type: String(c.type).toUpperCase() }));
      if (columns[0]?.name !== 'id') throw new Error(`테이블 '${name}' 의 첫 열은 id 여야 합니다.`);
      // end: 확정된 내용의 끝 위치 (저장소가 지원할 때만. scan 은 여기까지만 읽는다). secondary: 열 번호 → Map(값의 키 → 위치 | 위치 배열)
      const numeric = columns.map((c) => c.type === 'INT' || c.type === 'REAL');
      const colMap = new Map();
      const allColIdx = new Array(columns.length);
      const allColNames = new Array(columns.length);
      const numericCols = [];
      for (let i = 0; i < columns.length; i++) {
        colMap.set(columns[i].name.toLowerCase(), i);
        allColIdx[i] = i;
        allColNames[i] = columns[i].name;
        if (numeric[i]) numericCols.push(i);
      }
      const defaultCols = allColNames.slice(1);
      const defaultColIdx = allColIdx.slice(1);
      // 스키마에 적어 둔 해시 인덱스 열: { "columns": [...], "indexes": ["email"] }
      //   처음 조회할 때가 아니라 시작할 때(B+ 트리를 만드는 같은 훑기에서) 함께 만든다 → 첫 조회도 빠르다.
      //   autoIndex 를 끈 곳(CLI 등)에서도 쓰이고, 인덱스 수 상한에 걸려 버려지지 않는다.
      const declared = new Set();
      for (const colName of def.indexes ?? []) {
        const i = colMap.get(String(colName).toLowerCase()) ?? -1;
        if (i === -1) throw new Error(`테이블 '${name}' 의 indexes 에 없는 열이 있습니다: ${colName}`);
        if (i > 0) declared.add(i); // id 는 이미 B+ 트리가 있다
      }
      const t = { name, columns, numeric, numericCols, colMap, allColIdx, allColNames, defaultCols, defaultColIdx, index: new BPlusTree(this.order), nextId: 1, end: Infinity, secondary: new Map(), declared };
      this.tables[name] = t;
      this.tableMap.set(name, t);
      this.tableMap.set(name.toLowerCase(), t);
    }
    this.loadIndexes();
  }

  /** 파일을 한 번 훑어 B+ 트리 인덱스를 만든다 (서버 시작 시 / 롤백 뒤에는 그 테이블만) */
  loadIndexes(only = null) {
    for (const t of Object.values(this.tables)) {
      if (only && !only.includes(t.name)) continue;
      t.index = new BPlusTree(this.order);
      t.nextId = 1;
      t.secondary = new Map(); // 자동으로 만든 보조 인덱스는 다음에 쓸 때 다시 만든다
      const pre = [...t.declared].map((col) => [col, new Map()]); // 스키마에 적어 둔 것은 지금 함께 만든다
      for (const [col, idx] of pre) t.secondary.set(col, idx);
      this.storage.dropCache?.(t.name); // 파일이 바뀌었을 수 있으니 버퍼 풀도 비운다
      this.setEnd(t, this.storage.end?.(t.name) ?? Infinity);
      if (pre.length === 0 && typeof this.storage.eachId === 'function') {
        // 빠른 길: id 만 필요하다 → 저장소가 바이트에서 숫자만 읽어 준다
        const ids = [], locs = [];
        let sorted = true, prev = -Infinity;
        this.storage.eachId(t.name, (loc, id) => {
          ids.push(id);
          locs.push(loc);
          if (id <= prev) sorted = false;
          prev = id;
          if (id >= t.nextId) t.nextId = id + 1;
        });
        if (sorted) t.index = BPlusTree.buildFromSorted(ids, locs, this.order);
        else for (let k = 0; k < ids.length; k++) t.index.insert(ids[k], locs[k]);
        continue;
      }
      const ids = [], locs = [];
      let sorted = true, prev = -Infinity;
      const onLine = (loc, line) => {
        if (!line) return;
        const comma = line.indexOf(',');
        const id = Number(comma === -1 ? line : line.slice(0, comma));
        if (!Number.isInteger(id)) return;
        ids.push(id);
        locs.push(loc);
        if (id <= prev) sorted = false;
        prev = id;
        if (id >= t.nextId) t.nextId = id + 1;
        for (let k = 0; k < pre.length; k++) addToIndex(pre[k][1], typedValue(decodeField(line, pre[k][0]), pre[k][0], t.numeric), loc);
      };
      if (typeof this.storage.forEachLine === 'function') this.storage.forEachLine(t.name, 0, false, onLine);
      else for (const [loc, line] of this.storage.scan(t.name)) onLine(loc, line);
      if (sorted) t.index = BPlusTree.buildFromSorted(ids, locs, this.order);
      else for (let k = 0; k < ids.length; k++) t.index.insert(ids[k], locs[k]);
    }
  }

  /**
   * 이 인스턴스가 모르는 사이에 파일 끝에 덧붙은 줄을 인덱스에 반영한다 (쓰기 전에, 쓰기 락을 쥔 상태에서 부른다).
   *   API 서버가 켜져 있는 동안 CLI 등 다른 프로그램이 같은 폴더에 INSERT 했을 때를 위한 것이다.
   *   반영하지 않으면 다음 id 를 모르는 채로 쓰게 되어 같은 id 가 두 번 부여된다.
   *   (두 프로그램이 정확히 같은 순간에 쓰는 것은 데이터 폴더 락(storage-file.js 의 lockDataDir)이 막는다)
   */
  catchUp(t) {
    if (t.end === Infinity) return;
    const size = this.storage.size(t.name);
    if (size <= t.end) return;
    const from = t.end;
    this.setEnd(t, size);
    for (const [loc, line] of this.storage.scan(t.name, from, true)) {
      if (!line) continue;
      const comma = line.indexOf(',');
      const id = Number(comma === -1 ? line : line.slice(0, comma));
      if (!Number.isInteger(id) || t.index.has(id)) continue;
      t.index.insert(id, loc);
      if (id >= t.nextId) t.nextId = id + 1;
      for (const [col, idx] of t.secondary) addToIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
      (t.caught ??= []).push([id, loc]); // 다음 INSERT 결과에 실어 다른 워커에도 알린다
    }
  }

  /** 확정된 끝 위치를 바꾸고 저장소에도 알린다 */
  setEnd(t, end) {
    t.end = end;
    if (end !== Infinity) this.storage.limit?.(t.name, end);
  }

  table(name, pos) {
    const t = this.tables[name] ?? this.tableMap.get(String(name).toLowerCase());
    if (!t) throw new SqlError(`테이블 '${name}' 이(가) 없습니다. (있는 테이블: ${Object.keys(this.tables).join(', ')})`, pos);
    return t;
  }

  /**
   * SQL 문자열(여러 문장 가능) 실행 → 문장별 결과 배열
   * 요청 단위 원자성: 중간에 한 문장이라도 실패하면 이 요청이 앞에서 넣은 레코드를 모두 되돌린다.
   *   (되돌리지 않으면 "에러" 응답을 받았는데 앞 문장의 INSERT 는 남아 있어서, 다시 시도하면 두 번 들어간다)
   */
  execute(sql, params = null, flush = true) {
    const statements = typeof sql === 'string' ? parseCached(sql, params) : sql;
    const results = [];
    const marks = new Map(); // 테이블 → 이 요청이 처음 쓰기 전의 { size: 파일 크기, nextId: 다음 id }
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
          this.catchUp(t);
          marks.set(t.name, { size: this.storage.size(t.name), nextId: t.nextId });
        }
        // 이 요청에서 이미 파일 크기를 다시 읽었으면(위) insert 가 또 읽지 않게 한다 (INSERT 마다 시스템 콜 2번 절약)
        results.push(this.insert(st, canRollback));
      }
    } catch (e) {
      for (const [name, mark] of marks) {
        if (this.storage.size(name) !== mark.size) this.rollback(this.tables[name], mark);
      }
      throw e;
    } finally {
      if (flush) this.storage.flush();
    }
    return results;
  }

  /**
   * 이 요청이 넣은 레코드를 되돌린다: 인덱스에서 빼고, 파일을 요청 전 크기로 자른다.
   * 넣은 레코드는 id 가 가장 큰 것들이므로 B+ 트리의 맨 끝에서 하나씩 뺀다 (넣은 개수 × O(log n)).
   * 파일 전체를 다시 읽어 인덱스를 새로 만들지 않는다 — 100만 행 테이블에서 몇 줄 되돌리자고 0.4초를 쓰지 않게.
   */
  rollback(t, mark) {
    const added = t.nextId - mark.nextId;
    // 예상과 다르면(가장 큰 id 가 방금 넣은 것이 아님) 안전하게 파일에서 다시 만든다
    if (added <= 0 || t.index.max() !== t.nextId - 1 || t.index.size < added) {
      this.storage.truncate(t.name, mark.size);
      this.loadIndexes([t.name]);
      return;
    }
    for (let id = t.nextId - 1; id >= mark.nextId; id--) {
      // 보조 인덱스에서도 뺀다. 위치는 넣은 순서대로 쌓였으므로, 뒤에서부터 빼면 항상 목록의 마지막이다
      if (t.secondary.size) {
        const loc = t.index.get(id);
        const line = this.storage.read(t.name, loc);
        for (const [col, idx] of t.secondary) removeFromIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
      }
      t.index.removeMax();
    }
    t.nextId = mark.nextId;
    this.storage.truncate(t.name, mark.size);
    if (t.end !== Infinity) this.setEnd(t, mark.size);
  }

  /** 문장들이 건드리는 테이블과 쓰기 여부 (서버의 락 결정용) */
  static analyze(sql, params = null) {
    if (params === null && sql === Database._lastSql) {
      const cached = Database._lastAnalysis;
      Database._lastStatements = cached.statements;
      return cached;
    }
    const statements = parseCached(sql, params);
    Database._lastStatements = statements;
    let res;
    if (statements.length === 1) {
      const s = statements[0];
      res = {
        statements,
        writes: s.type === 'insert' ? [s.table] : [],
        reads: s.type === 'select' ? [s.table] : [],
      };
    } else {
      const writes = new Set();
      const reads = new Set();
      for (let i = 0; i < statements.length; i++) {
        const s = statements[i];
        if (s.type === 'insert') writes.add(s.table);
        else if (s.type === 'select') reads.add(s.table);
      }
      res = { statements, writes: [...writes], reads: [...reads] };
    }
    if (params === null) {
      Database._lastSql = sql;
      Database._lastAnalysis = res;
    } else {
      Database._lastSql = null;
    }
    return res;
  }

  // ================================================================ INSERT
  insert(st, refreshed = false) {
    const t0 = now();
    const t = this.table(st.table, st.pos);
    if (!refreshed) {
      this.storage.refresh?.(t.name);
      this.catchUp(t);
    }
    let cols, colIdx;
    if (!st.columns) {
      cols = t.defaultCols;
      colIdx = t.defaultColIdx;
    } else {
      cols = st.columns;
      colIdx = new Array(cols.length);
      for (let k = 0; k < cols.length; k++) {
        const lower = cols[k].toLowerCase();
        if (lower === 'id') throw new SqlError('id 는 자동으로 부여되므로 직접 넣을 수 없습니다.', st.pos);
        const i = t.colMap.get(lower);
        if (i === undefined) throw new SqlError(`테이블 '${t.name}' 에 열 '${cols[k]}' 이(가) 없습니다.`, st.pos);
        colIdx[k] = i;
      }
    }
    const ncols = cols.length;
    const totalCols = t.columns.length;
    // 먼저 모든 행을 검사 → 하나라도 틀리면 아무것도 저장하지 않는다 (문장 단위 원자성)
    const prepared = st.rows.map((row, r) => {
      if (row.length !== ncols) throw new SqlError(`${r + 1}번째 행: 열은 ${ncols}개인데 값은 ${row.length}개입니다.`, st.pos);
      const values = new Array(totalCols).fill(null);
      for (let k = 0; k < ncols; k++) {
        const ci = colIdx[k];
        values[ci] = coerce(row[k], t.columns[ci], st.pos);
      }
      return values;
    });
    const ids = new Array(prepared.length);
    const entries = new Array(prepared.length); // [id, 위치] — 스레드 풀에서 다른 워커의 인덱스에 알려 줄 때 사용
    const hasSecondary = t.secondary.size > 0;
    for (let r = 0; r < prepared.length; r++) {
      const values = prepared[r];
      const id = t.nextId++;
      values[0] = id;
      const loc = this.storage.append(t.name, encodeRow(values));
      t.index.insert(id, loc);
      if (hasSecondary) for (const [col, idx] of t.secondary) addToIndex(idx, values[col], loc);
      ids[r] = id;
      entries[r] = [id, loc];
    }
    if (t.end !== Infinity) this.setEnd(t, this.storage.size(t.name));
    // 방금 따라잡은(밖에서 덧붙인) 레코드도 함께 알린다
    const caught = t.caught;
    t.caught = null;
    const outEntries = caught ? caught.concat(entries) : entries;
    if (outEntries.length > 0 && t.end !== Infinity) outEntries[outEntries.length - 1].push(t.end);
    return { type: 'insert', table: t.name, count: ids.length, ids, ms: now() - t0, entries: outEntries, end: t.end };
  }

  /** 다른 스레드가 넣은 레코드를 이 인스턴스의 인덱스에도 반영 (Phase 3 스레드 풀) */
  applyIndex(table, entries, end = null) {
    const t = this.table(table);
    // 이미 확정된 구간 안의 위치가 새로 왔다 = 그 자리가 다시 쓰였다 (롤백 뒤) → 버퍼 풀을 믿지 않는다
    if (t.end !== Infinity && entries.some(([, loc]) => loc < t.end)) this.storage.dropCache?.(t.name);
    const fresh = [];
    for (const [id, loc] of entries) {
      if (!t.index.has(id)) {
        t.index.insert(id, loc);
        fresh.push(loc);
      }
      if (id >= t.nextId) t.nextId = id + 1;
    }
    // 확정된 끝 = 방금 알게 된 레코드 중 가장 뒤에 있는 줄의 끝
    if (t.end !== Infinity && entries.length) {
      const resolvedEnd = typeof end === 'number' ? end : entries[entries.length - 1]?.[2];
      if (typeof resolvedEnd === 'number' && resolvedEnd >= t.end) {
        this.setEnd(t, resolvedEnd);
      } else {
        let last = -1;
        for (const [, loc] of entries) if (loc > last) last = loc;
        if (last >= t.end) {
          this.setEnd(t, last + byteLength(this.storage.read(t.name, last)) + 1);
        }
      }
    }
    if (t.secondary.size && fresh.length) {
      const add = (line, loc) => {
        for (const [col, idx] of t.secondary) addToIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
      };
      let k = 0;
      if (fresh.length > RANGE_SINGLE_READS) {
        for (const [loc, line] of this.storage.scan(t.name, fresh[0], true)) {
          if (loc !== fresh[k]) break;
          add(line, loc);
          if (++k === fresh.length) break;
        }
      }
      for (; k < fresh.length; k++) add(this.storage.read(t.name, fresh[k]), fresh[k]);
    }
  }

  /** col 번째 열의 해시 인덱스 (없으면 파일을 한 번 훑어 만든다) */
  secondaryIndex(t, col) {
    let idx = t.secondary.get(col);
    if (idx) return { idx, built: 0 };
    idx = new Map();
    let built = 0;
    const onLine = (loc, line) => {
      if (!line) return;
      built++;
      addToIndex(idx, typedValue(decodeField(line, col), col, t.numeric), loc);
    };
    if (typeof this.storage.forEachLine === 'function') this.storage.forEachLine(t.name, 0, false, onLine);
    else for (const [loc, line] of this.storage.scan(t.name)) onLine(loc, line);
    // 인덱스 수에 상한을 둔다: 열마다 한 번씩만 조회해도 인덱스가 끝없이 쌓이지 않게, 가장 오래 안 쓴 것부터 버린다.
    // (인덱스가 많을수록 INSERT 마다 고칠 것도 늘어난다 — 읽기는 빨라지고 쓰기는 느려지는 맞교환)
    // 스키마에 적어 둔 인덱스는 세지도 버리지도 않는다
    const auto = () => [...t.secondary.keys()].filter((c) => !t.declared.has(c));
    if (!t.declared.has(col)) for (let a = auto(); a.length >= MAX_SECONDARY; a = auto()) t.secondary.delete(a[0]);
    t.secondary.set(col, idx);
    return { idx, built };
  }

  /** 방금 쓴 인덱스를 "가장 최근에 쓴 것" 으로 (Map 은 넣은 순서를 기억한다 → 맨 앞이 가장 오래 안 쓴 것) */
  touchIndex(t, col) {
    const idx = t.secondary.get(col);
    if (!idx) return;
    t.secondary.delete(col);
    t.secondary.set(col, idx);
  }

  // ================================================================ SELECT
  select(st) {
    const t0 = now();
    const t = this.table(st.table, st.pos);
    let outCols, outColNames;
    if (st.columns === '*') {
      outCols = t.allColIdx;
      outColNames = t.allColNames;
    } else {
      outCols = new Array(st.columns.length);
      outColNames = new Array(st.columns.length);
      for (let j = 0; j < st.columns.length; j++) {
        const i = t.colMap.get(st.columns[j].toLowerCase());
        if (i === undefined) throw new SqlError(`테이블 '${t.name}' 에 열 '${st.columns[j]}' 이(가) 없습니다.`, st.pos);
        outCols[j] = i;
        outColNames[j] = t.columns[i].name;
      }
    }
    const conds = new Array(st.where.length);
    for (let j = 0; j < st.where.length; j++) {
      const c = st.where[j];
      const i = t.colMap.get(c.column.toLowerCase());
      if (i === undefined) throw new SqlError(`테이블 '${t.name}' 에 열 '${c.column}' 이(가) 없습니다.`, st.pos);
      // 비교에서는 INT 열과 실수(2.5)를 비교해도 된다 (저장할 때만 정수 검사)
      const col = t.columns[i];
      const value = c.value.kind === 'null' ? null : col.type === 'INT' && c.value.kind === 'number' ? c.value.value : coerce(c.value, col, st.pos);
      conds[j] = { i, op: c.op, value, column: col.name };
    }

    const plan = choosePlan(conds, t, this.autoIndex);
    const rows = [];
    let scanned = 0;
    const asked = st.limit ?? Infinity;
    const limit = Math.min(asked, this.maxRows); // 서버가 정한 상한을 넘지 않게
    // 열마다 숫자로 바꿔야 하는지 미리 계산 (행마다 열 형식을 다시 보지 않게)
    const numeric = t.numeric;
    const nconds = conds.length;
    const nOut = outCols.length;
    const selectAll = st.columns === '*';
    const numericCols = selectAll ? t.numericCols : null;
    const allIdOnly = nconds > 0 && conds.every((c) => c.i === 0 && c.op !== '!=' && c.value !== null);
    const coveringIdOnly = allIdOnly && !selectAll && outCols.every((ci) => ci === 0);
    const pushRaw = (raw) => {
      if (selectAll && raw.length === nOut) {
        for (let k = 0; k < numericCols.length; k++) {
          const j = numericCols[k];
          if (raw[j] != null) raw[j] = Number(raw[j]);
        }
        rows.push(raw);
        return;
      }
      const rec = new Array(nOut);
      for (let j = 0; j < nOut; j++) {
        const ci = outCols[j];
        rec[j] = typedValue(raw[ci], ci, numeric);
      }
      rows.push(rec);
    };
    // 전체/해시 탐색처럼 탈락이 많은 경로는 조건 열만 먼저 꺼내 비교하고,
    // 인덱스 조회/범위 조회처럼 대부분 통과하는 경로는 한 번만 decodeRow 해 중복 파싱을 피한다
    const take = (line) => {
      scanned++;
      for (let k = 0; k < nconds; k++) {
        const c = conds[k];
        if (c.op === '=' && typeof c.value === 'string' && !numeric[c.i]) {
          const eq = fieldEqualsPlain(line, c.i, c.value);
          if (eq !== null) {
            if (!eq) return;
            continue;
          }
        }
        if (!test(typedValue(decodeField(line, c.i), c.i, numeric), c.op, c.value)) return;
      }
      pushRaw(decodeRow(line));
    };
    const takeDirect = (line, skipCheck = false) => {
      scanned++;
      const raw = decodeRow(line);
      if (!skipCheck) {
        for (let k = 0; k < nconds; k++) {
          const c = conds[k];
          if (!test(typedValue(raw[c.i], c.i, numeric), c.op, c.value)) return;
        }
      }
      pushRaw(raw);
    };
    if (limit > 0) {
      if (plan.type === 'index-lookup') {
        const loc = plan.empty ? undefined : t.index.get(plan.key);
        if (loc !== undefined) {
          if (coveringIdOnly) {
            scanned++;
            rows.push(nOut === 1 ? [plan.key] : new Array(nOut).fill(plan.key));
          } else {
            // 조건이 id = ? 하나뿐일 때만 다시 검사하지 않는다. (id = 3 AND id > 5 처럼 다른 id 조건이 함께 있으면 찾은 줄도 검사해야 한다)
            takeDirect(this.storage.read(t.name, loc), nconds === 1);
          }
        }
      } else if (plan.type === 'index-range') {
        if (!plan.empty) {
          if (coveringIdOnly && typeof t.index.forEachRange === 'function') {
            t.index.forEachRange(plan.lo, plan.hi, (id) => {
              scanned++;
              rows.push(nOut === 1 ? [id] : new Array(nOut).fill(id));
              if (rows.length >= limit) return false;
            });
          } else {
            // 처음 몇 개는 한 줄씩 읽고(작은 범위 · LIMIT 은 이게 빠르다), 범위가 길면 덩어리로 이어 읽는다.
            // id 는 넣은 순서대로 커지므로 id 범위 = 파일에서 이어진 구간 → 레코드마다 read() 를 부르지 않아도 된다.
            let n = 0;
            let cursor = null; // FileStorage 커서(할당 0) 또는 일반 scan 제너레이터, false = 못 씀
            const useCursor = typeof this.storage.openCursor === 'function';
            const step = (_id, loc) => {
              let line = null;
              if (cursor === null && ++n > RANGE_SINGLE_READS) {
                cursor = useCursor ? this.storage.openCursor(t.name, loc, true) : this.storage.scan(t.name, loc, true);
              }
              if (cursor) {
                if (useCursor) {
                  line = cursor.nextAt(loc);
                  if (line === null) cursor = false;
                } else {
                  const next = cursor.next();
                  if (!next.done && next.value[0] === loc) line = next.value[1];
                  else cursor = false; // 파일 순서와 id 순서가 다르면(손으로 고친 파일 등) 한 줄씩 읽기로 돌아간다
                }
              }
              takeDirect(line ?? this.storage.read(t.name, loc), allIdOnly);
              if (rows.length >= limit) return false;
            };
            if (typeof t.index.forEachRange === 'function') {
              t.index.forEachRange(plan.lo, plan.hi, step);
            } else {
              for (const [, loc] of t.index.range(plan.lo, plan.hi)) {
                if (step(0, loc) === false) break;
              }
            }
          }
        }
      } else if (plan.type === 'hash-index') {
        let built = 0;
        let hit;
        if (conds.length === 1) {
          const c = conds[0];
          let idx = t.secondary.get(c.i);
          if (!idx) {
            const made = this.secondaryIndex(t, c.i);
            built = made.built;
            idx = made.idx;
          }
          this.touchIndex(t, c.i);
          hit = idx.get(indexKey(c.value));
        } else {
          // = 조건이 여러 열에 걸려 있으면 "가장 적게 걸리는" 열의 인덱스를 쓴다 (선택도).
          //   age = 25 AND email = 'a@b.c' 에서 age 로 찾으면 수천 줄을 읽고 걸러야 하지만, email 로 찾으면 한 줄이다.
          const eqs = conds.filter((c) => c.op === '=' && c.value !== null && (this.autoIndex || t.declared.has(c.i)));
          const count = (h) => (h === undefined ? 0 : typeof h === 'number' ? 1 : h.length);
          let best = null;
          const consider = (c, idx) => {
            const h = idx.get(indexKey(c.value));
            if (!best || count(h) < best.n) best = { c, hit: h, n: count(h) };
          };
          // 1) 이미 만들어 둔 인덱스 중에서 고른다 (새로 만들지 않아도 되면 만들지 않는다)
          for (const c of eqs) if (t.secondary.has(c.i)) consider(c, t.secondary.get(c.i));
          // 2) 쓸 인덱스가 없거나, 있는 것으로는 너무 많이 걸리면 → 아직 인덱스가 없는 조건 열로 하나 더 만들어 비교한다
          for (const c of eqs) {
            if (best && best.n <= UNSELECTIVE) break;
            if (t.secondary.has(c.i)) continue;
            const made = this.secondaryIndex(t, c.i);
            built += made.built;
            consider(c, made.idx);
          }
          this.touchIndex(t, best.c.i);
          plan.i = best.c.i;
          plan.column = best.c.column;
          plan.key = best.c.value;
          plan.reason = hashReason(best.c.column);
          hit = best.hit;
        }
        if (built) plan.built = built; // 인덱스를 만드느라 읽은 줄 수 (처음 한 번). 조회가 읽은 줄 수(scanned)와 따로 센다
        if (typeof hit === 'number') take(this.storage.read(t.name, hit));
        else if (hit) {
          for (const loc of hit) {
            take(this.storage.read(t.name, loc));
            if (rows.length >= limit) break;
          }
        }
      } else {
        const probe = typeof this.storage.scanFor === 'function' ? probeText(conds, numeric) : null;
        const numCond = probe === null && typeof this.storage.scanNum === 'function' ? probeNumber(conds, numeric) : null;
        if (probe !== null || numCond !== null) {
          const picked = probe !== null
            ? this.storage.scanFor(t.name, probe)
            : this.storage.scanNum(t.name, numCond.i, numCond.pred ?? ((a) => a >= numCond.lo && a <= numCond.hi), numCond.lo, numCond.hi);
          let stoppedAt = -1, stoppedLines = 0;
          for (const [line, loc, lines] of picked) {
            take(line);
            if (rows.length >= limit) { stoppedAt = loc; stoppedLines = lines ?? 0; break; }
          }
          scanned = stoppedAt === -1 ? Math.max(scanned, t.index.size) : stoppedLines || this.storage.linesBefore(t.name, stoppedAt) + 1;
        } else if (typeof this.storage.forEachLine === 'function') {
          this.storage.forEachLine(t.name, 0, false, (_loc, line) => {
            if (!line) return;
            take(line);
            if (rows.length >= limit) return false;
          });
        } else {
          for (const [, line] of this.storage.scan(t.name)) {
            if (!line) continue;
            take(line);
            if (rows.length >= limit) break;
          }
        }
      }
    }
    return {
      type: 'select',
      table: t.name,
      columns: outColNames,
      rows, // limit 에 닿으면 그 자리에서 멈추므로 더 많이 담기지 않는다 (다시 잘라 복사할 필요가 없다)
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

const hashReason = (column) => `WHERE ${column} = ? → 해시 인덱스로 그 줄만 읽기 (처음 한 번은 파일을 훑어 만든다)`;
const RANGE_SINGLE_READS = 8;
const MAX_SECONDARY = 4;  // 테이블 하나에 두는 해시 인덱스 수의 상한
const UNSELECTIVE = 64;   // 인덱스로 찾은 줄이 이보다 많으면 "잘 못 고르는 열" 로 보고 다른 조건 열도 시도한다
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

/** 해시 인덱스에서 (값 → 위치) 하나를 뺀다 (롤백용). 없으면 아무 일도 하지 않는다 */
function removeFromIndex(idx, value, loc) {
  if (value == null) return;
  const key = indexKey(value);
  const hit = idx.get(key);
  if (hit === undefined) return;
  if (typeof hit === 'number') {
    if (hit === loc) idx.delete(key);
    return;
  }
  const i = hit.lastIndexOf(loc);
  if (i !== -1) hit.splice(i, 1);
  if (hit.length === 1) idx.set(key, hit[0]);
  else if (hit.length === 0) idx.delete(key);
}

/** id 조건이 있으면 인덱스를 쓴다 */
function choosePlan(conds, t, autoIndex = false) {
  if (conds.length === 0) return { type: 'full-scan', reason: '조건 없음 → 전체 읽기' };
  if (conds.length === 1) {
    const c = conds[0];
    if (c.i === 0 && c.op !== '!=' && c.value !== null) {
      if (c.op === '=') return { type: 'index-lookup', key: c.value, empty: false, reason: 'WHERE id = ? → B+ 트리로 바로 찾기' };
      let lo = -Infinity, hi = Infinity;
      if (c.op === '>') lo = Math.floor(c.value) + 1;
      else if (c.op === '>=') lo = Math.ceil(c.value);
      else if (c.op === '<') hi = Math.ceil(c.value) - 1;
      else if (c.op === '<=') hi = Math.floor(c.value);
      return { type: 'index-range', lo, hi, empty: lo > hi, reason: 'id 범위 조건 → B+ 트리 리프를 따라 범위만 읽기' };
    }
    if (c.op === '=' && c.value !== null && (autoIndex || t.declared.has(c.i))) {
      return { type: 'hash-index', i: c.i, column: c.column, key: c.value, reason: hashReason(c.column) };
    }
    return { type: 'full-scan', reason: '인덱스가 없는 열 조건 → 처음부터 끝까지 비교' };
  }
  const idConds = conds.filter((c) => c.i === 0 && c.op !== '!=' && c.value !== null);
  const eq = idConds.find((c) => c.op === '=');
  if (eq) {
    // id = 3 AND id = 4, id = 5 AND id > 10 같은 모순도 처리: 다른 id 조건을 만족하지 못하면 결과 없음
    const empty = idConds.some((c) => !test(eq.value, c.op, c.value));
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
  {
    const c = conds.find((x) => x.op === '=' && x.value !== null && (autoIndex || t.declared.has(x.i)));
    if (c) return { type: 'hash-index', i: c.i, column: c.column, key: c.value, reason: hashReason(c.column) };
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

/**
 * 같은 SQL 글자열은 한 번만 파싱한다 (Prepared Statement 가 파싱을 한 번으로 줄이는 것과 같은 생각).
 * 파싱 결과(AST)는 실행하면서 바뀌지 않으므로 여러 번 실행해도 된다.
 * ? 자리에 값을 넣는 요청은 값이 파싱 중에 들어가므로 캐시하지 않는다. 긴 SQL(대량 INSERT)도 담지 않는다.
 */
const PARSED = new Map();
const PARSED_MAX = 512;
const SEEN = new Array(256).fill(''); // 최근에 한 번 본 SQL (두 번째에 캐시에 담기 위한 메모)
function parseCached(sql, params) {
  if (params != null || sql.length > 2048) return parse(sql, params);
  let st = PARSED.get(sql);
  if (st === undefined) {
    st = parse(sql, null);
    // 처음 본 SQL 은 담지 않는다: 값이 SQL 안에 적혀 있어 매번 달라지는 요청(WHERE id = 123)은 다시 올 일이 없는데,
    // 그것까지 담으면 넣고 버리는 일만 늘어서 파싱보다 캐시 관리가 더 든다.
    // 바로 전에 같은 자리(SEEN)에서 본 SQL 이 다시 오면 그때 담는다.
    const slot = (sql.length * 31 + sql.charCodeAt(sql.length - 1)) & (SEEN.length - 1);
    if (SEEN[slot] === sql) {
      if (PARSED.size >= PARSED_MAX) PARSED.delete(PARSED.keys().next().value); // 가장 먼저 담은 것부터 버린다
      PARSED.set(sql, st);
    } else SEEN[slot] = sql;
  }
  return st;
}

/**
 * 선형 탐색에서 파일의 바이트로 먼저 찾아볼 글자열: 글자(TEXT) 열의 = 조건 값 중 가장 긴 것.
 * 따옴표나 이스케이프 없이 그대로 적히는 값만 쓴다 (그래야 파일에 그 글자 그대로 들어 있다). 없으면 null.
 * 숫자 열은 쓰지 않는다: 25 를 찾으려면 "25" 가 들어 있는 줄을 다 봐야 해서 거르는 효과가 없다.
 */
function probeText(conds, numeric) {
  let best = null;
  for (const c of conds) {
    if (c.op !== '=' || numeric[c.i] || c.i === 0 || !isPlainText(c.value) || c.value.length < 2) continue;
    if (best === null || c.value.length > best.length) best = c.value;
  }
  return best;
}

/** 선형 탐색에서 바이트로 먼저 비교할 숫자 열 조건: = 을 먼저, 없으면 크기 비교. 같은 열의 다른 조건으로 범위(lo, hi)를 좁힌다. 없으면 null */
function probeNumber(conds, numeric) {
  let best = null;
  for (const c of conds) {
    if (!numeric[c.i] || typeof c.value !== 'number' || c.op === '!=') continue;
    if (c.op === '=') { best = c; break; }
    best ??= c;
  }
  if (!best) return null;
  let lo = -Infinity, hi = Infinity;
  const colConds = [];
  for (const c of conds) {
    if (c.i !== best.i || typeof c.value !== 'number' || c.op === '!=') continue;
    if (c.op === '=') { lo = Math.max(lo, c.value); hi = Math.min(hi, c.value); }
    else if (c.op === '>') { lo = Math.max(lo, c.value); colConds.push(c); }
    else if (c.op === '>=') lo = Math.max(lo, c.value);
    else if (c.op === '<') { hi = Math.min(hi, c.value); colConds.push(c); }
    else if (c.op === '<=') hi = Math.min(hi, c.value);
  }
  const pred = colConds.length === 0 ? null : (a) => {
    for (let k = 0; k < colConds.length; k++) if (!test(a, colConds[k].op, colConds[k].value)) return false;
    return true;
  };
  return { i: best.i, lo, hi, pred };
}

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
