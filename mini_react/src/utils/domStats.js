// Phase 1 검증 페이지와 대시보드가 함께 쓰는 "실제 DOM 변화" 도구

// MutationObserver 기록을 종류별로 센다. 같은 노드가 여러 번 기록돼도 한 번만 센다 (Set)
export function summarizeMutations(records) {
  const added = new Set();
  const removed = new Set();
  const attributes = new Set();
  const texts = new Set();
  for (const record of records) {
    if (record.type === 'childList') {
      record.addedNodes.forEach((node) => added.add(node));
      record.removedNodes.forEach((node) => removed.add(node));
    } else if (record.type === 'attributes') {
      attributes.add(record.target);
    } else if (record.type === 'characterData') {
      texts.add(record.target);
    }
  }
  const touched = new Set([...added, ...removed, ...attributes, ...texts]);

  // MutationObserver는 서브트리를 통째로 넣고 빼도 "루트 1개"로만 기록한다.
  // 전체 다시 그리기와 공정하게 비교하려고, 새로 만들거나 지운 노드는 그 자식까지 모두 센다
  const nodes = new Set([...attributes, ...texts]);
  for (const root of [...added, ...removed]) collectSubtree(root, nodes);

  return { added: added.size, removed: removed.size, attributes: attributes.size, texts: texts.size, total: touched.size, nodes: nodes.size };
}

function collectSubtree(node, into) {
  into.add(node);
  for (const child of node.childNodes) collectSubtree(child, into);
}

// patch vs innerHTML 비교용: 붙거나 떨어진 서브트리는 그 안의 노드까지 모두 센다.
// innerHTML로 통째 교체하면 기록은 "루트 1개 삭제 + 1개 추가"뿐이지만, 실제로는 그 아래 노드를 전부 버리고 새로 만든다.
export function summarizeDeep(records) {
  const added = new Set();
  const removed = new Set();
  const attributes = new Set();
  const texts = new Set();
  for (const record of records) {
    if (record.type === 'childList') {
      record.addedNodes.forEach((node) => collectSubtree(node, added));
      record.removedNodes.forEach((node) => collectSubtree(node, removed));
    } else if (record.type === 'attributes') {
      attributes.add(record.target);
    } else if (record.type === 'characterData') {
      texts.add(record.target);
    }
  }
  return {
    added: added.size,
    removed: removed.size,
    attributes: attributes.size,
    texts: texts.size,
    total: added.size + removed.size + attributes.size + texts.size,
  };
}

export const OBSERVE_ALL = Object.freeze({ subtree: true, childList: true, attributes: true, characterData: true });

// target 아래에서 change()가 일으킨 DOM 변경을 바로 센다 (콜백은 늦게 오므로 takeRecords로 꺼낸다)
export function measureDeep(target, change) {
  const observer = new MutationObserver(() => {});
  observer.observe(target, OBSERVE_ALL);
  try {
    change();
    return summarizeDeep(observer.takeRecords());
  } finally {
    observer.disconnect();
  }
}

export const EMPTY_MUTATIONS = Object.freeze({ added: 0, removed: 0, attributes: 0, texts: 0, total: 0, nodes: 0 });

// 바뀐 노드에 잠깐 노란 테두리. 속성을 건드리지 않도록 Web Animations API로만 그린다
// (class를 붙였다 떼면 그것도 DOM 변경이라 MutationObserver 숫자가 흐려진다)
export function flash(node, durationMs = 900) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  el?.animate?.(
    [{ outline: '3px solid #f59e0b', outlineOffset: '2px', backgroundColor: 'rgba(245, 158, 11, 0.18)' }, { outline: '3px solid transparent', outlineOffset: '2px' }],
    { duration: durationMs, easing: 'ease-out' }
  );
}
