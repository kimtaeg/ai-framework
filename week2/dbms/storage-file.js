/**
 * 파일 저장소 (Node 전용) — 테이블 하나 = 파일 하나 (data/테이블.tbl)
 * ------------------------------------------------------------------
 *  data/
 *    schema.json      { "users": { "columns": [{ "name": "id", "type": "INT" }, ...] } }
 *    users.tbl        한 줄 = 레코드 하나 (storage.js 의 형식)
 *
 *  locator = 레코드가 시작하는 바이트 위치(offset).
 *    B+ 트리는 id → offset 을 기억하고, SELECT WHERE id = ? 는 그 위치에서 한 줄만 읽는다.
 *  쓰기는 버퍼에 모았다가 한 번에 기록 (100만 건 INSERT 때 줄마다 파일을 열고 닫으면 너무 느림)
 *  읽기는 64KB 씩 끊어 읽으며 줄 단위로 넘겨준다 (파일 전체를 메모리에 올리지 않음)
 */
import { openSync, readSync, writeSync, closeSync, fstatSync, readFileSync, writeFileSync, existsSync, mkdirSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

const CHUNK = 64 * 1024;
const FLUSH_AT = 1024 * 1024;

export const DEFAULT_SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
};

export class FileStorage {
  /**
   * @param {string} dir  데이터 폴더 (schema.json 이 없으면 기본 스키마로 만든다)
   * @param {{ schema?: object, sync?: boolean }} [opts]  sync: 기록할 때마다 fsync (느리지만 안전)
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.sync = opts.sync ?? false;
    mkdirSync(dir, { recursive: true });
    const schemaFile = join(dir, 'schema.json');
    if (!existsSync(schemaFile)) writeFileSync(schemaFile, JSON.stringify(opts.schema ?? DEFAULT_SCHEMA, null, 2));
    this._schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    this.files = {};
    for (const t of Object.keys(this._schema)) {
      const path = join(dir, `${t}.tbl`);
      const fd = openSync(path, 'a+');
      this.files[t] = { path, fd, size: fstatSync(fd).size, buffer: [], bufferBytes: 0 };
    }
    this.reads = 0;
  }

  schema() {
    return this._schema;
  }

  #file(table) {
    const f = this.files[table];
    if (!f) throw new Error(`테이블 파일이 없습니다: ${table}`);
    return f;
  }

  /** 다른 스레드/프로세스가 파일에 덧붙였을 수 있으니 실제 크기를 다시 읽는다 (쓰기 락을 잡은 뒤 호출) */
  refresh(table) {
    const f = this.#file(table);
    if (f.buffer.length === 0) f.size = fstatSync(f.fd).size;
  }

  append(table, line) {
    const f = this.#file(table);
    const bytes = Buffer.from(line + '\n', 'utf8');
    const loc = f.size; // 이 레코드가 시작할 위치
    f.size += bytes.length;
    f.buffer.push(bytes);
    f.bufferBytes += bytes.length;
    if (f.bufferBytes >= FLUSH_AT) this.#flushFile(f);
    return loc;
  }

  #flushFile(f) {
    if (!f.buffer.length) return;
    writeSync(f.fd, Buffer.concat(f.buffer));
    if (this.sync) fsyncSync(f.fd);
    f.buffer = [];
    f.bufferBytes = 0;
  }

  flush() {
    for (const f of Object.values(this.files)) this.#flushFile(f);
  }

  /** offset 에서 한 줄 읽기 */
  read(table, loc) {
    const f = this.#file(table);
    this.#flushFile(f);
    this.reads++;
    let buf = Buffer.alloc(256);
    let len = 0;
    for (;;) {
      if (len === buf.length) {
        const bigger = Buffer.alloc(buf.length * 2);
        buf.copy(bigger);
        buf = bigger;
      }
      const n = readSync(f.fd, buf, len, buf.length - len, loc + len);
      const nl = buf.indexOf(10, len); // '\n'
      if (nl !== -1 && nl < len + n) return buf.toString('utf8', 0, nl);
      len += n;
      if (n === 0) return buf.toString('utf8', 0, len);
    }
  }

  /** 처음부터 끝까지 [offset, line] */
  *scan(table) {
    const f = this.#file(table);
    this.#flushFile(f);
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;           // 파일에서 다음에 읽을 위치
    let lineStart = 0;     // 지금 줄의 시작 offset
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(f.fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        this.reads++;
        yield [lineStart, data.toString('utf8', start, nl)];
        lineStart += nl - start + 1;
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start)); // 덜 끝난 줄은 다음 덩어리와 합친다
    }
    if (carry.length) {
      this.reads++;
      yield [lineStart, carry.toString('utf8')];
    }
  }

  close() {
    this.flush();
    for (const f of Object.values(this.files)) closeSync(f.fd);
    this.files = {};
  }
}
