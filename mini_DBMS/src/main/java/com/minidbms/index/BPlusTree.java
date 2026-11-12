package com.minidbms.index;

import com.minidbms.common.DuplicateKeyException;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Predicate;

/**
 * 메모리 기반 B+ 트리. 키는 유일하고, 값은 리프에만 있다.
 *
 * <p><b>order</b> = 노드 하나가 가질 수 있는 최대 자식 수. 따라서 노드의 키는 최대 order - 1개다.
 * 삽입으로 키가 order개가 되면(넘치면) 그 노드를 둘로 나눈다.
 *
 * <p><b>리프 분할</b> (키 order개 → 왼쪽 ceil(order/2)개, 오른쪽 나머지)
 * <pre>
 *   order=3, 3 삽입:  [1 2 3]  →  [1 2] → [3]     부모로 3을 "복사"해서 올린다
 * </pre>
 * 오른쪽 리프의 첫 키를 <b>복사</b>한다. 리프는 모든 (키, 값)을 들고 있어야 하므로 키가 리프에서 빠지면 안 된다.
 * 부모의 그 키는 "여기부터 오른쪽"이라는 경계 표시일 뿐이다.
 *
 * <p><b>내부 노드 분할</b> (키 order개 → 가운데 키 하나를 올리고 양쪽으로 나눔)
 * <pre>
 *   order=3:  [3 5 7] (자식 4개)  →  왼쪽 [3] (자식 2개),  오른쪽 [7] (자식 2개),  부모로 5를 "이동"
 * </pre>
 * 가운데 키를 <b>이동</b>한다. 내부 노드의 키는 길 안내용이라 부모에 한 번만 있으면 된다.
 * 남겨두면 자식 수가 키 수 + 1이라는 규칙이 깨진다.
 *
 * <p>루트가 분할되면 새 루트를 만들어 두 조각을 자식으로 단다. 트리는 이때만 높아지므로 모든 리프의 깊이가 항상 같다.
 *
 * <p>스레드 안전하지 않다. 동시 접근은 상위(테이블 락)에서 막는다.
 */
public final class BPlusTree<K extends Comparable<K>, V> {
    static final int MIN_ORDER = 3;

    private final int order;
    private Node<K, V> root = new LeafNode<>();
    private int height = 1;
    private long size;

    public BPlusTree(int order) {
        if (order < MIN_ORDER) {
            // order 2면 리프 분할 후 한쪽이 비고, 내부 노드는 키 1개로 분할할 수 없다.
            throw new IllegalArgumentException("B+ 트리 order는 " + MIN_ORDER + " 이상이어야 합니다: " + order);
        }
        this.order = order;
    }

    public int order() {
        return order;
    }

    /** 루트부터 리프까지의 노드 수. 리프 하나뿐이면 1 */
    public int height() {
        return height;
    }

    public long size() {
        return size;
    }

    Node<K, V> root() {
        return root;
    }

    /** 트리 모양 요약. 벤치마크·디버깅용 */
    public record Stats(long keys, int height, long internalNodes, long leafNodes, int order) {
        public long nodes() {
            return internalNodes + leafNodes;
        }
    }

    /** 모든 노드를 한 번 훑어 센다(O(노드 수)). 자주 부르는 용도가 아니다. */
    public Stats stats() {
        long[] counts = new long[2]; // [내부, 리프]
        countNodes(root, counts);
        return new Stats(size, height, counts[0], counts[1], order);
    }

    private static <K extends Comparable<K>, V> void countNodes(Node<K, V> node, long[] counts) {
        if (node.isLeaf()) {
            counts[1]++;
            return;
        }
        counts[0]++;
        for (Node<K, V> child : ((InternalNode<K, V>) node).children) {
            countNodes(child, counts);
        }
    }

    // ---- 조회 ----

    public Optional<V> search(K key) {
        Objects.requireNonNull(key, "key");
        LeafNode<K, V> leaf = findLeaf(key);
        int i = leaf.find(key);
        return i >= 0 ? Optional.of(leaf.values.get(i)) : Optional.empty();
    }

    /**
     * from 이상 to 이하인 키의 값을 키 순서대로 돌려준다.
     * from이 들어갈 리프까지 한 번만 내려간 뒤, 리프의 next를 따라 오른쪽으로 훑는다.
     */
    public List<V> range(K from, K to) {
        List<V> result = new ArrayList<>();
        forEachInRange(from, to, value -> {
            result.add(value);
            return true;
        });
        return result;
    }

    /**
     * range와 같은 순서로 값을 하나씩 넘기고, visitor가 false를 돌려주면 바로 멈춘다.
     * 결과 목록을 만들지 않으므로 LIMIT처럼 앞부분만 필요할 때 범위 전체를 메모리에 올리지 않는다.
     */
    public void forEachInRange(K from, K to, Predicate<V> visitor) {
        Objects.requireNonNull(from, "from");
        Objects.requireNonNull(to, "to");
        if (from.compareTo(to) > 0) {
            return;
        }
        LeafNode<K, V> leaf = findLeaf(from);
        int i = leaf.find(from);
        i = i >= 0 ? i : -(i + 1); // from이 없으면 from보다 큰 첫 키부터
        while (leaf != null) {
            for (; i < leaf.keys.size(); i++) {
                if (leaf.keys.get(i).compareTo(to) > 0 || !visitor.test(leaf.values.get(i))) {
                    return;
                }
            }
            leaf = leaf.next;
            i = 0;
        }
    }

