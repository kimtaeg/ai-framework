/**
 * 파일 저장소 (Node 전용) — 테이블 하나 = 파일 하나 (data/테이블.tbl)
 * ------------------------------------------------------------------
 *  data/
 *    schema.json      { "users": { "columns": [{ "name": "id", "type": "INT" }, ...], "indexes": ["email"] } }
 *                     indexes (선택): 시작할 때 해시 인덱스를 만들어 둘 열 → 그 열의 = 조건을 첫 조회부터 바로 찾는다
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
import { openSync, readSync, writeSync, closeSync, fstatSync, truncateSync, readFileSync, writeFileSync, existsSync, mkdirSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRow } from './storage.js';

const CHUNK = 64 * 1024;
const BIG_CHUNK = 256 * 1024; // 바이트 그대로 훑을 때(scanFor · scanNum · eachId) 한 번에 읽는 크기
const FIRST_CHUNK = 2 * 1024; // 범위 조회가 처음 읽는 크기 (보통 수십 줄)
const EMPTY_BUF = Buffer.alloc(0);
/** data[from..to) 안의 줄 수 (= 줄바꿈 수) */
function countLines(data, from, to) {
  let n = 0;
  for (let i = data.indexOf(10, from); i !== -1 && i < to; i = data.indexOf(10, i + 1)) n++;
  return n;
}
const FLUSH_AT = 1024 * 1024;
const PAGE = 8 * 1024;    // 버퍼 풀의 페이지 크기
const POOL_PAGES = 1024;  // 테이블마다 담아 두는 페이지 수 (8KB × 1024 = 최대 8MB)
// 버퍼 풀은 "같은 페이지를 다시 읽을 때" 만 이득이다. 테이블이 풀보다 훨씬 크고 조회가 고르게 흩어지면
// 대부분 빗나가는데, 그때는 한 줄(수백 바이트)이면 될 것을 8KB 씩 읽고 곧 버리게 되어 풀 없이 읽는 것보다 느리다.
// → 최근 조회의 적중률을 재서, 낮으면 한동안 풀을 건너뛰고 직접 읽는다. 그 뒤 다시 시험해 본다 (조회 양상이 바뀌었을 수 있다)
const POOL_WINDOW = 2048;      // 이만큼 조회할 때마다 적중률을 본다
const POOL_MIN_HIT = 0.6;      // 적중률이 이보다 낮으면 손해 (측정한 손익분기점은 0.55 근처)
const POOL_BYPASS = 16384;     // 손해일 때 풀을 건너뛰는 조회 수

export const DEFAULT_SCHEMA = {
  users: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'age', type: 'INT' }, { name: 'email', type: 'TEXT' }] },
  products: { columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'price', type: 'INT' }, { name: 'category', type: 'TEXT' }] },
};

/**
 * 데이터 폴더의 "쓰는 프로그램은 하나" 락 — 폴더 안의 .lock 파일에 쓰는 프로그램의 pid 를 적어 둔다.
 * ------------------------------------------------------------------
 *  테이블 쓰기 락(lock.js)은 한 프로세스 안에서만 통한다. API 서버가 켜져 있는데 CLI 가 같은 폴더에 INSERT 하면
 *  두 프로그램이 서로 모르는 채로 같은 파일 끝에 쓰게 되어, 줄 위치가 어긋나고 인덱스가 엉뚱한 줄을 가리킨다.
 *  → 쓰려는 프로그램은 먼저 이 락을 잡는다. 다른 프로그램이 잡고 있으면 쓰지 않고 이유를 알려 준다.
 *
 *  - .lock 을 "없을 때만 만들기"(wx)로 만든다 → 두 프로그램이 동시에 잡으려 해도 한쪽만 성공한다
 *  - 잡고 있던 프로그램이 죽었으면(pid 가 살아 있지 않으면) 남은 락을 치우고 잡는다
 *  - 같은 프로세스가 다시 잡는 것은 허용한다 (서버를 껐다 켜는 테스트 · 워커 스레드는 pid 가 같다)
 *
 * @param {string} dir  데이터 폴더
 * @param {string} who  누가 잡았는지 (오류 메시지에 보여 준다. 예: 'API 서버', 'CLI')
 * @returns {() => void}  락을 푸는 함수 (여러 번 불러도 안전)
 */
