/**
 * 저장 형식 + 메모리 저장소 (브라우저/테스트용)
 * ------------------------------------------------------------------
 *  테이블 하나 = 파일 하나. 한 줄 = 레코드 하나 (CSV 비슷한 형식)
 *     1,김정글,25,jungle@ex.com
 *     2,"이, 리액트",30,\N            ← 쉼표·따옴표가 있으면 "..." 로 감싸고, NULL 은 \N
 *  줄바꿈이 값 안에 있으면 \n 으로 바꿔 저장 → "한 줄 = 한 레코드" 가 항상 지켜짐
 *  → 레코드의 시작 위치(바이트 offset)만 알면 그 줄 하나만 읽을 수 있다 (B+ 트리 인덱스가 이 위치를 기억)
 *
 *  저장소 인터페이스 (engine.js 가 쓰는 것)
 *    schema()                    → { 테이블: { columns: [{ name, type: 'INT'|'TEXT' }] } }
 *    append(table, line)         → locator (레코드 위치)
 *    read(table, locator)        → line
 *    scan(table, from?)          → 반복자 [locator, line]   (처음부터 끝까지 = 선형 탐색. from 을 주면 거기서부터)
 *    end?(table) / limit?(table, end) → 여러 스레드가 한 파일을 쓸 때 "확정된 끝" 까지만 읽게 하는 상한
 *    flush()                     → 버퍼를 실제로 기록
 *    refresh?(table)             → 다른 스레드가 쓴 내용을 반영 (파일 크기 다시 읽기)
 *    size?(table) / truncate?(table, size) → 실패한 요청이 덧붙인 레코드를 되돌릴 때 (롤백)
 */

export const NULL_MARK = '\\N';

