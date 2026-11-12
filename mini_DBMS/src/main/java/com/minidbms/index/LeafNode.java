package com.minidbms.index;

import java.util.ArrayList;
import java.util.List;

/**
 * 실제 (키, 값)을 담는 노드. keys.get(i)의 값이 values.get(i)다.
 * next로 오른쪽 형제 리프와 이어져 있어서, 범위 조회는 트리를 다시 내려가지 않고 리프만 따라간다.
 */
final class LeafNode<K extends Comparable<K>, V> extends Node<K, V> {
    final List<V> values = new ArrayList<>();
    LeafNode<K, V> next;

    @Override
    boolean isLeaf() {
        return true;
    }
}
