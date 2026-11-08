import { describe, it, expect } from 'vitest';
import { parseHTML, HTMLParseError } from '../src/parseHTML.js';
import { toHTML } from '../src/toHTML.js';
import { h, render } from '../src/vdom.js';

describe('parseHTML', () => {
  it('루트 요소 하나를 VNode로 만든다 (앞뒤 공백·주석 무시)', () => {
    expect(parseHTML('\n  <!-- c -->\n<div id="a"><b>x</b></div>\n')).toEqual(
      h('div', { id: 'a' }, h('b', null, 'x'))
    );
  });

  it('void 태그와 self-closing은 닫는 태그가 필요 없다', () => {
    expect(() => parseHTML('<p><input type="checkbox" checked><br/><img src="a"></p>')).not.toThrow();
  });

  it.each([
    ['', '비어'],
    ['   \n\t ', '비어'],
    ['그냥 텍스트', '텍스트가 아니라'],
    ['<!-- 주석만 -->', '요소가 없습니다'],
    ['<p>a</p><p>b</p>', '하나여야'],
    ['<div><p>a</div>', '</div>이(가) 왔지만 <p>'],
    ['<div>a', '<div>의 닫는 태그가 없습니다'],
    ['<div>a</div></span>', '</span>에 맞는 여는 태그가 없습니다'],
    ['<div class="a"\n  <p>x</p></div>', "'>' 누락"],
    // 브라우저 파서는 통과시키지만 setAttribute가 InvalidCharacterError를 던지는 이름
    ['<div>\n  <button @click="go">x</button>\n</div>', '2번째 줄: "@click"은(는) 속성 이름으로 쓸 수 없습니다'],
    ['<p [title]="a">x</p>', '"[title]"은(는) 속성 이름으로 쓸 수 없습니다'],
  ])('잘못된 입력 %j → 에러', (source, message) => {
    expect(() => parseHTML(source)).toThrow(HTMLParseError);
    expect(() => parseHTML(source)).toThrow(message);
  });

  it('에러에 줄 번호가 붙는다', () => {
    try {
      parseHTML('<div>\n  <ul>\n    <li>a</li>\n</div>');
      expect.unreachable();
    } catch (e) {
      expect(e.line).toBe(4);
      expect(e.message).toMatch(/^4번째 줄/);
    }
  });

  it('속성값 안의 > 는 태그 끝으로 보지 않는다', () => {
    expect(parseHTML('<a title="a > b">x</a>')).toEqual(h('a', { title: 'a > b' }, 'x'));
  });
});

describe('toHTML', () => {
  it('들여쓰기해서 쓰고, 텍스트가 섞인 요소는 한 줄로 쓴다', () => {
    const vnode = h(
      'section',
      { id: 's' },
      h('p', null, '안녕 ', h('strong', null, '직접')),
      h('ul', null, h('li', { 'data-id': '1' }, 'a')),
      h('label', null, h('input', { type: 'checkbox', checked: '' }), ' 완료')
    );
    expect(toHTML(vnode)).toBe(
      [
        '<section id="s">',
        '  <p>안녕 <strong>직접</strong></p>',
        '  <ul>',
        '    <li data-id="1">a</li>',
        '  </ul>',
        '  <label><input type="checkbox" checked> 완료</label>',
        '</section>',
      ].join('\n')
    );
  });

  it('특수문자를 이스케이프해서 다시 파싱해도 같다', () => {
    const vnode = h('div', { title: 'a "b" & <c>' }, h('p', null, '1 < 2 & 3 > 2'), h('span'));
    expect(parseHTML(toHTML(vnode))).toEqual(vnode);
  });
});

describe('잘못된 속성 이름은 render 전에 막는다', () => {
  it('parseHTML이 에러를 내므로 render·patch까지 가지 않는다 (정상 이름은 그대로 통과)', () => {
    expect(() => render(parseHTML('<div data-ok="1" aria-label="a" xml:lang="ko">x</div>'))).not.toThrow();
    expect(() => parseHTML('<div @click="x">hi</div>')).toThrow(HTMLParseError);
  });
});
