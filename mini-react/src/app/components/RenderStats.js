import { h } from '../../core/vdom.js';

const COUNT_ROWS = [
  ['created', 'CREATE'],
  ['removed', 'REMOVE'],
  ['replaced', 'REPLACE'],
  ['propsUpdated', 'UPDATE_PROPS'],
  ['textUpdated', 'UPDATE_TEXT'],
  ['moved', 'MOVE'],
];

const ms = (n) => `${n.toFixed(2)}ms`;

function Average({ label, summary }) {
  return h('div', { class: 'compare__col' },
    h('p', { class: 'compare__label' }, label),
    !summary.renders
      ? h('p', { class: 'muted' }, '아직 없음')
      : h('div', null,
          h('p', { class: 'compare__value' }, `DOM ${summary.avgMutations.toFixed(1)}개`),
          h('p', { class: 'muted' }, `${ms(summary.avgMs)} · ${summary.renders}회 평균`)));
}

// 마지막 렌더의 통계 + 비교 모드·배칭 토글.
// App 밖(별도 영역)에서 그린다: 렌더 통계를 App의 state에 넣으면 "통계 갱신 → 렌더 → 통계 갱신…"이 끝나지 않기 때문.
export function RenderStats({ info, mutations, comparison, renderMode, batching, onRenderMode, onBatching }) {
  return h(
    'section',
    { class: 'card render-stats' },
    h('div', { class: 'card__head' }, h('h3', null, 'RenderStats'), h('span', { class: 'card__hint' }, info ? `#${info.renderCount} ${info.type}` : '')),

    h('div', { class: 'toggles' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': '렌더 방식' },
        h('button', { type: 'button', class: renderMode === 'diff' ? 'is-active' : '', 'aria-pressed': String(renderMode === 'diff'), 'data-mode': 'diff', onClick: onRenderMode }, 'Diff 사용'),
        h('button', { type: 'button', class: renderMode === 'full' ? 'is-active' : '', 'aria-pressed': String(renderMode === 'full'), 'data-mode': 'full', onClick: onRenderMode }, '전체 다시 그리기')),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: batching, onChange: onBatching }), '배칭')),

    info === null
      ? h('p', { class: 'muted' }, '렌더 정보를 기다리는 중…')
      : h('div', null,
          h('dl', { class: 'kv' },
            h('dt', null, '누적 렌더'), h('dd', null, String(info.renderCount)),
            h('dt', null, '이번 렌더 방식'), h('dd', null, info.mode === 'full' ? '전체 다시 그리기' : 'Diff'),
            h('dt', null, '이번 동작의 렌더'), h('dd', { class: 'strong' }, `${info.rendersThisTurn ?? 1}번`),
            h('dt', null, '이 렌더에 묶인 setState'), h('dd', null, `${info.batchSize}번`),
            h('dt', null, '렌더 소요 시간'), h('dd', null, ms(info.durationMs)),
            h('dt', null, 'patch 개수'), h('dd', null, info.patches ? String(info.patches.length) : '— (diff 안 함)'),
            h('dt', null, '바뀐 DOM 노드 (자식 포함)'), h('dd', { class: 'strong' }, String(mutations.nodes))),
          info.counts
            ? h('ul', { class: 'chips' }, COUNT_ROWS.map(([key, label]) => h('li', { class: info.counts[key] ? 'chip is-on' : 'chip' }, `${label} ${info.counts[key]}`)))
            : null,
          h('p', { class: 'muted small' }, `MutationObserver 기록: 추가 ${mutations.added} · 삭제 ${mutations.removed} · 속성 ${mutations.attributes} · 텍스트 ${mutations.texts}`)),

    h('div', { class: 'compare' },
      h(Average, { label: 'Diff 사용 (update 평균)', summary: comparison.diff }),
      h(Average, { label: '전체 다시 그리기 (update 평균)', summary: comparison.full }))
  );
}
