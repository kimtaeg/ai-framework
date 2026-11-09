/**
 * 아주 작은 Redis(RESP2) 클라이언트 — 의존성 없이 실제 Redis 와 비교하기 위해 만든다.
 *   연결 하나로 명령을 파이프라이닝한다 (ioredis 기본 방식과 같음: 보낸 순서대로 응답이 온다).
 */
import { connect } from 'node:net';

export class RespClient {
  constructor({ host = '127.0.0.1', port = 6379 } = {}) {
    this.host = host;
    this.port = port;
    this.queue = [];
    this.buf = Buffer.alloc(0);
    this.ready = this.#open();
  }

  #open() {
    return new Promise((ok, fail) => {
      const s = connect({ host: this.host, port: this.port }, () => ok());
      s.setNoDelay(true);
      s.on('data', (chunk) => this.#onData(chunk));
      s.on('error', (e) => {
        fail(e);
        for (const q of this.queue.splice(0)) q.reject(e);
      });
      this.sock = s;
    });
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
    await this.ready;
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
  close() { this.sock?.end(); }
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
