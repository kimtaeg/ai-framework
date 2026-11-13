/**
 * 2주차 페이지: 파일로 열었을 때(bundle.js) 실험이 동작하는지, 홈의 과제 전환, 트랙별 메뉴·챗봇·링크
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { REDIS_PAGES, DBMS_PAGES, ALL_PAGES, PAGES } from '../tools/sync-nav.js';
import { openBundle } from './bundle-helper.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => el.dispatchEvent(new w.Event('click', { bubbles: true }));
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

describe('미니 레디스 Playground', () => {
  test('에러 없이 열리고 콘솔 명령이 실행된다', () => {
    const { w, d, errors, dom } = openBundle('week2/redis');
    try {
      assert.deepEqual(errors, []);
      for (const line of ['SET greeting "안녕 레디스" EX 30', 'GET greeting', 'NOPE']) {
        d.querySelector('#con-input').value = line;
        submit(w, d.querySelector('#con-form'));
      }
      const log = d.querySelector('#con-log').textContent;
      assert.match(log, /OK/);
      assert.match(log, /"안녕 레디스"/);
      assert.match(log, /\(error\)/);
      assert.match(d.querySelector('#keys-body').textContent, /greeting/);
    } finally {
      dom.window.close();
    }
  });

  test('1주차 Phase 페이지처럼: 위쪽 툴바 + 머리줄이 있는 카드 7개', () => {
    const { d, dom } = openBundle('week2/redis');
    try {
      assert.ok(d.querySelector('.toolbar.card'));
      const panels = d.querySelectorAll('section.card.panel');
      assert.equal(panels.length, 7);
      for (const p of panels) assert.ok(p.querySelector(':scope > .card-head .sub'), p.id);
      assert.equal(d.querySelector('.page-layout'), null, '예전 왼쪽 목차 없음');
    } finally {
      dom.window.close();
    }
  });

  test('해시 테이블: 키를 추가하면 버킷이 그려지고 확장이 시작된다', () => {
    const { w, d, dom } = openBundle('week2/redis');
    try {
      click(w, d.querySelector('#ht-reset'));
      for (let i = 0; i < 5; i++) click(w, d.querySelector('#ht-add1'));
      assert.equal(d.querySelectorAll('.ht-table').length, 2, '옛 테이블 + 새 테이블');
      assert.match(d.querySelector('#ht-stats').textContent, /원소 수5/);
    } finally {
      dom.window.close();
    }
  });

  test('동시성: INCR 은 하나도 잃지 않는다 · AOF: always 는 강제 종료에도 복원', async () => {
    const { w, d, dom } = openBundle('week2/redis');
    try {
      d.querySelector('#race-n').value = '40';
      click(w, d.querySelector('#race-incr'));
      for (let i = 0; i < 50 && !d.querySelector('#race-out').textContent; i++) await sleep(20);
      assert.match(d.querySelector('#race-out').textContent, /사라진 증가0/);
      d.querySelector('#aof-policy').value = 'always';
      click(w, d.querySelector('#aof-write'));
      click(w, d.querySelector('#aof-crash'));
      click(w, d.querySelector('#aof-restart'));
      assert.match(d.querySelector('#aof-result').textContent, /빠짐없이 복원/);
      assert.equal(d.querySelector('#api-live').hidden, true, '파일로 열면 서버 영역 숨김');
    } finally {
      dom.window.close();
    }
  });
});

describe('미니 DBMS Phase 1 · 2 · 3', () => {
  test('Phase 1: 첫 예시가 인덱스 조회, 모든 예시 실행, 에러 예시는 에러', () => {
    const { w, d, errors, dom } = openBundle('week2/dbms/phase1');
    try {
      assert.deepEqual(errors, []);
      assert.match(d.querySelector('#sql-out').textContent, /B\+ 트리 인덱스 조회/);
      assert.equal(d.querySelectorAll('#sql-files .hl').length, 1, '읽은 줄은 하나');
      const sel = d.querySelector('#sql-examples');
      for (const opt of [...sel.options]) {
        sel.value = opt.value;
        sel.dispatchEvent(new w.Event('change'));
        click(w, d.querySelector('#sql-run'));
        const out = d.querySelector('#sql-out').textContent;
        if (opt.value.startsWith('에러')) assert.match(out, /✗/, opt.value);
        else assert.doesNotMatch(out, /✗/, `${opt.value}: ${out}`);
      }
    } finally {
      dom.window.close();
    }
  });

  test('Phase 2: B+ 트리 삽입 · 검색 경로 · 중복 거절', () => {
    const { w, d, errors, dom } = openBundle('week2/dbms/phase2');
    try {
      assert.deepEqual(errors, []);
      d.querySelector('#bpt-key').value = '33';
      click(w, d.querySelector('#bpt-insert'));
      assert.match(d.querySelector('#bpt-msg').textContent, /33 삽입/);
      click(w, d.querySelector('#bpt-search'));
      assert.match(d.querySelector('#bpt-msg').textContent, /찾음/);
      assert.ok(d.querySelectorAll('.bpt-node.path').length >= 2);
      click(w, d.querySelector('#bpt-insert'));
      assert.match(d.querySelector('#bpt-msg').textContent, /이미 있습니다/);
    } finally {
      dom.window.close();
    }
  });

  test('Phase 3: 락을 켜면 id 가 겹치지 않는다', async () => {
    const { w, d, errors, dom } = openBundle('week2/dbms/phase3');
    try {
      assert.deepEqual(errors, []);
      click(w, d.querySelector('#sim-writes'));
      for (let i = 0; i < 300 && (d.querySelector('#sim-ids').textContent.match(/\d+/g) ?? []).length < 4; i++) await sleep(20);
      const ids = d.querySelector('#sim-ids').textContent;
      assert.match(ids, /1.*2.*3.*4/);
      assert.doesNotMatch(ids, /중복/);
    } finally {
      dom.window.close();
    }
  });

  test('Phase 페이지끼리 이동 막대가 있고 지금 Phase 가 표시된다', () => {
    for (const n of [1, 2, 3]) {
      const d = new JSDOM(read(`week2/dbms/phase${n}/index.html`)).window.document;
      const on = d.querySelector('.phase-steps a.on');
      assert.match(on.textContent, new RegExp(`Phase ${n}`));
      assert.equal(d.querySelectorAll('.phase-steps a').length, 3);
    }
  });
});

describe('홈: 왼쪽에서 과제 고르기', () => {
  const html = read('index.html').replace(/<script src[\s\S]*?<\/script>/g, '');
  const load = (hash = '') => new JSDOM(html, { url: `http://localhost/index.html${hash}`, runScripts: 'dangerously' });

  test('왼쪽에 1주차 · 2주차 레디스 · 2주차 DBMS 세 개', () => {
    const dom = load();
    const btns = [...dom.window.document.querySelectorAll('.week-btn')].map((b) => b.dataset.week);
    assert.deepEqual(btns, ['week1', 'redis', 'dbms']);
    dom.window.close();
  });

  for (const [hash, label] of [['#redis', '학습 가이드'], ['#dbms', 'Phase 1 · SQL'], ['#week2', '레디스 이론']]) {
    test(`${hash} 로 열면 그 패널과 그 메뉴만 보인다`, () => {
      const dom = load(hash);
      const d = dom.window.document;
      const want = hash === '#week2' ? 'redis' : hash.slice(1); // 예전 주소는 레디스로
      for (const id of ['week1', 'redis', 'dbms']) assert.equal(d.getElementById(id).hidden, id !== want, id);
      const visibleNav = [...d.querySelectorAll('.topbar nav')].filter((n) => !n.hidden);
      assert.equal(visibleNav.length, 1);
      assert.match(visibleNav[0].textContent, new RegExp(label));
      dom.window.close();
    });
  }

  test('버튼으로 바꿀 수 있고, 타일 링크가 모두 실제 파일을 가리킨다', () => {
    const dom = load();
    const d = dom.window.document;
    d.querySelector('[data-week="dbms"]').click();
    assert.equal(d.getElementById('dbms').hidden, false);
    assert.equal(d.querySelector('#brand span').textContent, 'DBMS');
    for (const a of d.querySelectorAll('a.tile')) assert.ok(existsSync(new URL(`../${a.getAttribute('href').replace('./', '')}`, import.meta.url)), a.getAttribute('href'));
    // 1주차와 같은 모양: 패널마다 hero + 타일 그리드 + 흐름 카드
    for (const id of ['week1', 'redis', 'dbms']) {
      const p = d.getElementById(id);
      assert.ok(p.querySelector('.hero h1 span') && p.querySelector('.grid .tile.start') && p.querySelector('.card.flow'), id);
    }
    dom.window.close();
  });
});

describe('메뉴 · 챗봇 · 링크', () => {
  test('레디스 · DBMS 페이지는 각자의 메뉴, 지금 페이지가 표시된다', () => {
    for (const [list, other] of [[REDIS_PAGES, 'Phase 1 · SQL'], [DBMS_PAGES, '레디스 이론']]) {
      for (const [page, label, opts] of list) {
        if (opts?.link) continue;
        const nav = read(page).match(/<nav>([\s\S]*?)<\/nav>/)[1];
        assert.match(nav, new RegExp(`aria-current="page">${label.replace(/[+.]/g, '\\$&')}<`), page);
        assert.doesNotMatch(nav, new RegExp(other), `${page}: 다른 트랙 메뉴가 아님`);
        assert.doesNotMatch(nav, /Phase 1 · Diff/, `${page}: 1주차 메뉴가 아님`);
      }
    }
  });

  test('메뉴 순서가 1주차와 같다 (홈 → 학습 가이드 → 실습 → 예제 → 샌드박스 → 코드 해설 → 이론 → 더 파고들기 → 한 장 요약 → 설명서)', () => {
    const shape = (list) => list.map(([p, label]) => (/phase|redis\/index|^phase\d/.test(p) ? '실습' : /이론/.test(label) ? '이론' : label));
    const squash = (a) => a.filter((x, i) => x !== a[i - 1]);
    const w1 = squash(shape(PAGES));
    assert.deepEqual(squash(shape(REDIS_PAGES)), w1);
    assert.deepEqual(squash(shape(DBMS_PAGES)), w1);
  });

  test('모든 페이지(1·2주차)에 챗봇이 한 번씩', () => {
    for (const [page] of ALL_PAGES) {
      const html = read(page);
      assert.equal(html.split('tools/chat.js').length - 1, 1, page);
      assert.equal(html.split('tools/chat.css').length - 1, 1, page);
    }
  });

  test('2주차 페이지의 내부 링크가 모두 있는 파일을 가리킨다', () => {
    for (const [page, , opts] of [...REDIS_PAGES, ...DBMS_PAGES]) {
      if (opts?.link) continue;
      const html = read(page);
      const base = new URL(`../${page}`, import.meta.url);
      for (const [, href] of html.matchAll(/(?:href|src)="([^"#:]+\.(?:html|css|js))(?:#[^"]*)?"/g)) {
        assert.ok(existsSync(new URL(href, base)), `${page} → ${href}`);
      }
    }
  });

  test('1주차 스타일 파일을 그대로 쓴다 (생김새가 같게)', () => {
    const uses = {
      guide: '../../../guide/guide.css', examples: '../../../examples/examples.css', sandbox: '../../../sandbox/sandbox.css',
      walkthrough: '../../../walkthrough/walkthrough.css', theory: '../../../theory/theory.css', deepdive: '../../../deepdive/deepdive.css',
    };
    for (const t of ['redis', 'dbms']) for (const [dir, css] of Object.entries(uses)) assert.match(read(`week2/${t}/${dir}/index.html`), new RegExp(css.replace(/[.\/]/g, '\\$&')), `${t}/${dir}`);
  });
});
