package com.minidbms.index;

import java.util.ArrayList;
import java.util.List;

/**
 * 길 안내만 하는 노드. children.size() == keys.size() + 1 이다.
 *
 * <pre>
 *          keys:   k0      k1
 *    children:  c0    c1      c2
 *
 *    c0 의 키 <  k0  <=  c1 의 키 <  k1  <=  c2 의 키
 * </pre>
 *
 * 경계 키와 같은 키는 오른쪽 자식에 있다. 리프 분할 때 오른쪽 리프의 첫 키를 복사해 올리기 때문이다.
 */
final class InternalNode<K extends Comparable<K>, V> extends Node<K, V> {
    final List<Node<K, V>> children = new ArrayList<>();

    @Override
    boolean isLeaf() {
        return false;
    }

    /** key를 찾으려면 내려가야 할 자식의 인덱스 */
    int childIndex(K key) {
        int i = find(key);
        // 경계 키와 정확히 같으면 그 키는 오른쪽 서브트리의 최솟값이므로 오른쪽(i + 1)으로 간다.
        // 일치하지 않으면 삽입 위치 = key보다 큰 첫 경계 키의 인덱스 = 내려갈 자식 인덱스다.
        return i >= 0 ? i + 1 : -(i + 1);
    }
}
