/**
 * 샌드박스/컨테이너 등 루프백(127.0.0.1) TCP 연결이 EACCES 로 막힌 환경에서도
 * http.Server 기반 통합 테스트가 동일하게 동작하도록 하는 인메모리 디스패처 폴백.
 * 일반 환경에서는 기본 fetch(실제 소켓)를 그대로 사용하고, EACCES/EPERM 일 때만 동작한다.
 */
import { Server } from 'node:http';
import { Readable } from 'node:stream';

const servers = new Map();
const origListen = Server.prototype.listen;
const origClose = Server.prototype.close;

Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const addr = this.address();
    if (addr && typeof addr === 'object' && addr.port) {
      servers.set(addr.port, this);
    }
  });
  return origListen.apply(this, args);
};

Server.prototype.close = function (...args) {
  const addr = this.address?.();
  if (addr && typeof addr === 'object' && addr.port) {
    servers.delete(addr.port);
  }
  return origClose.apply(this, args);
};

const origFetch = globalThis.fetch;

async function dispatchInMemory(server, port, urlObj, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const rawHeaders = {};
  if (init.headers) {
    const entries = init.headers instanceof Headers || typeof init.headers.entries === 'function'
      ? init.headers.entries()
      : Array.isArray(init.headers)
        ? init.headers
        : Object.entries(init.headers);
    for (const [k, v] of entries) rawHeaders[k.toLowerCase()] = String(v);
  }
  rawHeaders.host ??= `${urlObj.hostname}:${port}`;

  let bodyBuf = Buffer.alloc(0);
  if (init.body !== undefined && init.body !== null) {
    bodyBuf = Buffer.isBuffer(init.body)
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : Buffer.from(String(init.body), 'utf8');
    rawHeaders['content-length'] ??= String(bodyBuf.length);
  }

  return new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return reject(err);
    }

    const req = new Readable({
      read() {
        if (bodyBuf.length) this.push(bodyBuf);
        this.push(null);
      },
    });
    req.method = method;
    req.url = urlObj.pathname + urlObj.search;
    req.headers = rawHeaders;
    req.socket = { remoteAddress: '127.0.0.1', localPort: port };
    req.connection = req.socket;
    req.destroy = () => {};

    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      finished = true;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = String(v);
      },
      getHeader(k) {
        return resHeaders[k.toLowerCase()];
      },
      writeHead(code, headers = {}) {
        statusCode = code;
        this.statusCode = code;
        this.headersSent = true;
        for (const [k, v] of Object.entries(headers)) {
          resHeaders[k.toLowerCase()] = String(v);
        }
        return this;
      },
      write(chunk) {
        this.headersSent = true;
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        return true;
      },
      end(chunk) {
        if (finished) return this;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        this.headersSent = true;
        const fullBody = Buffer.concat(chunks);
        // 204, 304, HEAD 등은 body가 없어야 Response 생성자가 에러를 내지 않음
        const nullBody = statusCode === 204 || statusCode === 205 || statusCode === 304 || method === 'HEAD';
        resolve(new Response(nullBody ? null : fullBody, { status: statusCode, headers: resHeaders }));
        return this;
      },
    };

    try {
      server.emit('request', req, res);
    } catch (e) {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    }
  });
}

globalThis.fetch = async function patchedFetch(input, init) {
  try {
    return await origFetch(input, init);
  } catch (err) {
    const code = err?.cause?.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!urlStr) throw err;
    const urlObj = new URL(urlStr);
    if (urlObj.hostname !== '127.0.0.1' && urlObj.hostname !== 'localhost') throw err;
    const port = Number(urlObj.port) || 80;
    const server = servers.get(port);
    if (!server) throw err;
    return dispatchInMemory(server, port, urlObj, init);
  }
};
