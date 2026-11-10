// MutationObserver 기록(MutationRecord[]) → "실제 DOM에서 무엇이 몇 개 바뀌었나" 요약
//
//   added      새로 붙은 노드 수 (붙은 서브트리 안의 노드까지 전부)
//   removed    떨어져 나간 노드 수 (떨어진 서브트리 안의 노드까지 전부)
//   attributes 속성 변경 횟수
//   text       텍스트 노드 내용 변경 횟수
//   total      위 네 개의 합 = 변경된 노드 수

export const OBSERVE_OPTIONS = {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
};

export function summarizeMutations(records) {
  const summary = { added: 0, removed: 0, attributes: 0, text: 0, total: 0 };
  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of record.addedNodes) summary.added += countNodes(node);
      for (const node of record.removedNodes) summary.removed += countNodes(node);
    } else if (record.type === 'attributes') {
      summary.attributes++;
    } else if (record.type === 'characterData') {
      summary.text++;
    }
  }
  summary.total = summary.added + summary.removed + summary.attributes + summary.text;
  return summary;
}

// 노드 자신 + 모든 자손
function countNodes(node) {
  let count = 1;
  for (const child of node.childNodes) count += countNodes(child);
  return count;
}

// target 아래에서 fn이 일으킨 DOM 변경을 동기적으로 세어 돌려준다.
// 콜백은 마이크로태스크로 늦게 오므로 takeRecords()로 바로 꺼낸다.
export function measureMutations(target, fn) {
  const observer = new MutationObserver(() => {});
  observer.observe(target, OBSERVE_OPTIONS);
  try {
    fn();
    return summarizeMutations(observer.takeRecords());
  } finally {
    observer.disconnect();
  }
}
