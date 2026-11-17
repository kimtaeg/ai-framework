/**
 * 챗봇 화면: 답변 속 링크 고치기 + 답변에 나온 탭 바로 가기
 * (실제 모델이 "탭 두 개를 추천하면서 링크는 하나만" 쓰는 경우가 있어서 추가)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CHAT_JS = readFileSync(new URL('../tools/chat.js', import.meta.url), 'utf8');

/** 저장된 대화를 넣고 챗봇을 열어 마지막 답변 요소를 돌려준다 */
function render(modelText, path = '/index.html') {
  const dom = new JSDOM('<!doctype html><body></body>', { url: `http://localhost:5200${path}`, runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('mini-react-guide-chat:v1', JSON.stringify([{ role: 'user', text: '질문' }, { role: 'model', text: modelText }]));
  w.fetch = () => new Promise(() => {}); // 상태 확인 요청은 응답하지 않게
  w.eval(CHAT_JS);
  w.document.querySelector('.chat-fab').click();
  const msgs = w.document.querySelectorAll('.chat-msg.model');
  return { msg: msgs[msgs.length - 1], api: w.__miniChat, dom };
}

describe('링크 주소 맞추기', () => {
  const { api, dom } = render('안녕');
  const cases = {
    '/mini_react/guide/index.html': '/mini_react/guide/index.html',
    'mini_react/guide/index.html': '/mini_react/guide/index.html',
    './deepdive/index.html#sync': '/mini_react/deepdive/index.html#sync',
    '../mini_react/theory/index.html#key': '/mini_react/theory/index.html#key',
    'http://localhost:5200/sandbox/index.html': '/mini_react/sandbox/index.html',
    'http://127.0.0.1:5200/examples/#ex-cart': '/mini_react/examples/index.html#ex-cart',
    '/mini_react/phase1': '/mini_react/phase1/index.html',
    'mini_react/phase2/': '/mini_react/phase2/index.html',
    '#roadmap': '#roadmap',
    'https://react.dev/learn': 'https://react.dev/learn',
  };
  for (const [input, want] of Object.entries(cases)) {
    test(`${input} → ${want}`, () => assert.equal(api.normalizeUrl(input), want));
  }
  test('위험하거나 외부 http 주소는 링크로 만들지 않는다', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/', '//evil.example/x']) {
      assert.equal(api.normalizeUrl(bad), null, bad);
    }
  });
  test.after?.(() => dom.window.close());
});

describe('답변 렌더링', () => {
  test('탭 두 개를 굵게만 쓰고 링크는 하나여도 바로 가기는 둘 다 나온다', () => {
    const { msg } = render('**Phase 1 · Diff Playground**와 **예제 모음**을 보세요.\n\n1. [Phase 1](/mini_react/phase1/index.html) 에서 이동 케이스');
    const tabs = [...msg.querySelectorAll('.chat-tabs a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(tabs, ['/mini_react/phase1/index.html', '/mini_react/examples/index.html']);
  });

  test('본문 링크는 여러 개 모두 링크가 되고, 상대 경로도 고쳐진다', () => {
    const { msg } = render('**[React 이론](/mini_react/theory/index.html#key)**과 [개념 더 파고들기](mini_react/deepdive/index.html#identity), [샌드박스](http://localhost:5200/sandbox/index.html)');
    const body = [...msg.querySelectorAll('p a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(body, ['/mini_react/theory/index.html#key', '/mini_react/deepdive/index.html#identity', '/mini_react/sandbox/index.html']);
    const tabs = [...msg.querySelectorAll('.chat-tabs a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(tabs, ['/mini_react/theory/index.html#key', '/mini_react/deepdive/index.html#identity', '/mini_react/sandbox/index.html'], '#위치까지 유지');
  });

  test('코드 블록 안의 이름은 탭으로 세지 않고, 탭이 없으면 바로 가기 줄도 없다', () => {
    const { msg } = render('useState 는 이렇게 씁니다.\n```js\n// 샌드박스 에서 해 보기\nconst [n, setN] = useState(0);\n```');
    assert.equal(msg.querySelector('.chat-tabs'), null);
  });

  test('지금 보고 있는 페이지는 표시해 준다', () => {
    const { msg } = render('[예제 모음](/mini_react/examples/index.html#ex-cart) 을 보세요', '/mini_react/examples/index.html');
    assert.match(msg.querySelector('.chat-tab').textContent, /지금 페이지/);
  });
});

describe('2주차 링크', () => {
  test('week2 경로와 끝이 / 인 주소를 맞춘다', () => {
    const { api, dom } = render('안녕');
    assert.equal(api.normalizeUrl('mini_redis/'), '/mini_redis/index.html');
    assert.equal(api.normalizeUrl('/mini_DBMS/phase2/#bptree'), '/mini_DBMS/phase2/index.html#bptree');
    assert.equal(api.normalizeUrl('../mini_redis/theory/index.html#ttl'), '/mini_redis/theory/index.html#ttl');
    assert.equal(api.normalizeUrl('index.html#week2'), '/index.html#week2');
    dom.window.close();
  });

  test('2주차 페이지 이름도 바로 가기가 되고, DBMS 의 "Phase 1" 은 1주차 페이지로 착각하지 않는다', () => {
    const { msg, dom } = render('**DBMS 이론** 의 Phase 1 SQL 처리기와 [B+ 트리](/mini_DBMS/phase2/index.html#bptree), 그리고 **레디스 예제** 를 보세요.');
    const tabs = [...msg.querySelectorAll('.chat-tabs a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(tabs, ['/mini_DBMS/theory/index.html', '/mini_DBMS/phase2/index.html#bptree', '/mini_redis/examples/index.html']);
    dom.window.close();
  });
});
