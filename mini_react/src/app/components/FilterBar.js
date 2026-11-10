import { h } from '../../core/vdom.js';

export const PERIODS = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '최근 7일' },
  { value: '30d', label: '최근 30일' },
];

export const SORTS = [
  { value: 'latest', label: '최신순' },
  { value: 'amount', label: '금액 높은순' },
];

function Select({ label, value, options, onChange }) {
  return h('label', { class: 'field' }, label,
    h('select', { value, onChange }, options.map((option) => h('option', { value: option.value }, option.label))));
}

// 카테고리 필터 · 기간 · 정렬. 바꾸면 App이 내려준 핸들러로 알린다 (상태는 App에)
export function FilterBar({ category, period, sort, categories, onCategory, onPeriod, onSort }) {
  return h(
    'div',
    { class: 'filter-bar' },
    h(Select, { label: '카테고리', value: category, onChange: onCategory, options: [{ value: 'all', label: '전체' }, ...categories.map((c) => ({ value: c, label: c }))] }),
    h(Select, { label: '기간', value: period, onChange: onPeriod, options: PERIODS }),
    h(Select, { label: '정렬', value: sort, onChange: onSort, options: SORTS })
  );
}
