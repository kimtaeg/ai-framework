/**
 * SQL 처리기 1단계: 토크나이저 + 파서  (SQL 문자열 → 구조화된 AST)
 * ------------------------------------------------------------------
 *   입력 (SQL) → [토큰화] → 토큰 목록 → [파싱] → AST → (engine.js 에서) 실행 → 저장/조회
 *
 * 지원 문법
 *   INSERT INTO 테이블 [(열, ...)] VALUES (값, ...) [, (값, ...)] ;
 *   SELECT * | 열, ... FROM 테이블 [WHERE 조건 [AND 조건 ...]] [LIMIT n | LIMIT ?] ;
 *     조건: 열 (= | != | <> | < | <= | > | >=) 값     |   열 BETWEEN 값 AND 값
 *   값: 정수, 실수, '문자열' (작은따옴표 두 개 '' 는 따옴표 하나), NULL, ? (자리표시자 — 값은 params 로 따로 준다)
 *       ? 를 쓰면 값이 SQL 문자열에 섞이지 않는다 → 값 안의 따옴표로 문장을 바꾸는 SQL 인젝션이 통하지 않는다
 *   주석: -- 한 줄 주석,  /* 여러 줄 *\/
 *   여러 문장은 ; 로 구분. 키워드는 대소문자 구분 없음.
 *
 * 에러는 "몇째 줄, 몇째 칸" 을 함께 알려 준다.
 */

export class SqlError extends Error {
  constructor(message, pos) {
    super(pos ? `${message} (${pos.line}행 ${pos.col}열)` : message);
    this.name = 'SqlError';
    this.pos = pos ?? null;
  }
}

export const KEYWORDS = new Set(['INSERT', 'INTO', 'VALUES', 'SELECT', 'FROM', 'WHERE', 'AND', 'LIMIT', 'NULL', 'BETWEEN']);
const WS_RE = /\s+/y;
const NUM_RE = /\d*\.?\d+(?:[eE][+-]?\d+)?/y;
const BAD_NUM_RE = /[\w.]+/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const SINGLE_SYMBOLS = new Set(['(', ')', ',', ';', '*', '=', '-', '?']);
const COMPARE_OPS = new Set(['=', '!=', '<>', '<', '<=', '>', '>=']);

/**
 * @returns {Array<{ type: 'keyword'|'ident'|'number'|'string'|'symbol'|'eof', value: string, pos: {line, col, offset} }>}
 */
