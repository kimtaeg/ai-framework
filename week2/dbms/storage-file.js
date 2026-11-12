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
 *
 *  버퍼 풀 (Buffer Pool): 한 줄 읽기(read)는 파일을 8KB 페이지로 나눠, 읽은 페이지를 메모리에 남겨 둔다.
 *    같은 페이지의 다른 레코드를 또 찾으면 디스크(시스템 콜)에 가지 않고 메모리에서 바로 꺼낸다.
 *    - 가득 차면 가장 오래 안 쓴 페이지부터 버린다 (LRU).
 *    - "확정된 끝"(limit) 아래의 꽉 찬 페이지만 담는다. 파일은 덧붙이기만 하므로 그 아래 내용은 바뀌지 않는다
 *      → 쓰는 중인 꼬리 부분은 담지 않아서, 다른 워커가 덧붙이거나 되돌려도 낡은 내용을 읽을 일이 없다.
 *    - 전체 읽기(scan)는 풀을 거치지 않는다. 한 번 훑는 큰 읽기가 자주 쓰는 페이지를 밀어내지 않게 (캐시 오염 방지).
 */
import { openSync, readSync, writeSync, closeSync, fstatSync, truncateSync, readFileSync, writeFileSync, existsSync, mkdirSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRow } from './storage.js';

const CHUNK = 64 * 1024;
const FLUSH_AT = 1024 * 1024;
const PAGE = 8 * 1024;    // 버퍼 풀의 페이지 크기
const POOL_PAGES = 1024;  // 테이블마다 담아 두는 페이지 수 (8KB × 1024 = 최대 8MB)

export const DEFAULT_SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
};

