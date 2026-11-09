/**
 * Node 전용 가벼운 fetch — MiniRedisClient 의 { fetch } 옵션에 넣어서 쓴다
 * ------------------------------------------------------------------
 *   const cache = new MiniRedisClient('http://localhost:6380', { fetch: nodeFetch });
 *
 *  Node 내장 fetch(undici)는 웹 표준(스트림·Headers 객체 등)을 모두 갖추느라 요청 하나에 드는 CPU 가 크다.
 *  MiniRedisClient 는 "상태 코드 + JSON 본문" 만 쓰므로, node:http 로 연결을 재사용(keep-alive)하며
 *  그 두 가지만 돌려주면 충분하다. → 캐시 요청 하나당 API 서버의 CPU 사용이 줄어든다.
 *
 *  돌려주는 값: { status, ok, json(), text() }  (MiniRedisClient 가 쓰는 부분만)
 *  연결 실패는 fetch 와 같이 거부(reject)된다.
 */
import http from 'node:http';

const agent = new http.Agent({ keepAlive: true });

export function nodeFetch(url, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(url, { method, headers: h, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = chunks.length === 1 ? chunks[0].toString('utf8') : Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
