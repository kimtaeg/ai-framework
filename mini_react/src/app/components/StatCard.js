import { h } from '../../core/vdom.js';

// 숫자 하나와 "직전 값 대비 증감". 값이 그대로면 아무 patch도 생기지 않는다
export function StatCard({ label, value, prevValue, format }) {
  const delta = value - prevValue;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const deltaText = delta === 0 ? '변화 없음' : `${delta > 0 ? '▲' : '▼'} ${format(Math.abs(delta))}`;
  return h(
    'article',
    { class: 'stat' },
    h('p', { class: 'stat__label' }, label),
    h('strong', { class: 'stat__value' }, format(value)),
    h('span', { class: `stat__delta is-${direction}` }, deltaText)
  );
}
