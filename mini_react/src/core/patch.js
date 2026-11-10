// diff가 만든 patch 목록을 실제 DOM에 적용하고, 종류별 변경 횟수를 돌려준다.
//
// container: VNode 루트가 그려져 있는 부모 요소 (container.firstChild = 루트 DOM).
//            루트를 통째로 바꾸는 REPLACE나, 빈 곳에 처음 그리는 CREATE도 처리하려면 루트의 부모가 필요하다.
//
// 적용 순서 — 왜 세 단계로 나누는가
//   1) 찾기: DOM을 하나도 바꾸기 전에, 모든 patch의 경로(이전 트리 기준)를 실제 노드 참조로 바꿔 둔다.
//      삭제·이동을 하면 인덱스가 밀리지만, 미리 잡아 둔 노드 참조는 변하지 않으므로 순서 걱정이 없어진다.
//   2) 제자리 변경: 삭제·교체·속성·텍스트. 노드의 위치를 바꾸지 않는 일부터 한다.
//   3) 자리 잡기: 부모마다 옮길 노드를 잠깐 떼어 낸 뒤, 옮길 노드와 새 노드를 "새 위치 순서대로" 끼워 넣는다.
//      그대로 둔 노드들은 이미 올바른 상대 순서이므로, 작은 위치부터 insertBefore하면 새 순서가 완성된다.

import { createElement } from './vdom.js';
import { setProp, removeProp } from './props.js';
import { CREATE, REMOVE, REPLACE, UPDATE_PROPS, UPDATE_TEXT, MOVE } from './diff.js';

function getNodeAt(container, path) {
  let node = container.firstChild;
  for (const index of path) node = node?.childNodes[index];
  if (!node) throw new Error(`실제 DOM에서 경로 [${path.join(', ')}]의 노드를 찾을 수 없습니다. DOM이 patch 밖에서 바뀌었을 수 있어요.`);
  return node;
}

export function applyPatches(container, patches, { onApply } = {}) {
  const counts = { created: 0, removed: 0, replaced: 0, propsUpdated: 0, textUpdated: 0, moved: 0 };
  const notify = (node, patch) => onApply?.(node, patch);

  // 1) 찾기 ─────────────────────────────────────────────
  const targets = patches.map((patch) => {
    switch (patch.type) {
      case CREATE: {
        const parent = patch.parentPath === null ? container : getNodeAt(container, patch.parentPath);
        return { patch, parent };
      }
      case MOVE: {
        const parent = getNodeAt(container, patch.parentPath);
        return { patch, parent, node: getNodeAt(container, [...patch.parentPath, patch.from]) };
      }
      default:
        return { patch, node: getNodeAt(container, patch.path) };
    }
  });

  // 2) 제자리 변경 ──────────────────────────────────────
  const replacedBy = new Map(); // 교체된 옛 노드 → 새 노드 (같은 항목이 MOVE도 되면 새 노드를 옮겨야 하므로)
  for (const { patch, node } of targets) {
    switch (patch.type) {
      case REMOVE:
        node.remove();
        counts.removed++;
        break;
      case REPLACE: {
        const newNode = createElement(patch.vnode);
        node.replaceWith(newNode);
        replacedBy.set(node, newNode);
        counts.replaced++;
        notify(newNode, patch);
        break;
      }
      case UPDATE_PROPS:
        for (const [name, value] of Object.entries(patch.set)) setProp(node, name, value);
        for (const name of patch.remove) removeProp(node, name);
        counts.propsUpdated++;
        notify(node, patch);
        break;
      case UPDATE_TEXT:
        node.nodeValue = patch.text;
        counts.textUpdated++;
        notify(node, patch);
        break;
      default:
        break; // CREATE·MOVE는 3단계에서
    }
  }

  // 3) 자리 잡기 ────────────────────────────────────────
  const placementsByParent = new Map(); // 부모 → [{ index, node, patch }]
  for (const { patch, parent, node } of targets) {
    if (patch.type !== CREATE && patch.type !== MOVE) continue;
    const placed = patch.type === CREATE ? createElement(patch.vnode) : (replacedBy.get(node) ?? node);
    if (patch.type === MOVE) placed.remove(); // 먼저 떼어 둬야 아직 안 옮긴 노드가 위치 계산을 흐리지 않는다
    if (!placementsByParent.has(parent)) placementsByParent.set(parent, []);
    placementsByParent.get(parent).push({ index: patch.index, node: placed, patch });
  }
  for (const [parent, placements] of placementsByParent) {
    placements.sort((a, b) => a.index - b.index);
    for (const { index, node, patch } of placements) {
      parent.insertBefore(node, parent.childNodes[index] ?? null);
      if (patch.type === CREATE) counts.created++;
      else counts.moved++;
      notify(node, patch);
    }
  }

  return counts;
}