export class FileStorage {
  /**
   * @param {string} dir  데이터 폴더 (schema.json 이 없으면 기본 스키마로 만든다)
   * @param {{ schema?: object, sync?: boolean, repair?: boolean, poolPages?: number }} [opts]
   *   poolPages: 버퍼 풀이 테이블마다 담아 두는 페이지 수 (기본 1024, 0 이면 끔)
   *   sync: 기록할 때마다 fsync (느리지만 안전)
   *   repair: 열 때 "쓰다 만 마지막 줄" 을 정리 (기본 켬). 스레드 풀의 워커는 끈다 —
   *           다른 워커가 쓰는 중일 수 있어서, 워커는 쓰기 락을 잡은 뒤(refresh)에만 정리한다
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.sync = opts.sync ?? false;
    this.poolPages = Math.max(0, opts.poolPages ?? POOL_PAGES);
    this.pool = { hits: 0, misses: 0, evictions: 0 }; // 버퍼 풀 통계
    mkdirSync(dir, { recursive: true });
    const schemaFile = join(dir, 'schema.json');
    if (!existsSync(schemaFile)) writeFileSync(schemaFile, JSON.stringify(opts.schema ?? DEFAULT_SCHEMA, null, 2));
    this._schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    this.files = {};
    for (const t of Object.keys(this._schema)) {
      const path = join(dir, `${t}.tbl`);
      const fd = openSync(path, 'a+');
      this.files[t] = { table: t, path, fd, size: fstatSync(fd).size, buffer: [], bufferBytes: 0, visible: Infinity, pages: new Map() };
    }
    this.reads = 0;
    this.repaired = 0; // 정리한 "쓰다 만 줄" 수
    if (opts.repair ?? true) for (const f of Object.values(this.files)) this.#repairTail(f);
  }

  /**
   * 파일이 줄바꿈으로 끝나지 않으면 = 마지막 레코드를 쓰다가 서버가 죽은 것.
   * 그대로 두면 다음 INSERT 가 그 줄 뒤에 이어 붙어서, 다시 켰을 때 두 레코드가 한 줄로 읽힌다.
   *   - 마지막 줄이 온전한 레코드 모양(열 개수가 맞고 id 가 정수)이면 줄바꿈만 붙인다 (손으로 고친 파일 등)
   *   - 아니면 쓰다 만 줄이므로 잘라 낸다 (끝까지 기록된 적이 없으니 성공 응답도 나간 적이 없다)
   */
  #repairTail(f) {
    if (f.buffer.length || f.size === 0) return;
    const one = Buffer.allocUnsafe(1);
    if (readSync(f.fd, one, 0, 1, f.size - 1) === 1 && one[0] === 10) return;
    // 뒤에서부터 마지막 줄바꿈을 찾는다
    let lineStart = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let end = f.size; end > 0; ) {
      const from = Math.max(0, end - CHUNK);
      const n = readSync(f.fd, buf, 0, end - from, from);
      const nl = n > 0 ? buf.lastIndexOf(10, n - 1) : -1;
      if (nl !== -1) { lineStart = from + nl + 1; break; }
      end = from;
    }
    const tail = Buffer.allocUnsafe(f.size - lineStart);
    readSync(f.fd, tail, 0, tail.length, lineStart);
    if (this.#looksComplete(f.table, tail.toString('utf8'))) {
      writeSync(f.fd, '\n');
      f.size += 1;
    } else {
      truncateSync(f.path, lineStart);
      f.size = lineStart;
      f.pages.clear(); // 잘라 낸 자리에 다른 내용이 다시 쓰일 수 있다
    }
    if (this.sync) fsyncSync(f.fd);
    this.repaired++;
  }

  #looksComplete(table, line) {
    try {
      const row = decodeRow(line);
      return row.length === this._schema[table].columns.length && /^-?\d+$/.test(row[0] ?? '');
    } catch {
      return false;
    }
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
    if (f.buffer.length === 0) {
      const size = fstatSync(f.fd).size;
      if (size < f.size) f.pages.clear(); // 다른 곳에서 파일을 줄였다 (롤백) → 담아 둔 페이지를 믿을 수 없다
      f.size = size;
      this.#repairTail(f);
    }
  }

  /** 지금까지의 크기 (버퍼에 있는 것 포함). 실패한 요청을 되돌릴 때의 기준점 */
  size(table) {
    return this.#file(table).size;
  }

  /** size 뒤에 덧붙인 레코드를 모두 버린다 (요청 롤백) */
  truncate(table, size) {
    const f = this.#file(table);
    if (size >= f.size) return;
    this.#flushFile(f);
    truncateSync(f.path, size);
    if (this.sync) fsyncSync(f.fd);
    f.size = size;
    f.pages.clear();
  }

  /** 버퍼 풀 비우기 (table 을 안 주면 전부). 파일 내용이 바뀌었을 수 있을 때 부른다 (롤백 · 인덱스 다시 만들기) */
  dropCache(table = null) {
    for (const f of Object.values(this.files)) if (!table || f.table === table) f.pages.clear();
  }

  /** loc 이 들어 있는 페이지를 풀에서 찾는다 (없으면 디스크에서 읽어 담는다). 담을 수 없는 위치면 null */
  #page(f, pageNo) {
    let page = f.pages.get(pageNo);
    if (page) {
      this.pool.hits++;
      // 방금 쓴 페이지를 맨 뒤로 (Map 은 넣은 순서를 기억한다 → 맨 앞이 가장 오래 안 쓴 페이지)
      f.pages.delete(pageNo);
      f.pages.set(pageNo, page);
      return page;
    }
    this.pool.misses++;
    page = Buffer.allocUnsafe(PAGE);
    if (readSync(f.fd, page, 0, PAGE, pageNo * PAGE) !== PAGE) return null;
    if (f.pages.size >= this.poolPages) {
      f.pages.delete(f.pages.keys().next().value); // LRU: 가장 오래 안 쓴 페이지를 버린다
      this.pool.evictions++;
    }
    f.pages.set(pageNo, page);
    return page;
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
    // 버퍼 풀: 확정된 끝 아래의 꽉 찬 페이지에 있는 줄이면 페이지에서 바로 꺼낸다
    if (this.poolPages > 0 && f.visible !== Infinity) {
      const pageNo = Math.floor(loc / PAGE);
      if ((pageNo + 1) * PAGE <= f.visible) {
        const page = this.#page(f, pageNo);
        if (page) {
          const off = loc - pageNo * PAGE;
          const nl = page.indexOf(10, off);
          if (nl !== -1) return page.toString('utf8', off, nl);
          // 줄이 다음 페이지로 넘어간다 → 아래의 직접 읽기로
        }
      }
    }
    // 읽기용 버퍼는 한 번 만들어 계속 쓴다 (조회마다 새로 만들지 않음). 돌려주는 것은 문자열이라 공유해도 안전
    let buf = (this._readBuf ??= Buffer.allocUnsafe(256));
    let len = 0;
    for (;;) {
      if (len === buf.length) {
        const bigger = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(bigger);
        buf = this._readBuf = bigger;
      }
      const n = readSync(f.fd, buf, len, buf.length - len, loc + len);
      const nl = buf.indexOf(10, len); // '\n'
      if (nl !== -1 && nl < len + n) return buf.toString('utf8', 0, nl);
      len += n;
      if (n === 0) return buf.toString('utf8', 0, len);
    }
  }

  /** 지금 파일의 실제 끝 위치 (정리 없이 크기만). 읽기 전용으로 "여기까지가 기록된 내용" 을 알 때 쓴다 */
  end(table) {
    const f = this.#file(table);
    return f.buffer.length ? f.size : fstatSync(f.fd).size;
  }

  /**
   * scan 이 읽을 수 있는 끝 위치를 정한다 (= 확정된 내용의 끝. 줄 경계여야 한다).
   * 스레드 풀에서 다른 워커가 지금 덧붙이는 중인 뒷부분을, 조회하는 워커가 읽지 않게 막는다.
   */
  limit(table, end) {
    const f = this.#file(table);
    if (end < f.visible) f.pages.clear(); // 끝이 앞으로 당겨졌다 = 뒤쪽이 버려졌다
    f.visible = end;
  }

  /**
   * [offset, line] 을 차례로. from 은 줄이 시작하는 위치여야 한다. limit() 으로 정한 끝에서 멈춘다.
   *   - 전체 읽기: scan(table)
   *   - 범위 조회: scan(table, 첫 레코드 위치) → 레코드마다 read() 를 부르는 대신 64KB 씩 한 번에 읽는다
   */
  *scan(table, from = 0) {
    const f = this.#file(table);
    this.#flushFile(f);
    const end = f.visible;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;        // 파일에서 다음에 읽을 위치
    let lineStart = from;  // 지금 줄의 시작 offset
    let carry = Buffer.alloc(0);
    for (;;) {
      const want = Math.min(CHUNK, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      pos += n;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      const last = data.lastIndexOf(10);
      if (last !== -1) {
        // 덩어리 안의 완성된 줄들을 한 번에 문자열로 바꾼 뒤 나눈다 (줄마다 바꾸는 것보다 훨씬 빠름).
        // '\n'(0x0A) 은 UTF-8 여러 바이트 문자 안에 나올 수 없으므로 줄마다 바꾼 결과와 같다.
        // 위치(바이트 offset)는 버퍼에서 줄바꿈 위치로 따로 센다.
        const lines = data.toString('utf8', 0, last).split('\n');
        for (let k = 0; k < lines.length; k++) {
          const nl = data.indexOf(10, start);
          this.reads++;
          yield [lineStart, lines[k]];
          lineStart += nl - start + 1;
          start = nl + 1;
        }
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