export function lockDataDir(dir, who = '') {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.lock');
  const mine = JSON.stringify({ pid: process.pid, who, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx'); // 없을 때만 만든다 (원자적)
      writeSync(fd, mine);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try {
        held = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // 쓰다 만 락 파일 → 아래에서 치운다
      }
      if (held && held.pid === process.pid) break; // 이 프로세스가 이미 잡고 있다
      if (held && isAlive(held.pid)) {
        const err = new Error(`데이터 폴더를 다른 프로그램이 쓰고 있습니다: ${held.who || '알 수 없음'} (pid ${held.pid}). 그 프로그램을 끄거나, 그 프로그램을 통해 쓰세요. [${dir}]`);
        err.code = 'DATA_DIR_LOCKED';
        throw err;
      }
      try {
        unlinkSync(path); // 죽은 프로그램이 남긴 락
      } catch {
        // 다른 프로그램이 먼저 치웠다 → 다시 시도
      }
      if (attempt === 2) throw new Error(`데이터 폴더의 락을 잡지 못했습니다: ${path}`);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path);
    } catch {
      // 이미 없거나 읽을 수 없다
    }
  };
}

/** 그 pid 의 프로세스가 살아 있는지 (신호 0 = 보내지는 않고 확인만) */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 권한이 없어 확인을 못 했다 = 프로세스는 있다
  }
}

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
    this.pool = { hits: 0, misses: 0, evictions: 0 }; // 버퍼 풀 통계 (hits: 메모리에서 바로 꺼냄, misses: 디스크에서 읽음, evictions: 쫓겨난 페이지)
    this.poolBypassed = 0; // 적중률이 낮아 풀을 건너뛴 조회 수
    mkdirSync(dir, { recursive: true });
    const schemaFile = join(dir, 'schema.json');
    if (!existsSync(schemaFile)) writeFileSync(schemaFile, JSON.stringify(opts.schema ?? DEFAULT_SCHEMA, null, 2));
    this._schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    this.files = {};
    for (const t of Object.keys(this._schema)) {
      const path = join(dir, `${t}.tbl`);
      const fd = openSync(path, 'a+');
      this.files[t] = { table: t, path, fd, size: fstatSync(fd).size, writeBuf: null, bufferBytes: 0, visible: Infinity, pages: new Map(), lastPageNo: -1, lastPage: null, winHits: 0, winMisses: 0, bypass: 0 };
    }
    this.reads = 0;
    this.repaired = 0; // 정리한 "쓰다 만 줄" 수
    if (opts.repair ?? true) for (const f of Object.values(this.files)) this.#repairTail(f);
  }

  #clearPages(f) {
    f.pages.clear();
    f.lastPageNo = -1;
    f.lastPage = null;
  }

  /**
   * 파일이 줄바꿈으로 끝나지 않으면 = 마지막 레코드를 쓰다가 서버가 죽은 것.
   * 그대로 두면 다음 INSERT 가 그 줄 뒤에 이어 붙어서, 다시 켰을 때 두 레코드가 한 줄로 읽힌다.
   *   - 마지막 줄이 온전한 레코드 모양(열 개수가 맞고 id 가 정수)이면 줄바꿈만 붙인다 (손으로 고친 파일 등)
   *   - 아니면 쓰다 만 줄이므로 잘라 낸다 (끝까지 기록된 적이 없으니 성공 응답도 나간 적이 없다)
   */
  #repairTail(f) {
    if (f.bufferBytes || f.size === 0) return;
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
      this.#clearPages(f); // 잘라 낸 자리에 다른 내용이 다시 쓰일 수 있다
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
    if (f.bufferBytes === 0) {
      const size = fstatSync(f.fd).size;
      if (size < f.size) this.#clearPages(f); // 다른 곳에서 파일을 줄였다 (롤백) → 담아 둔 페이지를 믿을 수 없다
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
    this.#clearPages(f);
  }

  /** 버퍼 풀 비우기 (table 을 안 주면 전부). 파일 내용이 바뀌었을 수 있을 때 부른다 (롤백 · 인덱스 다시 만들기) */
  dropCache(table = null) {
    for (const f of Object.values(this.files)) if (!table || f.table === table) this.#clearPages(f);
  }

  /** loc 이 들어 있는 페이지를 풀에서 찾는다 (없으면 디스크에서 읽어 담는다). 담을 수 없는 위치면 null */
  #page(f, pageNo) {
    if (f.lastPageNo === pageNo) {
      this.pool.hits++;
      f.winHits++;
      return f.lastPage;
    }
    let page = f.pages.get(pageNo);
    if (page) {
      this.pool.hits++;
      f.winHits++;
      // 방금 쓴 페이지를 맨 뒤로 (Map 은 넣은 순서를 기억한다 → 맨 앞이 가장 오래 안 쓴 페이지)
      f.pages.delete(pageNo);
      f.pages.set(pageNo, page);
      f.lastPageNo = pageNo;
      f.lastPage = page;
      return page;
    }
    this.pool.misses++;
    f.winMisses++;
    page = Buffer.allocUnsafe(PAGE);
    if (readSync(f.fd, page, 0, PAGE, pageNo * PAGE) !== PAGE) return null;
    if (f.pages.size >= this.poolPages) {
      f.pages.delete(f.pages.keys().next().value); // LRU: 가장 오래 안 쓴 페이지를 버린다
      this.pool.evictions++;
    }
    f.pages.set(pageNo, page);
    f.lastPageNo = pageNo;
    f.lastPage = page;
    return page;
  }

  append(table, line) {
    const f = this.#file(table);
    const blen = Buffer.byteLength(line);
    const need = blen + 1;
    const loc = f.size; // 이 레코드가 시작할 위치
    let buf = f.writeBuf;
    if (!buf) buf = f.writeBuf = Buffer.allocUnsafe(FLUSH_AT);
    if (need > buf.length) {
      this.#flushFile(f);
      const big = Buffer.allocUnsafe(need);
      big.write(line, 0, blen, 'utf8');
      big[blen] = 10;
      writeSync(f.fd, big, 0, need);
      if (this.sync) fsyncSync(f.fd);
      f.size = loc + need;
      return loc;
    }
    if (f.bufferBytes + need > buf.length) this.#flushFile(f);
    const off = f.bufferBytes;
    buf.write(line, off, blen, 'utf8');
    buf[off + blen] = 10;
    f.bufferBytes = off + need;
    f.size = loc + need;
    if (f.bufferBytes >= FLUSH_AT) this.#flushFile(f);
    return loc;
  }

  #flushFile(f) {
    if (f.bufferBytes === 0) return;
    writeSync(f.fd, f.writeBuf, 0, f.bufferBytes);
    if (this.sync) fsyncSync(f.fd);
    f.bufferBytes = 0;
  }

  flush() {
    for (const f of Object.values(this.files)) this.#flushFile(f);
  }

  /** offset 에서 한 줄 읽기 */
  read(table, loc) {
    const f = this.#file(table);
    const flushedSize = f.size - f.bufferBytes;
    if (f.bufferBytes > 0 && loc >= flushedSize) {
      this.reads++;
      const off = loc - flushedSize;
      const nl = f.writeBuf.indexOf(10, off);
      return f.writeBuf.toString('utf8', off, nl !== -1 && nl < f.bufferBytes ? nl : f.bufferBytes);
    }
    this.reads++;
    // 버퍼 풀: 확정된 끝(및 이미 디스크에 기록된 구간) 아래의 꽉 찬 페이지에 있는 줄이면 페이지에서 바로 꺼낸다
    if (f.bypass > 0) {
      f.bypass--;
      this.poolBypassed++;
    } else if (this.poolPages > 0 && f.visible !== Infinity) {
      if (f.winHits + f.winMisses >= POOL_WINDOW) {
        if (f.winHits < POOL_MIN_HIT * (f.winHits + f.winMisses)) f.bypass = POOL_BYPASS;
        f.winHits = f.winMisses = 0;
      }
      const pageNo = Math.floor(loc / PAGE);
      const diskVisible = Math.min(f.visible, flushedSize);
      if ((pageNo + 1) * PAGE <= diskVisible) {
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
      if (n === 0) {
        if (f.bufferBytes > 0) {
          this.#flushFile(f);
          continue;
        }
        return buf.toString('utf8', 0, len);
      }
    }
  }

  /** 지금 파일의 실제 끝 위치 (정리 없이 크기만). 읽기 전용으로 "여기까지가 기록된 내용" 을 알 때 쓴다 */
  end(table) {
    const f = this.#file(table);
    return f.bufferBytes ? f.size : fstatSync(f.fd).size;
  }

  /**
   * scan 이 읽을 수 있는 끝 위치를 정한다 (= 확정된 내용의 끝. 줄 경계여야 한다).
   * 스레드 풀에서 다른 워커가 지금 덧붙이는 중인 뒷부분을, 조회하는 워커가 읽지 않게 막는다.
   */
  limit(table, end) {
    const f = this.#file(table);
    if (end < f.visible) this.#clearPages(f); // 끝이 앞으로 당겨졌다 = 뒤쪽이 버려졌다
    f.visible = end;
  }

  /**
   * [offset, line] 을 차례로. from 은 줄이 시작하는 위치여야 한다. limit() 으로 정한 끝에서 멈춘다.
   *   - 전체 읽기: scan(table)
   *   - 범위 조회: scan(table, 첫 레코드 위치, true) → 레코드마다 read() 를 부르는 대신 덩어리로 읽는다
   *   - grow: 처음에는 조금(2KB)만 읽고, 계속 읽어 나가면 덩어리를 두 배씩 키운다 (최대 64KB).
   *       몇 줄만 필요한 범위 조회(LIMIT 10 등)가 64KB 를 통째로 읽고 문자열로 바꾸는 값을 치르지 않게.
   *       전체 읽기는 처음부터 64KB 로 읽는다.
   */
  *scan(table, from = 0, grow = false) {
    const f = this.#file(table);
    this.#flushFile(f);
    const end = f.visible;
    let size = grow ? FIRST_CHUNK : CHUNK;
    let buf = Buffer.allocUnsafe(size);
    let pos = from;        // 파일에서 다음에 읽을 위치
    let lineStart = from;  // 지금 줄의 시작 offset
    let carry = Buffer.alloc(0);
    for (;;) {
      if (buf.length < size) buf = Buffer.allocUnsafe(size); // 덩어리가 커졌다 (앞 덩어리의 내용은 이미 문자열 · carry 로 옮겨졌다)
      const want = Math.min(size, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      if (size < CHUNK) size *= 2;
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

  /** 제너레이터/배열 할당 없이 [offset, line] 을 차례로 넘긴다. fn 이 false 를 반환하면 중단 */
  forEachLine(table, from = 0, grow = false, fn) {
    const f = this.#file(table);
    this.#flushFile(f);
    const end = f.visible;
    let size = grow ? FIRST_CHUNK : CHUNK;
    const buf = (this._scanBuf ??= Buffer.allocUnsafe(CHUNK));
    let pos = from;
    let lineStart = from;
    let carry = EMPTY_BUF;
    for (;;) {
      const want = Math.min(size, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      if (size < CHUNK) size = Math.min(CHUNK, size * 2);
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      const last = data.lastIndexOf(10);
      if (last !== -1) {
        const text = data.toString('utf8', 0, last);
        const lines = text.split('\n');
        if (text.length === last) {
          for (let k = 0; k < lines.length; k++) {
            const line = lines[k];
            this.reads++;
            if (fn(lineStart, line) === false) return;
            lineStart += line.length + 1;
          }
          start = last + 1;
        } else {
          for (let k = 0; k < lines.length; k++) {
            const nl = data.indexOf(10, start);
            this.reads++;
            if (fn(lineStart, lines[k]) === false) return;
            lineStart += nl - start + 1;
            start = nl + 1;
          }
        }
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY_BUF;
    }
    if (carry.length) {
      this.reads++;
      fn(lineStart, carry.toString('utf8'));
    }
  }

  /** 순차 범위 조회용 경량 커서 (제너레이터 없이 nextAt(expectedLoc) 으로 줄 문자열만 꺼냄) */
  openCursor(table, from = 0, grow = false) {
    const f = this.#file(table);
    this.#flushFile(f);
    const storage = this;
    const end = f.visible;
    let size = grow ? FIRST_CHUNK : CHUNK;
    const buf = (this._cursorBuf ??= Buffer.allocUnsafe(CHUNK));
    let pos = from;
    let lineStart = from;
    let carry = EMPTY_BUF;
    let lines = null;
    let lineIdx = 0;
    let chunkAscii = false;
    let data = EMPTY_BUF;
    let dataStart = 0;
    let eof = false;

    const refill = () => {
      lines = null;
      lineIdx = 0;
      for (;;) {
        const want = Math.min(size, end - pos);
        if (want <= 0) {
          eof = true;
          if (carry.length) {
            lines = [carry.toString('utf8')];
            chunkAscii = false;
            data = EMPTY_BUF;
            carry = EMPTY_BUF;
            return true;
          }
          return false;
        }
        const n = readSync(f.fd, buf, 0, want, pos);
        if (n === 0) {
          eof = true;
          if (carry.length) {
            lines = [carry.toString('utf8')];
            chunkAscii = false;
            data = EMPTY_BUF;
            carry = EMPTY_BUF;
            return true;
          }
          return false;
        }
        if (size < CHUNK) size = Math.min(CHUNK, size * 2);
        pos += n;
        const raw = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const last = raw.lastIndexOf(10);
        if (last !== -1) {
          const text = raw.toString('utf8', 0, last);
          lines = text.split('\n');
          chunkAscii = text.length === last;
          data = chunkAscii ? EMPTY_BUF : raw;
          dataStart = 0;
          carry = last + 1 < raw.length ? Buffer.from(raw.subarray(last + 1)) : EMPTY_BUF;
          return true;
        }
        carry = Buffer.from(raw);
      }
    };

    return {
      nextAt(expectedLoc) {
        if ((!lines || lineIdx >= lines.length) && (eof || !refill())) return null;
        if (lineStart !== expectedLoc) return null;
        storage.reads++;
        const line = lines[lineIdx++];
        if (chunkAscii) {
          lineStart += line.length + 1;
        } else if (data.length) {
          const nl = data.indexOf(10, dataStart);
          if (nl !== -1) {
            lineStart += nl - dataStart + 1;
            dataStart = nl + 1;
          }
        }
        return line;
      },
    };
  }

  /**
   * 선형 탐색을 빠르게: text 가 들어 있는 줄만 [line, 위치] 로 넘긴다.
   *   WHERE email = 'a@b.c' 로 전체를 읽을 때 파일 바이트에서 Buffer.indexOf 로 먼저 찾고,
   *   값이 들어 있지 않은 줄은 문자열로 바꾸지도 않는다.
   */
  *scanFor(table, text) {
    const f = this.#file(table);
    if (f.bufferBytes) this.#flushFile(f);
    const end = f.visible;
    const key = Buffer.from(text, 'utf8');
    const buf = Buffer.allocUnsafe(BIG_CHUNK);
    let pos = 0;
    let carry = EMPTY_BUF;
    let seen = 0;
    for (;;) {
      const want = Math.min(BIG_CHUNK, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const base = pos - carry.length;
      pos += n;
      const last = data.lastIndexOf(10);
      let start = 0;
      if (last !== -1) {
        let countedTo = 0;
        let at = data.indexOf(key, 0);
        while (at !== -1 && at < last) {
          const lineStart = at === 0 ? 0 : data.lastIndexOf(10, at - 1) + 1;
          const lineEnd = data.indexOf(10, at);
          if (lineStart > countedTo) seen += countLines(data, countedTo, lineStart);
          seen++;
          countedTo = lineEnd + 1;
          this.reads++;
          yield [data.toString('utf8', lineStart, lineEnd), base + lineStart, seen];
          at = data.indexOf(key, lineEnd + 1);
        }
        if (last + 1 > countedTo) seen += countLines(data, countedTo, last + 1);
        start = last + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY_BUF;
    }
    if (carry.length && carry.indexOf(key) !== -1) {
      this.reads++;
      yield [carry.toString('utf8'), pos - carry.length, seen + 1];
    }
  }

  /**
   * 선형 탐색을 빠르게 (숫자 열): col 번째 열의 값을 바이트에서 바로 숫자로 읽어 pred(값) 가 참인 줄만 [line, 위치, seen] 으로 넘긴다.
   */
  *scanNum(table, col, pred, lo = -Infinity, hi = Infinity) {
    const f = this.#file(table);
    if (f.bufferBytes) this.#flushFile(f);
    const end = f.visible;
    const buf = Buffer.allocUnsafe(BIG_CHUNK);
    let pos = 0;
    let carry = EMPTY_BUF;
    let seen = 0, passed = 0, bulk = false;
    for (;;) {
      const want = Math.min(BIG_CHUNK, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const base = pos - carry.length;
      pos += n;
      const last = data.lastIndexOf(10);
      let i = 0;
      if (last !== -1) {
        if (bulk) {
          const lines = data.toString('utf8', 0, last).split('\n');
          for (let k = 0; k < lines.length; k++) {
            const nl = data.indexOf(10, i);
            if (lines[k]) {
              this.reads++;
              yield [lines[k], base + i, ++seen];
            }
            i = nl + 1;
          }
        } else {
          let quote = data.indexOf(34);
          if (quote === -1) quote = Infinity;
          while (i <= last) {
            const nl = data.indexOf(10, i);
            if (nl === i) { i++; continue; }
            let take = true;
            if (quote < i) {
              quote = data.indexOf(34, i);
              if (quote === -1) quote = Infinity;
            }
            if (quote > nl) {
              let st = i;
              for (let k = 0; k < col && st !== -1; k++) {
                const c = data.indexOf(44, st);
                st = c === -1 || c > nl ? -1 : c + 1;
              }
              if (st !== -1) {
                let k = st;
                const neg = data[k] === 45;
                if (neg) k++;
                let num = 0, digits = 0;
                for (; k < nl; k++) {
                  const c = data[k];
                  if (c < 48 || c > 57) break;
                  num = num * 10 + (c - 48);
                  digits++;
                }
                if (digits > 0 && digits <= 15 && (k === nl || data[k] === 44)) {
                  const val = neg ? -num : num;
                  take = val >= lo && val <= hi && (pred === null || pred(val));
                } else if (data[st] === 92 && data[st + 1] === 78 && (st + 2 === nl || data[st + 2] === 44)) take = false;
              }
            }
            seen++;
            if (take) {
              passed++;
              this.reads++;
              yield [data.toString('utf8', i, nl), base + i, seen];
            }
            i = nl + 1;
          }
          if (seen >= 4096 && passed * 2 > seen) bulk = true;
        }
      }
      carry = i < data.length ? Buffer.from(data.subarray(i)) : EMPTY_BUF;
    }
    if (carry.length) {
      this.reads++;
      yield [carry.toString('utf8'), pos - carry.length, seen + 1];
    }
  }

  /** 파일의 [0, endOffset) 안에 있는 줄 수 (= 줄바꿈 수). */
  linesBefore(table, endOffset) {
    const f = this.#file(table);
    if (f.bufferBytes) this.#flushFile(f);
    const stop = Math.min(endOffset, f.visible);
    const buf = Buffer.allocUnsafe(BIG_CHUNK);
    let count = 0;
    for (let pos = 0; pos < stop; ) {
      const n = readSync(f.fd, buf, 0, Math.min(BIG_CHUNK, stop - pos), pos);
      if (n === 0) break;
      count += countLines(buf, 0, n);
      pos += n;
    }
    return count;
  }

  /** 줄마다 맨 앞의 id 만 읽어 fn(위치, id) 를 부른다 (인덱스를 다시 만들 때). */
  eachId(table, fn) {
    const f = this.#file(table);
    if (f.bufferBytes) this.#flushFile(f);
    const end = f.visible;
    const buf = Buffer.allocUnsafe(BIG_CHUNK);
    let pos = 0;
    let carry = EMPTY_BUF;
    const one = (data, i, stop) => {
      let k = i;
      const neg = data[k] === 45;
      if (neg) k++;
      let id = 0, digits = 0;
      for (; k < stop; k++) {
        const c = data[k];
        if (c < 48 || c > 57) break;
        id = id * 10 + (c - 48);
        digits++;
      }
      if (digits === 0 || (k < stop && data[k] !== 44) || !Number.isSafeInteger(id)) return NaN;
      return neg ? -id : id;
    };
    for (;;) {
      const want = Math.min(BIG_CHUNK, end - pos);
      if (want <= 0) break;
      const n = readSync(f.fd, buf, 0, want, pos);
      if (n === 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const base = pos - carry.length;
      pos += n;
      let i = 0;
      for (;;) {
        const nl = data.indexOf(10, i);
        if (nl === -1) break;
        if (nl > i) {
          this.reads++;
          const id = one(data, i, nl);
          if (id === id) fn(base + i, id);
        }
        i = nl + 1;
      }
      carry = i < data.length ? Buffer.from(data.subarray(i)) : EMPTY_BUF;
    }
    if (carry.length) {
      this.reads++;
      const id = one(carry, 0, carry.length);
      if (id === id) fn(pos - carry.length, id);
    }
  }

  close() {
    this.flush();
    for (const f of Object.values(this.files)) closeSync(f.fd);
    this.files = {};
  }
}