export function tokenize(src) {
  const tokens = [];
  const len = src.length;
  let i = 0, line = 1, col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  // 다음 줄바꿈 위치를 기억해 둔다. 매번 indexOf('\n') 로 찾으면 줄바꿈 없는 긴 SQL(대량 INSERT)에서
  // 토큰마다 SQL 끝까지 훑게 되어 길이의 제곱으로 느려진다 (1000행 INSERT 파싱이 약 2.6배 느렸다)
  let nextNl = src.indexOf('\n');
  const advanceRange = (from, to) => {
    if (nextNl !== -1 && nextNl < from) nextNl = src.indexOf('\n', from); // advance() 가 줄바꿈을 지나간 뒤
    let cur = from;
    while (nextNl !== -1 && nextNl < to) {
      line++;
      col = 1;
      cur = nextNl + 1;
      nextNl = src.indexOf('\n', cur);
    }
    col += to - cur;
  };

  while (i < len) {
    const code = src.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13) || code === 160) {
      WS_RE.lastIndex = i;
      const m = WS_RE.exec(src);
      const end = WS_RE.lastIndex;
      advanceRange(i, end);
      i = end;
      continue;
    }
    if (code === 45 && src.charCodeAt(i + 1) === 45) { // --
      const nl = src.indexOf('\n', i + 2);
      if (nl === -1) { col += len - i; i = len; break; }
      line++;
      col = 1;
      i = nl + 1;
      continue;
    }
    if (code === 47 && src.charCodeAt(i + 1) === 42) { // /*
      const start = { line, col, offset: i };
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new SqlError('주석(/* */)이 닫히지 않았습니다.', start);
      advanceRange(i, end + 2);
      i = end + 2;
      continue;
    }
    const p = { line, col, offset: i };
    if (code === 39) { // '
      const next = src.indexOf("'", i + 1);
      if (next === -1) throw new SqlError('문자열의 따옴표가 닫히지 않았습니다.', p);
      let val;
      if (src.charCodeAt(next + 1) !== 39) {
        val = src.slice(i + 1, next);
        advanceRange(i, next + 1);
        i = next + 1;
      } else {
        advance();
        let s = '';
        for (;;) {
          if (i >= src.length) throw new SqlError('문자열의 따옴표가 닫히지 않았습니다.', p);
          if (src[i] === "'") {
            if (src[i + 1] === "'") { s += "'"; advance(2); continue; }
            advance();
            break;
          }
          s += src[i];
          advance();
        }
        val = s;
      }
      tokens.push({ type: 'string', value: val, pos: p });
      continue;
    }
    if ((code >= 48 && code <= 57) || (code === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      const numEnd = NUM_RE.lastIndex;
      const nextCode = src.charCodeAt(numEnd);
      if ((nextCode >= 65 && nextCode <= 90) || (nextCode >= 97 && nextCode <= 122) || nextCode === 95) {
        BAD_NUM_RE.lastIndex = i;
        throw new SqlError(`잘못된 숫자 '${BAD_NUM_RE.exec(src)[0]}'`, p);
      }
      const val = m[0];
      tokens.push({ type: 'number', value: val, pos: p });
      i = numEnd;
      col += val.length;
      continue;
    }
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(src);
      const val = m[0];
      const up = val.toUpperCase();
      tokens.push(KEYWORDS.has(up) ? { type: 'keyword', value: up, pos: p } : { type: 'ident', value: val, pos: p });
      i = IDENT_RE.lastIndex;
      col += val.length;
      continue;
    }
    const c = src[i];
    if (c === '<') {
      const nc = src.charCodeAt(i + 1);
      const sym = nc === 61 ? '<=' : nc === 62 ? '<>' : '<';
      tokens.push({ type: 'symbol', value: sym, pos: p });
      i += sym.length;
      col += sym.length;
      continue;
    }
    if (c === '>') {
      const sym = src.charCodeAt(i + 1) === 61 ? '>=' : '>';
      tokens.push({ type: 'symbol', value: sym, pos: p });
      i += sym.length;
      col += sym.length;
      continue;
    }
    if (c === '!' && src.charCodeAt(i + 1) === 61) {
      tokens.push({ type: 'symbol', value: '!=', pos: p });
      i += 2;
      col += 2;
      continue;
    }
    if (SINGLE_SYMBOLS.has(c)) {
      tokens.push({ type: 'symbol', value: c, pos: p });
      i++;
      col++;
      continue;
    }
    if (/\s/.test(c)) {
      WS_RE.lastIndex = i;
      const end = WS_RE.exec(src) ? WS_RE.lastIndex : i + 1;
      advanceRange(i, end);
      i = end;
      continue;
    }
    throw new SqlError(`알 수 없는 문자 '${c}'`, p);
  }
  tokens.push({ type: 'eof', value: '', pos: { line, col, offset: i } });
  return tokens;
}

/**
 * 여러 문장을 파싱 → AST 배열
 * @param {string} src
 * @param {Array<number|string|null>} [params]  ? 자리에 순서대로 들어갈 값
 */
