// 의존성 없는 개발 서버
//  - 정적 파일 제공 (ES Module 은 file:// 에서 로드되지 않으므로 필요)
//  - POST /api/chat : 학습 가이드 챗봇. API 키는 서버에만 두고 브라우저에는 절대 보내지 않는다.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChat } from './server/chat.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

/** .env 파일의 KEY=VALUE 를 환경 변수로 읽는다 (이미 설정된 값은 덮어쓰지 않음) */
export function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** 브라우저에 보여주면 안 되는 파일: .env 같은 점(.)으로 시작하는 파일/폴더, node_modules, 서버 코드 */
function isPrivate(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  return parts.some((p) => p.startsWith('.') || p === 'node_modules') || parts[0] === 'server';
}

export function createApp() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/chat') {
        await handleChat(req, res);
        return;
      }
      const path = decodeURIComponent(url.pathname);
      let file = normalize(join(ROOT, path));
      if (!(file === ROOT || file.startsWith(ROOT + sep)) || isPrivate(file.slice(ROOT.length))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
        return;
      }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  return server;
}

// node server.js 로 직접 실행했을 때만 서버를 띄운다 (테스트에서는 createApp 만 가져다 씀)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const PORT = 5200; 
  const app = createApp();
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.listen(PORT, () => {
    console.log(`mini-react dev server → http://localhost:${PORT}`);
    console.log(process.env.GEMINI_API_KEY ? '학습 도우미 챗봇: 사용 가능' : '학습 도우미 챗봇: 꺼짐 (.env 에 GEMINI_API_KEY 를 넣으면 켜집니다)');
  });
}
