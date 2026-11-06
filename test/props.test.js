import { describe, it, expect } from 'vitest';
import { setProp, removeProp, updateProps } from '../src/props.js';
import { h, render } from '../src/vdom.js';
import { toVNode } from '../src/domToVNode.js';

describe('key', () => {
  it('render할 때 DOM 속성으로 그리지 않는다', () => {
    const el = render(h('li', { key: 'a', id: 'x' }, 'A'));
    expect(el.hasAttribute('key')).toBe(false);
    expect(el.getAttribute('id')).toBe('x');
  });

  it('setProp/removeProp/updateProps 모두 무시한다', () => {
    const el = document.createElement('li');
    setProp(el, 'key', 1);
    expect(el.hasAttribute('key')).toBe(false);

    el.setAttribute('key', 'manual');
    removeProp(el, 'key');
    expect(el.getAttribute('key')).toBe('manual');

    const fresh = document.createElement('li');
    updateProps(fresh, { key: 'a' }, { key: 'b' });
    expect(fresh.hasAttribute('key')).toBe(false);
  });
});

describe('on으로 시작하는 prop', () => {
  it('지금은 속성으로 그리지 않는다', () => {
    const el = render(h('button', { onClick: () => {}, onclick: 'alert(1)' }, 'go'));
    expect(el.hasAttribute('onclick')).toBe(false);
    expect(el.attributes.length).toBe(0);
  });
});

describe('value', () => {
  it('render하면 프로퍼티(화면 값)에 반영된다', () => {
    const el = render(h('input', { value: 'hello' }));
    expect(el.value).toBe('hello');
  });

  it('사용자가 입력한 뒤에도 patch로 바꾸면 화면 값이 바뀐다', () => {
    const el = render(h('input', { value: 'a' }));
    el.value = '사용자 입력'; // 이 순간부터 속성을 바꿔도 화면 값은 안 바뀐다
    el.setAttribute('value', 'attr-only');
    expect(el.value).toBe('사용자 입력');

    updateProps(el, { value: 'a' }, { value: 'b' });
    expect(el.value).toBe('b');
  });

  it('VNode 값이 그대로여도 화면 값이 달라졌으면 되돌린다', () => {
    const el = render(h('input', { value: 'fixed' }));
    el.value = 'typed';
    updateProps(el, { value: 'fixed' }, { value: 'fixed' });
    expect(el.value).toBe('fixed');
  });

  it('removeProp하면 화면 값이 비워진다', () => {
    const el = render(h('input', { value: 'x' }));
    removeProp(el, 'value');
    expect(el.value).toBe('');
    expect(el.hasAttribute('value')).toBe(false);
  });

  it('textarea도 프로퍼티로 반영된다', () => {
    const el = render(h('textarea', { value: '본문' }));
    expect(el.value).toBe('본문');
  });

  it('select는 option이 있어야 value가 맞는다', () => {
    const el = render(
      h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'))
    );
    expect(el.value).toBe('b');
  });
});

describe('checked', () => {
  it('true면 체크, false면 해제 (속성도 같이 맞춘다)', () => {
    const on = render(h('input', { type: 'checkbox', checked: true }));
    expect(on.checked).toBe(true);
    expect(on.hasAttribute('checked')).toBe(true);

    const off = render(h('input', { type: 'checkbox', checked: false }));
    expect(off.checked).toBe(false);
    expect(off.hasAttribute('checked')).toBe(false);
  });

  it('toVNode에서 온 checked: "" 도 체크로 본다', () => {
    const el = render(h('input', { type: 'checkbox', checked: '' }));
    expect(el.checked).toBe(true);
  });

  it('사용자가 클릭으로 바꾼 뒤에도 patch로 해제/체크된다', () => {
    const el = render(h('input', { type: 'checkbox', checked: true }));

    updateProps(el, { type: 'checkbox', checked: true }, { type: 'checkbox', checked: false });
    expect(el.checked).toBe(false);

    el.checked = true; // 사용자가 다시 체크 → 이후 속성 변화는 화면에 안 먹는다
    updateProps(el, { type: 'checkbox', checked: false }, { type: 'checkbox', checked: false });
    expect(el.checked).toBe(false);
  });

  it('prop이 사라지면 해제된다', () => {
    const el = render(h('input', { type: 'checkbox', checked: true }));
    updateProps(el, { type: 'checkbox', checked: true }, { type: 'checkbox' });
    expect(el.checked).toBe(false);
  });
});

describe('일반 속성', () => {
  it('false/null/undefined는 속성을 지우고 true는 빈 값 속성이 된다', () => {
    const el = render(h('button', { disabled: true, hidden: false, title: null }));
    expect(el.getAttribute('disabled')).toBe('');
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);

    setProp(el, 'disabled', false);
    expect(el.disabled).toBe(false);
  });

  it('updateProps는 추가/변경/삭제를 반영한다', () => {
    const el = render(h('div', { id: 'a', class: 'old', title: 't' }));
    updateProps(el, { id: 'a', class: 'old', title: 't' }, { id: 'a', class: 'new', role: 'list' });
    expect(toVNode(el).props).toEqual({ id: 'a', class: 'new', role: 'list' });
  });
});
