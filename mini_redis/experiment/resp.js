/**
 * 아주 작은 Redis(RESP2) 클라이언트 — 의존성 없이 실제 Redis 와 비교하기 위해 만든다.
 *   연결 하나로 명령을 파이프라이닝한다 (ioredis 기본 방식과 같음: 보낸 순서대로 응답이 온다).
 *   연결이 끊기면(Redis 재시작 · 종료) 기다리던 명령은 모두 실패로 끝내고, 다음 명령 때 다시 연결한다.
 *   아래쪽 startRespServer 는 같은 형식의 서버 쪽 — 미니 레디스를 RESP/TCP 로도 말하게 한다.
 */
import { connect, createServer } from 'node:net';

const lost = () => new Error('Redis 연결이 끊겼습니다.');

export class RespClient {
  constructor({ host = '127.0.0.1', port = 6379 } = {}) {
    this.host = host;
    this.port = port;
    this.queue = [];
    this.buf = Buffer.alloc(0);
    this.closed = false; // close() 를 부른 뒤에는 다시 연결하지 않는다
    this.dead = false;   // 지금 연결이 끊긴 상태인가
    this.ready = this.#open();
  }

  #open() {
    this.dead = false;
    this.buf = Buffer.alloc(0);
    const ready = new Promise((ok, fail) => {
      const s = connect({ host: this.host, port: this.port }, () => ok());
      s.setNoDelay(true);
      // 다시 연결한 뒤에 옛 소켓에서 늦게 오는 이벤트는 무시한다
      s.on('data', (chunk) => { if (this.sock === s) this.#onData(chunk); });
      s.on('error', (e) => { fail(e); if (this.sock === s) this.#drop(e); });
      // 상대가 끊으면(FIN · RST 모두) 'close' 가 온다 → 응답을 기다리던 명령이 영원히 멈추지 않게 실패 처리
      s.on('close', () => { fail(lost()); if (this.sock === s) this.#drop(lost()); });
      this.sock = s;
    });
    ready.catch(() => {}); // 아무도 기다리지 않을 때 '처리되지 않은 거부' 로 프로세스가 죽지 않게
    return ready;
  }

  #drop(e) {
    this.dead = true;
    for (const q of this.queue.splice(0)) q.reject(e);
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.queue.length) {
      const r = parse(this.buf, off);
      if (!r) break;
      off = r.next;
      const q = this.queue.shift();
      if (r.value instanceof Error) q.reject(r.value);
      else q.resolve(r.value);
    }
    this.buf = off === this.buf.length ? Buffer.alloc(0) : this.buf.subarray(off);
  }

  async command(...args) {
    if (this.closed) throw new Error('Redis 클라이언트가 닫혔습니다.');
    if (this.dead) this.ready = this.#open(); // 끊긴 뒤 첫 명령 → 다시 연결 (Redis 가 돌아왔으면 정상 동작)
    await this.ready;
    if (this.dead) throw lost(); // 연결되자마자 다시 끊긴 경우
    let out = `*${args.length}\r\n`;
    for (const a of args) {
      const s = String(a);
      out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.sock.write(out);
    });
  }

  // MiniRedisClient 와 같은 모양
  get(key) { return this.command('GET', key); }
  async set(key, value, { ttl } = {}) {
    return (await (ttl ? this.command('SET', key, value, 'EX', ttl) : this.command('SET', key, value))) === 'OK';
  }
  del(key) { return this.command('DEL', key); }
  flushall() { return this.command('FLUSHALL'); }
  close() { this.closed = true; this.sock?.end(); }
}

// ================================================================ 서버 쪽 (미니 레디스 RESP/TCP 모드)
// 미니 레디스는 원래 HTTP + JSON 으로만 말한다. 저장소는 그대로 두고 "말하는 방식" 만 Redis 와 같게 바꿔서,
// 실제 Redis 보다 느린 이유가 저장소(해시 테이블)인지 통신 방식(HTTP + JSON)인지 가른다.

const MAX_BULK = 512 * 1024 * 1024; // Redis 와 같은 한도 (문자열 하나 최대 512MB)
const MAX_INLINE = 64 * 1024;       // 줄바꿈 없이 이보다 길면 잘못된 요청으로 본다
// 이 명령들이 돌려주는 'OK' · 'PONG' 은 상태 응답(+OK) — 실제 Redis 와 같은 모양
const STATUS = new Set(['SET', 'FLUSHALL', 'FLUSHDB', 'PING', 'MSET', 'RENAME', 'SELECT', 'QUIT']);

/**
 * 클라이언트가 보낸 명령 하나를 읽는다: RESP 배열(*N $len 값 …) 또는 telnet 처럼 한 줄(inline) 명령.
 *   → { args, next } · 아직 다 안 왔으면 null · 잘못된 요청이면 { error, next }
 */
export function parseRequest(buf, off = 0) {
  if (off >= buf.length) return null;
  const end = buf.indexOf('\r\n', off);
  if (buf[off] !== 0x2a /* '*' */) {
    if (end === -1) return buf.length - off > MAX_INLINE ? { error: 'ERR inline 요청이 너무 깁니다', next: buf.length } : null;
    const args = buf.toString('utf8', off, end).trim().split(/\s+/).filter(Boolean);
    return { args, next: end + 2 };
  }
  if (end === -1) return null;
  const n = Number(buf.toString('latin1', off + 1, end));
  if (!Number.isInteger(n) || n > 1024 * 1024) return { error: 'ERR 잘못된 배열 길이', next: buf.length };
  const args = [];
  let p = end + 2;
  for (let i = 0; i < n; i++) {
    if (p >= buf.length) return null;
    if (buf[p] !== 0x24 /* '$' */) return { error: `ERR '$' 가 와야 하는데 '${String.fromCharCode(buf[p])}' 가 왔습니다`, next: buf.length };
    const e = buf.indexOf('\r\n', p);
    if (e === -1) return null;
    const len = Number(buf.toString('latin1', p + 1, e));
    if (!Number.isInteger(len) || len < 0 || len > MAX_BULK) return { error: 'ERR 잘못된 문자열 길이', next: buf.length };
    if (buf.length < e + 2 + len + 2) return null;
    args.push(buf.toString('utf8', e + 2, e + 2 + len));
    p = e + 2 + len + 2;
  }
  return { args, next: p };
}

/** 명령 실행 결과 → RESP 응답 (name 은 상태 응답(+OK)인지 정하는 데만 쓴다) */
export function encodeReply(v, name = '') {
  if (v instanceof Error) return `-${String(v.message).replace(/[\r\n]+/g, ' ')}\r\n`;
  if (v === null || v === undefined) return '$-1\r\n';
  if (typeof v === 'number') return Number.isInteger(v) ? `:${v}\r\n` : `$${String(v).length}\r\n${v}\r\n`;
  if (typeof v === 'boolean') return `:${v ? 1 : 0}\r\n`;
  if (Array.isArray(v)) return `*${v.length}\r\n${v.map((x) => encodeReply(x)).join('')}`;
  const s = String(v);
  if (STATUS.has(name) && (s === 'OK' || s === 'PONG')) return `+${s}\r\n`;
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

/**
 * RESP/TCP 서버. handler(args) 는 동기로 결과를 돌려주거나 오류를 던진다 (미니 레디스 command 와 같은 모양).
 * 한 번에 도착한 명령들(파이프라이닝)은 순서대로 실행하고 응답을 모아 한 번에 쓴다 (Redis 와 같은 방식).
 */
export function startRespServer({ handler, port = 6381, host = '0.0.0.0' }) {
  const socks = new Set();
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('error', () => {}); // 클라이언트가 갑자기 끊어도 서버는 계속
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let off = 0, out = '', bad = false;
      for (;;) {
        const r = parseRequest(buf, off);
        if (!r) break;
        off = r.next;
        if (r.error) { out += `-${r.error}\r\n`; bad = true; break; }
        if (!r.args.length) continue; // 빈 줄
        const name = r.args[0].toUpperCase();
        try { out += encodeReply(handler(r.args), name); } catch (e) { out += encodeReply(e instanceof Error ? e : new Error(String(e))); }
      }
      buf = off >= buf.length ? Buffer.alloc(0) : buf.subarray(off);
      if (out) sock.write(out);
      if (bad) sock.end(); // 프로토콜이 깨진 연결은 Redis 처럼 닫는다
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    // close: 새 연결을 막고, 열려 있는 연결(앱 서버의 상시 연결)도 끊어야 server.close 가 끝난다
    const close = () => new Promise((d) => { server.close(() => d()); for (const s of socks) s.destroy(); });
    server.listen(port, host, () => ok({ server, port: server.address().port, close }));
  });
}

/** buf[off..] 에서 응답 하나를 읽는다. 아직 다 안 왔으면 null */
function parse(buf, off) {
  if (off >= buf.length) return null;
  const end = buf.indexOf('\r\n', off);
  if (end === -1) return null;
  const type = String.fromCharCode(buf[off]);
  const line = buf.toString('utf8', off + 1, end);
  const next = end + 2;
  if (type === '+') return { value: line, next };
  if (type === '-') return { value: new Error(line), next };
  if (type === ':') return { value: Number(line), next };
  if (type === '$') {
    const n = Number(line);
    if (n === -1) return { value: null, next };
    if (buf.length < next + n + 2) return null;
    return { value: buf.toString('utf8', next, next + n), next: next + n + 2 };
  }
  if (type === '*') {
    const n = Number(line);
    if (n === -1) return { value: null, next };
    const arr = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      arr.push(r.value);
      p = r.next;
    }
    return { value: arr, next: p };
  }
  return { value: new Error(`알 수 없는 응답: ${type}`), next };
}
