import { h } from '../../core/vdom.js';

// 특정 데이터만 바꾸는 버튼들. 누른 뒤 "바뀐 곳만 깜빡이는지"를 보는 용도
export function ControlPanel({ onVisitors, onAddOrder, onChangeCategory, onTripleSetState, onTick }) {
  const button = (label, onClick, hint) => h('button', { type: 'button', class: 'btn', title: hint, onClick }, label);
  return h(
    'section',
    { class: 'card control-panel' },
    h('div', { class: 'card__head' }, h('h3', null, '데이터 바꿔 보기'), h('span', { class: 'card__hint' }, '바뀐 노드만 노랗게 깜빡입니다')),
    h('div', { class: 'control-panel__buttons' },
      button('방문자 수만 변경', onVisitors, '방문자 카드의 숫자만 바뀌어야 함'),
      button('주문 1건 추가', onAddOrder, '표에 행 1개 추가 + 매출·주문 수·차트'),
      button('카테고리 하나만 변경', onChangeCategory, '맨 위 주문의 카테고리 글자만'),
      button('setState 3번 (배칭 확인)', onTripleSetState, '방문자·주문·카테고리를 한 번에 → 렌더 1회 / 배칭 끄면 3회'),
      button('한 번 새로고침', onTick, '자동 새로고침 1회분'))
  );
}
