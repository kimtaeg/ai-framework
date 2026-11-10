import { h } from '../../core/vdom.js';
import { formatWon } from '../format.js';

// 카테고리별 합계 · 건수 · 평균 주문 금액 (App이 useMemo로 계산해 내려 준다)
export function CategoryStats({ rows }) {
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', null, '카테고리별 매출')),
    h('table', { class: 'orders' },
      h('thead', null, h('tr', null, h('th', null, '카테고리'), h('th', { class: 'num' }, '건수'), h('th', { class: 'num' }, '합계'), h('th', { class: 'num' }, '평균'))),
      h('tbody', null,
        rows.map((row) =>
          h('tr', { key: row.category },
            h('td', null, row.category),
            h('td', { class: 'num mono' }, String(row.count)),
            h('td', { class: 'num mono' }, formatWon(row.total)),
            h('td', { class: 'num mono' }, row.count ? formatWon(Math.round(row.total / row.count)) : '—')))))
  );
}