    private LeafNode<K, V> findLeaf(K key) {
        Node<K, V> node = root;
        while (!node.isLeaf()) {
            InternalNode<K, V> internal = (InternalNode<K, V>) node;
            node = internal.children.get(internal.childIndex(key));
        }
        return (LeafNode<K, V>) node;
    }

    // ---- 삽입 ----

    public void insert(K key, V value) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(value, "value");
        Split<K, V> split = insert(root, key, value);
        if (split != null) {
            InternalNode<K, V> newRoot = new InternalNode<>();
            newRoot.keys.add(split.key());
            newRoot.children.add(root);
            newRoot.children.add(split.right());
            root = newRoot;
            height++;
        }
        size++;
    }

    /** 자식이 분할되면 부모에 끼워 넣을 (경계 키, 새 오른쪽 노드)를 돌려준다. 분할이 없으면 null */
    private record Split<K extends Comparable<K>, V>(K key, Node<K, V> right) {
    }

    private Split<K, V> insert(Node<K, V> node, K key, V value) {
        if (node.isLeaf()) {
            LeafNode<K, V> leaf = (LeafNode<K, V>) node;
            int i = leaf.find(key);
            if (i >= 0) {
                // 아무것도 바꾸기 전에 던지므로 트리는 삽입 전 그대로다.
                throw new DuplicateKeyException("이미 있는 키입니다: " + key);
            }
            int at = -(i + 1);
            leaf.keys.add(at, key);
            leaf.values.add(at, value);
            return leaf.keys.size() < order ? null : splitLeaf(leaf);
        }

        InternalNode<K, V> internal = (InternalNode<K, V>) node;
        int childIndex = internal.childIndex(key);
        Split<K, V> split = insert(internal.children.get(childIndex), key, value);
        if (split == null) {
            return null;
        }
        // 분할된 자식(childIndex)의 바로 오른쪽에 새 노드를, 둘 사이에 경계 키를 넣는다.
        internal.keys.add(childIndex, split.key());
        internal.children.add(childIndex + 1, split.right());
        return internal.keys.size() < order ? null : splitInternal(internal);
    }

    /** 리프 분할: 오른쪽 리프의 첫 키를 부모로 "복사" (리프에도 남는다) */
    private Split<K, V> splitLeaf(LeafNode<K, V> left) {
        int leftSize = (order + 1) / 2; // ceil(order / 2)
        LeafNode<K, V> right = new LeafNode<>();
        moveTail(left.keys, right.keys, leftSize);
        moveTail(left.values, right.values, leftSize);

        // 리프 연결 리스트에 끼워 넣는다: left → right → (원래 left.next)
        right.next = left.next;
        left.next = right;
        return new Split<>(right.keys.get(0), right);
    }

    /** 내부 노드 분할: 가운데 키를 부모로 "이동" (양쪽 어디에도 남지 않는다) */
    private Split<K, V> splitInternal(InternalNode<K, V> left) {
        int mid = order / 2;
        K promoted = left.keys.get(mid);
        InternalNode<K, V> right = new InternalNode<>();
        // 키: [0, mid) 왼쪽 · mid 위로 · (mid, order) 오른쪽
        moveTail(left.keys, right.keys, mid + 1);
        left.keys.remove(mid);
        // 자식: [0, mid] 왼쪽 · [mid + 1, order] 오른쪽
        moveTail(left.children, right.children, mid + 1);
        return new Split<>(promoted, right);
    }

    /** from[start..]를 to로 옮기고 from에서는 지운다. */
    private static <T> void moveTail(List<T> from, List<T> to, int start) {
        List<T> tail = from.subList(start, from.size());
        to.addAll(tail);
        tail.clear();
    }

    // ---- 디버깅 ----

    /**
     * 트리 구조를 들여쓰기로 출력한다. 키만 보여준다.
     * <pre>
     * internal [5]
     *   internal [3]
     *     leaf [1, 2]
     *     leaf [3, 4]
     *   ...
     * </pre>
     */
    public String dump() {
        StringBuilder out = new StringBuilder();
        dump(root, 0, out);
        return out.toString();
    }

    private void dump(Node<K, V> node, int depth, StringBuilder out) {
        out.append("  ".repeat(depth)).append(node.isLeaf() ? "leaf " : "internal ").append(node.keys).append('\n');
        if (!node.isLeaf()) {
            for (Node<K, V> child : ((InternalNode<K, V>) node).children) {
                dump(child, depth + 1, out);
            }
        }
    }
}
