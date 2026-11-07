/**
 * 학습 도우미 챗봇 서버 테스트 — 진짜 Gemini 대신 가짜(mock) 서버를 띄워서 검사한다.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server.js';
import { validatePayload, buildGeminiRequest, extractText, systemPrompt, PAGES } from '../server/chat.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

describe('챗봇 서버 (/api/chat)', () => {
  let app, appUrl, mock, mockUrl;
  let lastRequest = null;
  let mockReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '안녕하세요, ' }, { text: '도우미예요.' }] } }] } };
  const saved = {};

  before(async () => {
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(mockReply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockReply.body));
      });
    });
    mockUrl = await listen(mock);
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_BASE', 'GEMINI_MODEL']) saved[k] = process.env[k];
    app = createApp();
    appUrl = await listen(app);
  });

  after(() => {
    app.close();
    mock.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_API_BASE = mockUrl;
    delete process.env.GEMINI_MODEL;
    lastRequest = null;
    mockReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '안녕하세요, ' }, { text: '도우미예요.' }] } }] } };
  });

  const post = (payload) => fetch(`${appUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  test('질문을 Gemini 형식으로 바꿔 보내고 답을 합쳐서 돌려준다', async () => {
    const r = await post({ messages: [{ role: 'user', text: 'key 가 뭐야?' }], progress: ['1. 큰 그림'] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { text: '안녕하세요, 도우미예요.', model: 'gemini-flash-lite-latest', fallback: false });
    assert.equal(lastRequest.url, '/v1beta/models/gemini-flash-lite-latest:generateContent');
    assert.equal(lastRequest.headers['x-goog-api-key'], 'test-key', '키는 서버가 헤더로 붙인다');
    assert.deepEqual(lastRequest.body.contents, [{ role: 'user', parts: [{ text: 'key 가 뭐야?' }] }]);
    assert.match(lastRequest.body.systemInstruction.parts[0].text, /miniReact 학습 도우미/);
    assert.match(lastRequest.body.systemInstruction.parts[0].text, /- 1\. 큰 그림/, '진행 상황이 프롬프트에 들어감');
  });

  test('GEMINI_MODEL 로 모델을 바꿀 수 있다', async () => {
    process.env.GEMINI_MODEL = 'gemini-other';
    await post({ messages: [{ role: 'user', text: 'hi' }] });
    assert.equal(lastRequest.url, '/v1beta/models/gemini-other:generateContent');
  });

  test('상태 확인(GET)은 키 값을 절대 내보내지 않는다', async () => {
    const r = await fetch(`${appUrl}/api/chat`);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { enabled: true, model: 'gemini-flash-lite-latest', fallbacks: ['gemini-flash-latest'] });
    assert.ok(!text.includes('test-key'));
  });

  test('키가 없으면 503 NO_KEY, Gemini 는 호출하지 않음', async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await post({ messages: [{ role: 'user', text: 'hi' }] });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'NO_KEY');
    assert.equal(lastRequest, null);
    assert.equal((await (await fetch(`${appUrl}/api/chat`)).json()).enabled, false);
  });

  test('잘못된 요청은 400 (Gemini 호출 없음)', async () => {
    for (const bad of [{}, { messages: [] }, { messages: [{ role: 'admin', text: 'x' }] }, { messages: [{ role: 'user', text: 'x'.repeat(3000) }] }, { messages: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }] }]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
    }
    const notJson = await fetch(`${appUrl}/api/chat`, { method: 'POST', body: '{oops' });
    assert.equal(notJson.status, 400);
    assert.equal(lastRequest, null);
  });

  test('Gemini 오류는 502 와 이해할 수 있는 메시지로', async () => {
    mockReply = { status: 403, body: { error: { message: 'API key not valid.' } } };
    const r = await post({ messages: [{ role: 'user', text: 'hi' }] });
    assert.equal(r.status, 502);
    const { error } = await r.json();
    assert.match(error, /API key not valid/);
    assert.match(error, /API 키가 올바른지/);
  });

  test('빈 답변/차단된 답변도 에러 메시지로', async () => {
    mockReply = { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } };
    const r = await post({ messages: [{ role: 'user', text: 'hi' }] });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /SAFETY/);
  });

  test('.env 같은 비공개 파일과 서버 코드는 브라우저에 보이지 않는다', async () => {
    for (const p of ['/.env', '/.env.example', '/.gitignore', '/server/chat.js', '/node_modules/jsdom/package.json', '/%2e%2e/secret']) {
      const r = await fetch(`${appUrl}${p}`);
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
      await r.text();
    }
    const ok = await fetch(`${appUrl}/guide/index.html`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /chat\.js/);
  });
});

describe('챗봇 도우미 함수', () => {
  test('validatePayload', () => {
    assert.equal(validatePayload({ messages: [{ role: 'user', text: 'hi' }] }), null);
    assert.ok(validatePayload({ messages: Array.from({ length: 17 }, () => ({ role: 'user', text: 'x' })) }));
    assert.ok(validatePayload({ messages: [{ role: 'user', text: 'x' }], progress: 'not array' }));
  });

  test('buildGeminiRequest: 역할 매핑과 생성 설정', () => {
    const req = buildGeminiRequest({ messages: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }] });
    assert.deepEqual(req.contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.ok(req.generationConfig.maxOutputTokens > 0);
  });

  test('extractText', () => {
    assert.deepEqual(extractText({ candidates: [{ content: { parts: [{ text: ' x ' }] } }] }), { text: 'x' });
    assert.ok(extractText({}).error);
  });

  test('시스템 프롬프트에 모든 페이지 링크와 규칙이 들어 있다', () => {
    const p = systemPrompt();
    for (const [href] of PAGES) assert.ok(p.includes(`(${href})`), href);
    assert.match(p, /없는 주소를 지어내지 마라/);
    assert.match(p, /\(아직 없음\)/);
  });
});

describe('챗봇: 기본 모델이 바쁠 때 대체 모델', () => {
  let app, appUrl, mock, mockUrl;
  const calls = [];
  let busy = new Set();
  const saved = {};

  before(async () => {
    mock = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const model = req.url.match(/models\/([^:]+):/)[1];
        calls.push(model);
        if (busy.has(model)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: `${model} 답변` }] } }] }));
      });
    });
    mockUrl = await listen(mock);
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_BASE', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODELS']) saved[k] = process.env[k];
    app = createApp();
    appUrl = await listen(app);
  });
  after(() => {
    app.close();
    mock.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.GEMINI_API_BASE = mockUrl;
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODELS;
    calls.length = 0;
    busy = new Set();
  });
  const ask = async () => {
    const r = await fetch(`${appUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }) });
    return { status: r.status, body: await r.json() };
  };

  test('기본 모델이 503 이면 gemini-flash-latest 로 다시 시도', async () => {
    busy = new Set(['gemini-flash-lite-latest']);
    const { status, body } = await ask();
    assert.equal(status, 200);
    assert.deepEqual(calls, ['gemini-flash-lite-latest', 'gemini-flash-latest']);
    assert.deepEqual(body, { text: 'gemini-flash-latest 답변', model: 'gemini-flash-latest', fallback: true });
  });

  test('기본 모델이 되면 대체 모델은 부르지 않음', async () => {
    const { body } = await ask();
    assert.deepEqual(calls, ['gemini-flash-lite-latest']);
    assert.equal(body.fallback, false);
  });

  test('모두 바쁘면 502 와 안내 문구', async () => {
    busy = new Set(['gemini-flash-lite-latest', 'gemini-flash-latest']);
    const { status, body } = await ask();
    assert.equal(status, 502);
    assert.match(body.error, /모든 모델이 바쁩니다/);
    assert.equal(calls.length, 2);
  });

  test('GEMINI_FALLBACK_MODELS 로 순서를 바꾸거나 끌 수 있다', async () => {
    process.env.GEMINI_FALLBACK_MODELS = 'm2, m3';
    busy = new Set(['gemini-flash-lite-latest', 'm2']);
    assert.equal((await ask()).body.model, 'm3');
    calls.length = 0;
    process.env.GEMINI_FALLBACK_MODELS = '';
    busy = new Set(['gemini-flash-lite-latest']);
    assert.equal((await ask()).status, 502);
    assert.deepEqual(calls, ['gemini-flash-lite-latest']);
  });
});

describe('챗봇: 모든 페이지 + 지금 보는 페이지', async () => {
  const { readFileSync } = await import('node:fs');
  const { PAGES: NAV_PAGES } = await import('../tools/sync-nav.js');

  test('모든 페이지에 챗봇 CSS 와 JS 가 정확히 한 번씩 들어 있다', () => {
    for (const [page] of NAV_PAGES) {
      const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
      assert.equal((html.match(/tools\/chat\.js/g) || []).length, 1, page);
      assert.equal((html.match(/tools\/chat\.css/g) || []).length, 1, page);
    }
  });

  test('보고 있는 페이지가 시스템 프롬프트에 들어간다', () => {
    const req = buildGeminiRequest({ messages: [{ role: 'user', text: '이 페이지에서 뭘 해?' }], page: 'Phase 1 · Diff (/phase1/index.html)' });
    const prompt = req.systemInstruction.parts[0].text;
    assert.match(prompt, /## 학생이 지금 보고 있는 페이지\nPhase 1 · Diff \(\/phase1\/index\.html\)/);
    assert.match(systemPrompt(), /\(알 수 없음\)/);
  });

  test('페이지 정보가 이상하면 400', () => {
    assert.ok(validatePayload({ messages: [{ role: 'user', text: 'x' }], page: 'x'.repeat(200) }));
    assert.ok(validatePayload({ messages: [{ role: 'user', text: 'x' }], page: 42 }));
    assert.equal(validatePayload({ messages: [{ role: 'user', text: 'x' }], page: '홈 (/index.html)' }), null);
  });
});

describe('챗봇: 기본 모델이 너무 느릴 때', () => {
  let app, appUrl, mock, mockUrl;
  const calls = [];
  const saved = {};
  before(async () => {
    mock = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const model = req.url.match(/models\/([^:]+):/)[1];
        calls.push(model);
        const reply = () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: `${model} 답변` }] } }] }));
        };
        if (model === 'slow-model') setTimeout(reply, 600); // 시간 제한(100ms)보다 오래 걸림
        else reply();
      });
    });
    mockUrl = await listen(mock);
    for (const k of ['GEMINI_API_KEY', 'GEMINI_API_BASE', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODELS', 'GEMINI_TIMEOUT_MS']) saved[k] = process.env[k];
    app = createApp();
    appUrl = await listen(app);
  });
  after(() => {
    app.close();
    mock.closeAllConnections?.();
    mock.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const ask = async () => {
    const r = await fetch(`${appUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }) });
    return { status: r.status, body: await r.json() };
  };

  test('시간 제한을 넘기면 대체 모델로 넘어간다', async () => {
    Object.assign(process.env, { GEMINI_API_KEY: 'k', GEMINI_API_BASE: mockUrl, GEMINI_MODEL: 'slow-model', GEMINI_FALLBACK_MODELS: 'fast-model', GEMINI_TIMEOUT_MS: '100' });
    calls.length = 0;
    const { status, body } = await ask();
    assert.equal(status, 200);
    assert.deepEqual(calls, ['slow-model', 'fast-model']);
    assert.deepEqual(body, { text: 'fast-model 답변', model: 'fast-model', fallback: true });
  });

  test('모든 모델이 느리면 504 와 안내', async () => {
    Object.assign(process.env, { GEMINI_MODEL: 'slow-model', GEMINI_FALLBACK_MODELS: '', GEMINI_TIMEOUT_MS: '100' });
    const { status, body } = await ask();
    assert.equal(status, 504);
    assert.match(body.error, /너무 오래/);
  });
});
