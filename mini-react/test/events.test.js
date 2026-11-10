import { describe, it, expect, vi } from 'vitest';
import { setProp, removeProp, updateProps } from '../src/props.js';
import { h, render } from '../src/vdom.js';
import { diff, patch, PROPS } from '../src/diff.js';
import { parseHTML } from '../src/parseHTML.js';
import { toHTML } from '../src/toHTML.js';

const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

describe('이벤트 연결', () => {
  it('render하면 onClick이 click 리스너로 붙는다', () => {
    const handleClick = vi.fn();
    const el = render(h('button', { onClick: handleClick }, 'go'));
    click(el);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('onInput → input, onDoubleClick → dblclick 으로 바뀐다', () => {
    const handleInput = vi.fn();
    const handleDoubleClick = vi.fn();
    const el = render(h('input', { onInput: handleInput, onDoubleClick: handleDoubleClick }));
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new MouseEvent('dblclick'));
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('핸들러를 교체하면 새 핸들러만 호출된다', () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const el = render(h('button', { onClick: oldHandler }));

    updateProps(el, { onClick: oldHandler }, { onClick: newHandler });
    click(el);

    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  it('핸들러를 제거하면 더 이상 호출되지 않는다', () => {
    const handleClick = vi.fn();
    const el = render(h('button', { onClick: handleClick }));

    updateProps(el, { onClick: handleClick }, {});
    click(el);

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('null/false로 바꾸거나 removeProp해도 떼어진다', () => {
    const handleClick = vi.fn();
    const el = document.createElement('button');

    setProp(el, 'onClick', handleClick);
    setProp(el, 'onClick', false);
    click(el);
    setProp(el, 'onClick', handleClick);
    removeProp(el, 'onClick');
    click(el);

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('같은 함수로 여러 번 setProp해도 한 번만 호출된다', () => {
    const handleClick = vi.fn();
    const el = document.createElement('button');
    setProp(el, 'onClick', handleClick);
    setProp(el, 'onClick', handleClick);
    click(el);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('리스너는 DOM 변경이 아니라 속성이 생기지 않는다', () => {
    const el = render(h('button', { onClick: () => {} }));
    expect(el.attributes.length).toBe(0);
  });
});

describe('diff/patch와 함께', () => {
  // 컴포넌트처럼 매 렌더마다 새 함수를 만든다. 함수는 그 시점의 count를 기억(클로저)한다.
  function view(count, log) {
    return h('button', { onClick: () => log.push(count) }, `클릭 ${count}`);
  }

  it('매 렌더 새 함수는 PROPS로 잡히고, patch 후에는 최신 클로저만 호출된다', () => {
    const log = [];
    const container = document.createElement('div');
    const v0 = view(0, log);
    container.appendChild(render(v0));
    const button = container.firstChild;

    const v1 = view(1, log);
    const patches = diff(v0, v1);
    expect(patches.filter((p) => p.type === PROPS)).toHaveLength(1);
    expect(patches.find((p) => p.type === PROPS).changes.map((c) => c.key)).toEqual(['onClick']);

    patch(container, patches);
    click(button);

    // 옛 핸들러(0)가 남아 있으면 [0, 1], 갱신이 안 되면 [0]이 된다
    expect(log).toEqual([1]);
    expect(container.firstChild).toBe(button); // 버튼은 새로 만들지 않고 그대로
  });

  it('같은 함수 참조를 넘기면 patch가 나오지 않는다', () => {
    const handleClick = () => {};
    expect(diff(h('button', { onClick: handleClick }), h('button', { onClick: handleClick }))).toEqual([]);
  });

  it('핸들러가 사라지는 patch 후에는 호출되지 않는다', () => {
    const handleClick = vi.fn();
    const container = document.createElement('div');
    const v0 = h('button', { onClick: handleClick });
    container.appendChild(render(v0));

    patch(container, diff(v0, h('button', null)));
    click(container.firstChild);

    expect(handleClick).not.toHaveBeenCalled();
  });
});

describe('문자열 핸들러는 실행하지 않는다', () => {
  it('HTML에서 온 onclick="..."은 속성으로도, 리스너로도 붙지 않는다', () => {
    const vnode = parseHTML('<button onclick="window.__hacked = true">x</button>');
    const el = render(vnode);
    click(el);
    expect(el.hasAttribute('onclick')).toBe(false);
    expect(window.__hacked).toBeUndefined();
  });

  it('onClick에 문자열을 넘겨도 무시한다', () => {
    const el = render(h('button', { onClick: 'alert(1)' }));
    expect(() => click(el)).not.toThrow();
    expect(el.attributes.length).toBe(0);
  });
});

describe('toHTML', () => {
  it('함수 prop은 HTML로 쓰지 않는다', () => {
    expect(toHTML(h('button', { id: 'b', onClick: () => {} }, 'go'))).toBe('<button id="b">go</button>');
  });
});
