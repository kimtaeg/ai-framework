import { h } from '../../core/vdom.js';

export const REFRESH_OPTIONS = [
  { value: 1000, label: '1초' },
  { value: 2000, label: '2초' },
  { value: 5000, label: '5초' },
];

// 제목 · 다크모드 토글 · 자동 새로고침 시작/정지 · 새로고침 주기
export function Header({ darkMode, autoRefresh, refreshMs, onToggleDark, onToggleAuto, onChangeRefresh }) {
  return h(
    'header',
    { class: 'dash-header' },
    h('div', { class: 'dash-header__title' },
      h('h2', null, '미니 대시보드'),
      h('p', { class: 'dash-header__sub' }, autoRefresh ? `자동 새로고침 중 · ${refreshMs / 1000}초마다` : '자동 새로고침 꺼짐')),
    h('div', { class: 'dash-header__controls' },
      h('button', { type: 'button', class: 'btn', 'aria-pressed': String(darkMode), onClick: onToggleDark }, darkMode ? '☀ 라이트' : '☾ 다크'),
      h('label', { class: 'field field--inline' }, '주기',
        h('select', { value: String(refreshMs), onChange: onChangeRefresh },
          REFRESH_OPTIONS.map((option) => h('option', { value: String(option.value) }, option.label)))),
      h('button', { type: 'button', class: autoRefresh ? 'btn btn--danger' : 'btn btn--primary', onClick: onToggleAuto },
        autoRefresh ? '■ 정지' : '▶ 자동 새로고침'))
  );
}
