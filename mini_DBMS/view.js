// 미니 DBMS 실습 페이지 공용 그리기 도우미 (Phase 1 · 2 · 3)
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SELECT 결과 표 */
export function table(columns, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((v) => `<td class="mono">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}" class="muted">결과 없음</td></tr>`
  }</tbody></table></div>`;
}

/** B+ 트리를 층별로 그리기 (opts.path: 강조할 노드, hit: 찾은 키, fresh: 방금 넣은 키) */
export function treeHtml(t, opts = {}) {
  const pathSet = new Set(opts.path ?? []);
  let level = [t.root];
  let html = '';
  while (level.length) {
    html += `<div class="bpt-level">${level.map((n) => `<div class="bpt-node ${n.leaf ? 'leaf' : ''} ${pathSet.has(n) ? 'path' : ''} ${n.keys.includes(opts.fresh) && n.leaf ? 'new' : ''}">${
      n.keys.length ? n.keys.map((k) => `<span class="${opts.hit === k && n.leaf ? 'hit' : ''}">${k}</span>`).join('') : '<span class="muted">빈 트리</span>'
    }</div>`).join('')}</div>`;
    level = level.flatMap((n) => (n.leaf ? [] : n.children));
  }
  return html;
}
