import { h } from '../../core/vdom.js';
import { formatWon } from '../format.js';

// 최근 매출 추이 막대 차트 (div 높이로 직접 그림). 막대마다 key = 점 id
// → 한 칸 밀릴 때 맨 앞 막대 삭제 + 새 막대 추가로 끝나고, 나머지 막대는 높이가 그대로면 건드리지 않는다
export function MiniChart({ points }) {
  const max = Math.max(...points.map((point) => point.amount), 1);
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h3', null, '최근 매출 추이'), h('span', { class: 'card__hint' }, `최근 ${points.length}건 · 최고 ${formatWon(max)}`)),
    h('div', { class: 'chart', role: 'img', 'aria-label': '최근 매출 막대 차트' },
      points.map((point) =>
        h('div', {
          key: String(point.id),
          class: 'chart__bar',
          title: formatWon(point.amount),
          style: { height: `${Math.max(4, Math.round((point.amount / max) * 100))}%` },
        })))
  );
}
