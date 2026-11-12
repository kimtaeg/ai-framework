package com.minidbms.index;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 테스트용 B+ 트리 불변식 검사기.
 * <ol>
 *   <li>모든 리프의 깊이가 같고, 그 깊이가 height()와 같다</li>
 *   <li>노드 안의 키는 엄격한 오름차순</li>
 *   <li>내부 노드: 자식 수 = 키 수 + 1, 자식 i의 키는 [keys[i-1], keys[i]) 범위</li>
 *   <li>키 수: 최대 order-1, 루트가 아니면 최소치 이상 (삽입만 하므로 분할 결과가 최소치)</li>
 *   <li>리프 next 연결을 따라가면 모든 키가 정렬 순서로 정확히 size()개 나온다</li>
 * </ol>
 */
final class BPlusTreeInvariants {
    private BPlusTreeInvariants() {
    }

    static <K extends Comparable<K>, V> void check(BPlusTree<K, V> tree) {
        List<LeafNode<K, V>> leavesInTreeOrder = new ArrayList<>();
        checkNode(tree, tree.root(), null, null, 1, true, leavesInTreeOrder);

        // 리프 연결 리스트가 트리의 왼쪽→오른쪽 리프 순서와 같아야 한다.
        LeafNode<K, V> leaf = leavesInTreeOrder.get(0);
        List<K> chainKeys = new ArrayList<>();
        int index = 0;
        while (leaf != null) {
            assertTrue(index < leavesInTreeOrder.size(), "리프 연결이 트리 밖의 노드로 이어진다");
            assertTrue(leaf == leavesInTreeOrder.get(index), "리프 연결 순서가 트리 순서와 다르다 (리프 " + index + ")");
            chainKeys.addAll(leaf.keys);
            leaf = leaf.next;
            index++;
        }
        assertEquals(leavesInTreeOrder.size(), index, "리프 연결이 중간에 끊겼다");
        assertEquals(tree.size(), chainKeys.size(), "리프의 키 수가 size()와 다르다");
        for (int i = 1; i < chainKeys.size(); i++) {
            assertTrue(chainKeys.get(i - 1).compareTo(chainKeys.get(i)) < 0,
                    "리프 연결 순서가 정렬 순서가 아니다: " + chainKeys.get(i - 1) + " → " + chainKeys.get(i));
        }
    }

    /** @param low 이 서브트리 키의 하한(포함), high 상한(미포함). null이면 제한 없음 */
    private static <K extends Comparable<K>, V> void checkNode(BPlusTree<K, V> tree, Node<K, V> node, K low, K high,
                                                               int depth, boolean isRoot, List<LeafNode<K, V>> leaves) {
        int order = tree.order();
        int keyCount = node.keys.size();
        assertTrue(keyCount <= order - 1, "키가 order-1개를 넘는다: " + node.keys);
        for (int i = 0; i < keyCount; i++) {
            K key = node.keys.get(i);
            if (i > 0) {
                assertTrue(node.keys.get(i - 1).compareTo(key) < 0, "노드 안 키가 정렬되지 않았다: " + node.keys);
            }
            if (low != null) {
                assertTrue(key.compareTo(low) >= 0, key + " < 하한 " + low);
            }
            if (high != null) {
                assertTrue(key.compareTo(high) < 0, key + " >= 상한 " + high);
            }
        }

        if (node instanceof LeafNode<K, V> leaf) {
            assertEquals(tree.height(), depth, "리프 깊이가 다르다: " + leaf.keys);
            assertEquals(keyCount, leaf.values.size(), "키와 값 개수가 다르다");
            if (!isRoot) {
                assertTrue(keyCount >= order / 2, "리프 키가 최소치(" + order / 2 + ")보다 적다: " + leaf.keys);
            }
            leaves.add(leaf);
            return;
        }

        InternalNode<K, V> internal = (InternalNode<K, V>) node;
        assertEquals(keyCount + 1, internal.children.size(), "자식 수가 키 수 + 1이 아니다: " + internal.keys);
        if (isRoot) {
            assertTrue(keyCount >= 1, "내부 루트에 키가 없다");
        } else {
            int min = (order + 1) / 2 - 1;
            assertTrue(keyCount >= min, "내부 노드 키가 최소치(" + min + ")보다 적다: " + internal.keys);
        }
        for (int i = 0; i < internal.children.size(); i++) {
            K childLow = i == 0 ? low : internal.keys.get(i - 1);
            K childHigh = i == keyCount ? high : internal.keys.get(i);
            Node<K, V> child = internal.children.get(i);
            if (child.keys.isEmpty()) {
                fail("빈 자식 노드");
            }
            checkNode(tree, child, childLow, childHigh, depth + 1, false, leaves);
        }
    }
}