export function parse(src, params = null) {
  if (params !== null && !Array.isArray(params)) throw new SqlError('params 는 배열이어야 합니다.');
  const tokens = tokenize(src);
  let k = 0;
  let used = 0; // 지금까지 쓴 params 개수
  const bind = (pos) => {
    if (!params) throw new SqlError("'?' 자리에 넣을 값(params)이 없습니다.", pos);
    if (used >= params.length) throw new SqlError(`'?' 는 ${used + 1}개 이상인데 params 는 ${params.length}개입니다.`, pos);
    const v = params[used++];
    if (v === null) return { kind: 'null', value: null };
    if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'number', value: v };
    if (typeof v === 'string') return { kind: 'string', value: v };
    throw new SqlError(`params 의 ${used}번째 값은 숫자, 문자열, null 중 하나여야 합니다.`, pos);
  };
  const peek = () => tokens[k];
  const next = () => tokens[k++];
  const is = (type, value) => peek().type === type && (value === undefined || peek().value === value);
  const desc = (t) => (t.type === 'eof' ? '문장의 끝' : `'${t.value}'`);
  const expect = (type, value, what) => {
    if (!is(type, value)) throw new SqlError(`${what ?? `'${value}'`} 이(가) 필요한데 ${desc(peek())} 이(가) 있습니다.`, peek().pos);
    return next();
  };
  const ident = (what) => {
    if (is('keyword')) throw new SqlError(`${what} 자리에 예약어 '${peek().value}' 를 쓸 수 없습니다.`, peek().pos);
    return expect('ident', undefined, what).value;
  };

  function value() {
    const t = peek();
    if (is('symbol', '?')) return next(), bind(t.pos);
    if (is('symbol', '-')) {
      next();
      const n = expect('number', undefined, '숫자');
      return { kind: 'number', value: -Number(n.value) };
    }
    if (t.type === 'number') return next(), { kind: 'number', value: Number(t.value) };
    if (t.type === 'string') return next(), { kind: 'string', value: t.value };
    if (is('keyword', 'NULL')) return next(), { kind: 'null', value: null };
    throw new SqlError(`값(숫자, '문자열', NULL)이 필요한데 ${desc(t)} 이(가) 있습니다.`, t.pos);
  }

  function insert(start) {
    expect('keyword', 'INTO');
    const table = ident('테이블 이름');
    let columns = null;
    if (is('symbol', '(')) {
      next();
      columns = [ident('열 이름')];
      while (is('symbol', ',')) { next(); columns.push(ident('열 이름')); }
      expect('symbol', ')');
      for (let a = 0; a < columns.length; a++) {
        for (let b = a + 1; b < columns.length; b++) {
          if (columns[a] === columns[b]) throw new SqlError(`열 '${columns[b]}' 이(가) 두 번 나왔습니다.`, start);
        }
      }
    }
    expect('keyword', 'VALUES');
    const rows = [];
    do {
      if (rows.length) next(); // ,
      const rowPos = peek().pos;
      expect('symbol', '(');
      const row = [value()];
      while (is('symbol', ',')) { next(); row.push(value()); }
      expect('symbol', ')');
      if (columns && row.length !== columns.length) throw new SqlError(`열은 ${columns.length}개인데 값은 ${row.length}개입니다.`, rowPos);
      rows.push(row);
    } while (is('symbol', ','));
    return { type: 'insert', table, columns, rows, pos: start };
  }

  function parseCondition(out) {
    const column = ident('열 이름');
    if (is('keyword', 'BETWEEN')) {
      next();
      const lo = value();
      expect('keyword', 'AND');
      const hi = value();
      out.push({ column, op: '>=', value: lo }, { column, op: '<=', value: hi });
      return;
    }
    const t = peek();
    if (t.type !== 'symbol' || !COMPARE_OPS.has(t.value)) throw new SqlError(`비교 연산자(=, !=, <, <=, >, >=)가 필요한데 ${desc(t)} 이(가) 있습니다.`, t.pos);
    next();
    out.push({ column, op: t.value === '<>' ? '!=' : t.value, value: value() });
  }

  function select(start) {
    let columns;
    if (is('symbol', '*')) { next(); columns = '*'; }
    else {
      columns = [ident('열 이름')];
      while (is('symbol', ',')) { next(); columns.push(ident('열 이름')); }
    }
    expect('keyword', 'FROM');
    const table = ident('테이블 이름');
    const where = [];
    if (is('keyword', 'WHERE')) {
      next();
      parseCondition(where);
      while (is('keyword', 'AND')) { next(); parseCondition(where); }
    }
    let limit = null;
    if (is('keyword', 'LIMIT')) {
      next();
      const t = peek();
      if (is('symbol', '?')) {
        next();
        const v = bind(t.pos); // LIMIT ? 도 다른 값 자리처럼 params 에서
        if (v.kind !== 'number') throw new SqlError('LIMIT 은 0 이상의 정수여야 합니다.', t.pos);
        limit = v.value;
      } else limit = Number(expect('number', undefined, 'LIMIT 개수').value);
      if (!Number.isInteger(limit) || limit < 0) throw new SqlError('LIMIT 은 0 이상의 정수여야 합니다.', t.pos);
    }
    return { type: 'select', table, columns, where, limit, pos: start };
  }

  const statements = [];
  while (!is('eof')) {
    if (is('symbol', ';')) { next(); continue; } // 빈 문장
    const t = next();
    let stmt;
    if (t.type === 'keyword' && t.value === 'INSERT') stmt = insert(t.pos);
    else if (t.type === 'keyword' && t.value === 'SELECT') stmt = select(t.pos);
    else throw new SqlError(`지원하지 않는 문장입니다: ${desc(t)} (INSERT, SELECT 만 지원)`, t.pos);
    stmt.text = src.slice(t.pos.offset, peek().pos.offset).trim();
    statements.push(stmt);
    if (!is('eof')) expect('symbol', ';', "문장 끝의 ';'");
  }
  if (params && used !== params.length) throw new SqlError(`params 는 ${params.length}개인데 '?' 는 ${used}개입니다.`);
  return statements;
}
