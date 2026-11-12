package com.minidbms.index;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * B+ 트리 노드의 공통 부분. 키는 항상 오름차순으로 유지한다.
 */
abstract class Node<K extends Comparable<K>, V> {
    final List<K> keys = new ArrayList<>();

    abstract boolean isLeaf();

    /**
     * 노드 안의 키를 이진 탐색한다. 규약은 Collections.binarySearch와 같다.
     *
     * @return 일치하는 키가 있으면 그 인덱스, 없으면 -(삽입 위치) - 1
     */
    int find(K key) {
        return Collections.binarySearch(keys, key);
    }
}
