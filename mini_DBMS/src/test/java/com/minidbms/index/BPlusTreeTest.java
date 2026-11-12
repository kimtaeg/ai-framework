package com.minidbms.index;

import com.minidbms.common.DuplicateKeyException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.Random;
import java.util.TreeMap;
import java.util.stream.IntStream;
import java.util.stream.LongStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BPlusTreeTest {
    private static BPlusTree<Integer, String> treeOf(int order, int... keys) {
        BPlusTree<Integer, String> tree = new BPlusTree<>(order);
        for (int key : keys) {
            tree.insert(key, "v" + key);
        }
        return tree;
    }

    // ---- 생성 ----

    @ParameterizedTest
    @ValueSource(ints = {-1, 0, 1, 2})
    void order가_3_미만이면_예외(int order) {
        assertThrows(IllegalArgumentException.class, () -> new BPlusTree<Integer, String>(order));
    }

    @Test
    void 빈_트리() {
        BPlusTree<Integer, String> tree = new BPlusTree<>(3);
        assertEquals(0, tree.size());
        assertEquals(1, tree.height());
        assertEquals(Optional.empty(), tree.search(1));
        assertEquals(List.of(), tree.range(0, 100));
        assertEquals("leaf []\n", tree.dump());
        BPlusTreeInvariants.check(tree);
    }

    // ---- 분할 과정 (order=3: 노드당 키 최대 2개, 3개가 되면 분할) ----

    @Test
    void 리프가_넘치기_전까지는_분할하지_않는다() {
        BPlusTree<Integer, String> tree = treeOf(3, 2, 1);
        assertEquals("leaf [1, 2]\n", tree.dump());
        assertEquals(1, tree.height());
    }

    @Test
    void 리프_분할은_오른쪽_첫_키를_부모로_복사한다() {
        // [1 2 3] → [1 2] [3], 3은 부모에도 리프에도 있다.
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3);
        assertEquals("""
                internal [3]
                  leaf [1, 2]
                  leaf [3]
                """, tree.dump());
        assertEquals(2, tree.height());
    }

    @Test
    void 두_번째_리프_분할은_부모에_경계_키를_추가한다() {
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3, 4, 5);
        assertEquals("""
                internal [3, 5]
                  leaf [1, 2]
                  leaf [3, 4]
                  leaf [5]
                """, tree.dump());
    }

    @Test
    void 내부_노드_분할은_가운데_키를_부모로_이동한다() {
        // 7 삽입: 리프 [5 6 7] 분할 → 부모 [3 5 7]이 넘침 → 5가 새 루트로 "이동"
        // 5는 루트와 리프에만 있고 중간 내부 노드 [3], [7]에는 없다.
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3, 4, 5, 6, 7);
        assertEquals("""
                internal [5]
                  internal [3]
                    leaf [1, 2]
                    leaf [3, 4]
                  internal [7]
                    leaf [5, 6]
                    leaf [7]
                """, tree.dump());
        assertEquals(3, tree.height());
        BPlusTreeInvariants.check(tree);
    }

    @Test
    void 역순_삽입의_분할() {
        // 5,4,3 → [3 4] [5] / 2 → [2 3] [4] [5] / 1 → [1 2] [3] [4] [5], 부모 [3 4 5]가 넘쳐 4가 이동
        BPlusTree<Integer, String> tree = treeOf(3, 5, 4, 3, 2, 1);
        assertEquals("""
                internal [4]
                  internal [3]
                    leaf [1, 2]
                    leaf [3]
                  internal [5]
                    leaf [4]
                    leaf [5]
                """, tree.dump());
        BPlusTreeInvariants.check(tree);
    }

    @Test
    void order_4는_리프를_2대2로_나눈다() {
        BPlusTree<Integer, String> tree = treeOf(4, 10, 20, 30, 40);
        assertEquals("""
                internal [30]
                  leaf [10, 20]
                  leaf [30, 40]
                """, tree.dump());
    }

    // ---- 검색·중복 ----

    @Test
    void 경계_키도_검색된다() {
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3, 4, 5, 6, 7);
        for (int key = 1; key <= 7; key++) {
            assertEquals(Optional.of("v" + key), tree.search(key));
        }
        assertEquals(Optional.empty(), tree.search(0));
        assertEquals(Optional.empty(), tree.search(8));
    }

    @Test
    void 중복_키는_DuplicateKeyException이고_트리는_바뀌지_않는다() {
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3);
        String before = tree.dump();

        DuplicateKeyException e = assertThrows(DuplicateKeyException.class, () -> tree.insert(3, "other"));
        assertTrue(e.getMessage().contains("3"), e.getMessage());
        assertEquals(before, tree.dump());
        assertEquals(3, tree.size());
        assertEquals(Optional.of("v3"), tree.search(3));
    }

    @Test
    void null_키와_값은_거부한다() {
        BPlusTree<Integer, String> tree = new BPlusTree<>(3);
        assertThrows(NullPointerException.class, () -> tree.insert(null, "a"));
        assertThrows(NullPointerException.class, () -> tree.insert(1, null));
        assertEquals(0, tree.size());
    }

    // ---- range ----

    @Test
    void range_경계값() {
        // 짝수 키만: 2, 4, ..., 40 (order 3이라 리프가 여러 개로 나뉨)
        BPlusTree<Integer, String> tree = new BPlusTree<>(3);
        for (int k = 2; k <= 40; k += 2) {
            tree.insert(k, "v" + k);
        }

        assertEquals(List.of("v4", "v6", "v8"), tree.range(4, 8), "양 끝 포함");
        assertEquals(List.of("v4", "v6", "v8"), tree.range(3, 9), "양 끝이 없는 키");
        assertEquals(List.of("v10"), tree.range(10, 10), "from == to");
        assertEquals(List.of(), tree.range(11, 11), "없는 단일 키");
        assertEquals(List.of(), tree.range(9, 5), "from > to");
        assertEquals(List.of("v2", "v4"), tree.range(Integer.MIN_VALUE, 4), "최솟값 아래부터");
        assertEquals(List.of("v38", "v40"), tree.range(38, Integer.MAX_VALUE), "최댓값 위까지");
        assertEquals(List.of(), tree.range(41, 100), "전부 최댓값보다 큼");
        assertEquals(List.of(), tree.range(-5, 1), "전부 최솟값보다 작음");
        assertEquals(20, tree.range(Integer.MIN_VALUE, Integer.MAX_VALUE).size(), "전체");
    }

    @Test
    void range는_리프_경계를_넘어_이어진다() {
        BPlusTree<Integer, String> tree = treeOf(3, 1, 2, 3, 4, 5, 6, 7);
        // 리프: [1 2] [3 4] [5 6] [7] — 세 리프를 걸친다.
        assertEquals(List.of("v2", "v3", "v4", "v5", "v6"), tree.range(2, 6));
    }

    // ---- 대량 ----

    @Test
    void 순차_삽입_100만개_후_모든_키를_찾는다() {
        int n = 1_000_000;
        BPlusTree<Long, Long> tree = new BPlusTree<>(64);
        for (long key = 1; key <= n; key++) {
            tree.insert(key, key * 10);
        }

        assertEquals(n, tree.size());
        for (long key = 1; key <= n; key++) {
            assertEquals(key * 10, tree.search(key).orElseThrow());
        }
        assertEquals(Optional.empty(), tree.search(0L));
        assertEquals(Optional.empty(), tree.search(n + 1L));
        assertEquals(LongStream.rangeClosed(500_000, 500_100).map(k -> k * 10).boxed().toList(),
                tree.range(500_000L, 500_100L));
        BPlusTreeInvariants.check(tree);
    }

    @ParameterizedTest
    @ValueSource(ints = {3, 4, 5, 64})
    void 무작위_삽입_10만개_후_모든_키를_찾고_없는_키는_empty(int order) {
        Random random = new Random(42);
        // 짝수만 넣어서 홀수는 반드시 없는 키가 되게 한다.
        List<Integer> keys = new ArrayList<>(IntStream.range(0, 100_000).map(i -> i * 2).boxed().toList());
        Collections.shuffle(keys, random);

        BPlusTree<Integer, Integer> tree = new BPlusTree<>(order);
        for (int key : keys) {
            tree.insert(key, -key);
        }

        assertEquals(keys.size(), tree.size());
        for (int key : keys) {
            assertEquals(-key, tree.search(key).orElseThrow());
            assertEquals(Optional.empty(), tree.search(key + 1));
        }
        BPlusTreeInvariants.check(tree);
    }

    @ParameterizedTest
    @ValueSource(ints = {3, 4, 7, 32})
    void 무작위_연산을_TreeMap과_비교한다(int order) {
        Random random = new Random(order);
        BPlusTree<Integer, Integer> tree = new BPlusTree<>(order);
        TreeMap<Integer, Integer> expected = new TreeMap<>();

        for (int op = 0; op < 50_000; op++) {
            int key = random.nextInt(20_000) - 10_000; // 음수 포함, 중복이 자주 나오는 범위
            switch (random.nextInt(3)) {
                case 0 -> {
                    if (expected.containsKey(key)) {
                        assertThrows(DuplicateKeyException.class, () -> tree.insert(key, key));
                    } else {
                        tree.insert(key, op);
                        expected.put(key, op);
                    }
                }
                case 1 -> assertEquals(Optional.ofNullable(expected.get(key)), tree.search(key));
                default -> {
                    int to = key + random.nextInt(500) - 50; // 가끔 from > to
                    List<Integer> want = key > to ? List.of() : List.copyOf(expected.subMap(key, true, to, true).values());
                    assertEquals(want, tree.range(key, to), "range(" + key + ", " + to + ")");
                }
            }
            assertEquals(expected.size(), tree.size());
        }

        BPlusTreeInvariants.check(tree);
        List<Integer> all = tree.range(Integer.MIN_VALUE, Integer.MAX_VALUE);
        assertEquals(List.copyOf(expected.values()), all);
    }

    @Test
    void 높이는_로그_수준으로_자란다() {
        BPlusTree<Integer, Integer> tree = new BPlusTree<>(4);
        for (int i = 1; i <= 10_000; i++) {
            tree.insert(i, i);
        }
        // order 4면 노드당 자식 2~4개이므로 높이는 log4(n) ~ log2(n) 사이
        assertTrue(tree.height() >= 7 && tree.height() <= 14, "height=" + tree.height());
        BPlusTreeInvariants.check(tree);
    }
}