/** 그대로 쓸 수 없는 값인지: 역슬래시 · 줄바꿈 · 따옴표 · 쉼표가 있거나, 앞뒤가 공백이거나, 빈 문자열 */
const NEEDS_ESCAPE = /[\\\r\n",]|^\s|\s$/;

/** 파일에 따옴표 · 이스케이프 없이 그대로 적히는 글자열인지 (그런 값은 파일의 바이트에서 바로 검색할 수 있다) */
export function isPlainText(s) {
  return typeof s === 'string' && s !== '' && !NEEDS_ESCAPE.test(s);
}

function escapeField(v) {
  if (v === null || v === undefined) return NULL_MARK;
  if (typeof v === 'number') return String(v); // 숫자에는 바꿀 글자가 없다
  // 대부분의 값은 바꿀 것이 없다 → 검사 한 번으로 끝낸다 (아래의 치환 세 번 + 검사를 건너뜀. 대량 INSERT 에서 가장 많이 불리는 함수)
  if (typeof v === 'string' && v !== '' && !NEEDS_ESCAPE.test(v)) return v;
  let s = String(v).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (s === NULL_MARK) s = '\\\\N';
  if (/[",]|^\s|\s$/.test(s) || s === '') s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function unescapeField(s) {
  // 대부분의 값에는 역슬래시가 없다 → 정규식을 돌리지 않고 그대로 (전체 읽기에서 가장 많이 불리는 함수)
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\(\\|n|r)/g, (m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'));
}

/** 값 배열 → 한 줄 */
export function encodeRow(values) {
  const n = values.length;
  if (n === 0) return '';
  let out = escapeField(values[0]);
  for (let i = 1; i < n; i++) out += ',' + escapeField(values[i]);
  return out;
}

/**
 * 한 줄에서 i 번째 값만 — decodeRow(line)[i] 와 같다.
 * 따옴표가 없는 줄은 쉼표 위치만 찾아서 그 값 하나만 꺼낸다 (전체 읽기에서 조건 열만 볼 때 빠름)
 */
export function decodeField(line, i) {
  if (line.indexOf('"') !== -1) return decodeRow(line)[i];
  let s = 0;
  for (let k = 0; k < i; k++) {
    const c = line.indexOf(',', s);
    if (c === -1) return undefined; // 그 열이 없는 줄
    s = c + 1;
  }
  let e = line.indexOf(',', s);
  if (e === -1) e = line.length;
  if (e - s === 2 && line.charCodeAt(s) === 92 && line.charCodeAt(s + 1) === 78) return null;
  const raw = line.slice(s, e);
  return raw.indexOf('\\') === -1 ? raw : unescapeField(raw);
}

/** 따옴표·백슬래시가 없는 일반 줄에서 i번째 열이 val 과 같은지 0-할당으로 확인한다. 판단 불가면 null */
export function fieldEqualsPlain(line, i, val) {
  if (line.indexOf('"') !== -1 || line.indexOf('\\') !== -1) return null;
  let s = 0;
  for (let k = 0; k < i; k++) {
    const c = line.indexOf(',', s);
    if (c === -1) return false;
    s = c + 1;
  }
  let e = line.indexOf(',', s);
  if (e === -1) e = line.length;
  const vlen = val.length;
  if (e - s !== vlen) return false;
  if (vlen === 0) return true;
  if (line.charCodeAt(s) !== val.charCodeAt(0)) return false;
  if (vlen > 1 && line.charCodeAt(e - 1) !== val.charCodeAt(vlen - 1)) return false;
  return line.startsWith(val, s);
}

/** 한 줄 → 값 배열 (문자열 또는 null) */
export function decodeRow(line) {
  // 따옴표가 없는 줄(대부분)은 쉼표로 나누기만 하면 된다 — 아래 일반 경로와 결과가 같다
  if (line.indexOf('"') === -1) {
    const out = line.split(',');
    if (line.indexOf('\\') === -1) return out;
    for (let k = 0; k < out.length; k++) out[k] = out[k] === NULL_MARK ? null : unescapeField(out[k]);
    return out;
  }
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= line.length) throw new Error('레코드 형식 오류: 따옴표가 닫히지 않음');
        if (line[i] === '"') {
          if (line[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++;
          break;
        }
        s += line[i++];
      }
      out.push(unescapeField(s));
      if (i < line.length && line[i] !== ',') throw new Error('레코드 형식 오류: 따옴표 뒤에 쉼표가 없음');
      i++;
    } else {
      let j = line.indexOf(',', i);
      if (j === -1) j = line.length;
      const raw = line.slice(i, j);
      out.push(raw === NULL_MARK ? null : unescapeField(raw));
      i = j + 1;
    }
  }
  return out;
}

/** 메모리 저장소: 파일 대신 문자열 배열. locator = 줄 번호. 화면에서 "파일 내용" 을 보여 주기 쉽다 */
export class MemoryStorage {
  /** @param {object} schema { users: { columns: [{name:'id',type:'INT'}, ...] } } */
  constructor(schema) {
    this._schema = schema;
    this.files = {};
    for (const t of Object.keys(schema)) this.files[t] = [];
    this.reads = 0;
  }

  schema() {
    return this._schema;
  }

  append(table, line) {
    this.files[table].push(line);
    return this.files[table].length - 1;
  }

  read(table, locator) {
    this.reads++;
    return this.files[table][locator];
  }

  *scan(table, from = 0, _grow = false) {
    const f = this.files[table];
    for (let i = from; i < f.length; i++) {
      this.reads++;
      yield [i, f[i]];
    }
  }

  forEachLine(table, from = 0, _grow = false, fn) {
    const f = this.files[table];
    for (let i = from; i < f.length; i++) {
      this.reads++;
      if (fn(i, f[i]) === false) return;
    }
  }

  flush() {}

  size(table) {
    return this.files[table].length;
  }

  /** size 뒤에 덧붙인 레코드를 모두 버린다 (요청 롤백) */
  truncate(table, size) {
    if (size < this.files[table].length) this.files[table].length = size;
  }

  /** 파일 내용 (시각화용) */
  text(table) {
    return this.files[table].join('\n');
  }
}
