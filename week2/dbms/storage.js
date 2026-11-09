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
 *    scan(table)                 → 반복자 [locator, line]   (처음부터 끝까지 = 선형 탐색)
 *    flush()                     → 버퍼를 실제로 기록
 *    refresh?(table)             → 다른 스레드가 쓴 내용을 반영 (파일 크기 다시 읽기)
 */

export const NULL_MARK = '\\N';

function escapeField(v) {
  if (v === null || v === undefined) return NULL_MARK;
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
  return values.map(escapeField).join(',');
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
  const raw = line.slice(s, e);
  return raw === NULL_MARK ? null : unescapeField(raw);
}

/** 한 줄 → 값 배열 (문자열 또는 null) */
export function decodeRow(line) {
  // 따옴표가 없는 줄(대부분)은 쉼표로 나누기만 하면 된다 — 아래 일반 경로와 결과가 같다
  if (line.indexOf('"') === -1) {
    const out = line.split(',');
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

  *scan(table) {
    const f = this.files[table];
    for (let i = 0; i < f.length; i++) {
      this.reads++;
      yield [i, f[i]];
    }
  }

  flush() {}

  /** 파일 내용 (시각화용) */
  text(table) {
    return this.files[table].join('\n');
  }
}
