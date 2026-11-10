import { h } from '../../core/vdom.js';
import { formatTime, formatWon } from '../format.js';

// 최근 주문 목록. 행마다 key = 주문 ID → 새 주문이 맨 위에 들어와도 기존 행은 그대로 두고 CREATE 1개로 끝난다
export function OrderTable({ orders, totalCount }) {
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' },
      h('h3', null, '최근 주문'),
      h('span', { class: 'card__hint' }, `${orders.length}건 표시 / 전체 ${totalCount}건`)),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'orders' },
        h('thead', null, h('tr', null, h('th', null, '주문'), h('th', null, '시각'), h('th', null, '고객'), h('th', null, '카테고리'), h('th', { class: 'num' }, '금액'))),
        h('tbody', null,
          orders.length === 0
            ? h('tr', { key: 'empty' }, h('td', { class: 'orders__empty', colspan: '5' }, '조건에 맞는 주문이 없습니다.'))
            : orders.map((order) =>
                h('tr', { key: order.id },
                  h('td', { class: 'mono' }, order.id),
                  h('td', { class: 'mono' }, formatTime(order.createdAt)),
                  h('td', null, order.customer),
                  h('td', null, h('span', { class: 'badge' }, order.category)),
                  h('td', { class: 'num mono' }, formatWon(order.amount)))))))
  );
}
