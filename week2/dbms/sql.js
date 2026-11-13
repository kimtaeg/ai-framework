/**
 * SQL 처리기 1단계: 토크나이저 + 파서  (SQL 문자열 → 구조화된 AST)
 * ------------------------------------------------------------------
 *   입력 (SQL) → [토큰화] → 토큰 목록 → [파싱] → AST → (engine.js 에서) 실행 → 저장/조회
 *
 * 지원 문법
 *   INSERT INTO 테이블 [(열, ...)] VALUES (값, ...) [, (값, ...)] ;
 *   SELECT * | 열, ... FROM 테이블 [WHERE 조건 [AND 조건 ...]] [LIMIT n] ;
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
const SYMBOLS = ['<=', '>=', '!=', '<>', '(', ')', ',', ';', '*', '=', '<', '>', '-', '?'];

/**
 * @returns {Array<{ type: 'keyword'|'ident'|'number'|'string'|'symbol'|'eof', value: string, pos: {line, col, offset} }>}
 */
export function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const pos = () => ({ line, col, offset: i });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { advance(); continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') advance(); continue; }
    if (c === '/' && src[i + 1] === '*') {
      const start = pos();
      advance(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance();
      if (i >= src.length) throw new SqlError('주석(/* */)이 닫히지 않았습니다.', start);
      advance(2);
      continue;
    }
    const p = pos();
    if (c === "'") {
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
      tokens.push({ type: 'string', value: s, pos: p });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (/[A-Za-z_]/.test(src[i + m[0].length] ?? '')) throw new SqlError(`잘못된 숫자 '${src.slice(i).match(/^[\w.]+/)[0]}'`, p);
      tokens.push({ type: 'number', value: m[0], pos: p });
      advance(m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      const up = m[0].toUpperCase();
      tokens.push(KEYWORDS.has(up) ? { type: 'keyword', value: up, pos: p } : { type: 'ident', value: m[0], pos: p });
      advance(m[0].length);
      continue;
    }
    const sym = SYMBOLS.find((s) => src.startsWith(s, i));
    if (sym) {
      tokens.push({ type: 'symbol', value: sym, pos: p });
      advance(sym.length);
      continue;
    }
    throw new SqlError(`알 수 없는 문자 '${c}'`, p);
  }
  tokens.push({ type: 'eof', value: '', pos: pos() });
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
      const dup = columns.find((c, i) => columns.indexOf(c) !== i);
      if (dup) throw new SqlError(`열 '${dup}' 이(가) 두 번 나왔습니다.`, start);
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

  function condition() {
    const column = ident('열 이름');
    if (is('keyword', 'BETWEEN')) {
      next();
      const lo = value();
      expect('keyword', 'AND');
      const hi = value();
      return [{ column, op: '>=', value: lo }, { column, op: '<=', value: hi }];
    }
    const t = peek();
    if (t.type !== 'symbol' || !['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) throw new SqlError(`비교 연산자(=, !=, <, <=, >, >=)가 필요한데 ${desc(t)} 이(가) 있습니다.`, t.pos);
    next();
    return [{ column, op: t.value === '<>' ? '!=' : t.value, value: value() }];
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
      where.push(...condition());
      while (is('keyword', 'AND')) { next(); where.push(...condition()); }
    }
    let limit = null;
    if (is('keyword', 'LIMIT')) {
      next();
      const t = expect('number', undefined, 'LIMIT 개수');
      limit = Number(t.value);
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
