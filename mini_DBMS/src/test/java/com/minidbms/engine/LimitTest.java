package com.minidbms.engine;

import com.minidbms.common.ParseException;
import com.minidbms.storage.Table;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LimitTest {
    @TempDir
    Path dataDir;

    DatabaseEngine engine;

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("t.schema"), "id:INT,v:INT");
        engine = new DatabaseEngine(dataDir);
        StringBuilder sql = new StringBuilder();
        for (int i = 1; i <= 100; i++) {
            sql.append("INSERT INTO t VALUES (").append(i % 10).append(");");
        }
        engine.execute(sql.toString());
    }

    @AfterEach
    void tearDown() {
        engine.close();
    }

    private QueryResult one(String sql) {
        return engine.execute(sql).get(0);
    }

    private static List<Object> ids(QueryResult result) {
        return result.rows().stream().map(r -> r.get(0)).toList();
    }

    // ---- LIMIT ----

    @Test
    void LIMIT은_모든_실행_경로에서_앞에서부터_n개만_돌려준다() {
        assertEquals(List.of(1L, 2L, 3L), ids(one("SELECT id FROM t LIMIT 3")));                        // FULL_SCAN
        assertEquals(List.of(5L, 15L), ids(one("SELECT id FROM t WHERE v = 5 LIMIT 2")));              // FULL_SCAN + 필터
        assertEquals(List.of(50L, 51L), ids(one("SELECT id FROM t WHERE id >= 50 LIMIT 2")));          // INDEX_RANGE
        assertEquals(List.of(7L), ids(one("SELECT id FROM t WHERE id = 7 LIMIT 5")));                  // INDEX_LOOKUP
        assertEquals(List.of(), ids(one("SELECT id FROM t LIMIT 0")));
        assertEquals(100, one("SELECT id FROM t LIMIT 1000").rows().size(), "행보다 큰 LIMIT");
        assertFalse(one("SELECT id FROM t LIMIT 3").truncated(), "LIMIT으로 줄인 것은 잘린 것이 아니다");
    }

    @Test
    void LIMIT_결과는_인덱스와_FULL_SCAN이_같다() {
        for (String sql : List.of("SELECT * FROM t WHERE id > 20 LIMIT 7", "SELECT * FROM t WHERE id BETWEEN 3 AND 90 LIMIT 1",
                "SELECT * FROM t WHERE id <= 50 LIMIT 0")) {
            List<List<Object>> viaIndex = one(sql).rows();
            engine.setIndexEnabled(false);
            List<List<Object>> viaScan = one(sql).rows();
            engine.setIndexEnabled(true);
            assertEquals(viaScan, viaIndex, sql);
        }
    }

    @Test
    void EXPLAIN에_LIMIT이_보인다() {
        assertTrue(one("EXPLAIN SELECT * FROM t WHERE id > 1 LIMIT 5").rows().get(0).get(2).toString().endsWith(", LIMIT 5"));
    }

    @Test
    void 음수_LIMIT은_ParseException() {
        assertThrows(ParseException.class, () -> engine.execute("SELECT * FROM t LIMIT -5"));
    }

    @Test
    void 필요한_행을_모으면_남은_파일을_읽지_않는다() {
        engine.close();
        try (Table table = Table.open(dataDir, "t")) {
            int[] visited = {0};
            table.scanWhile(record -> ++visited[0] < 3);
            assertEquals(3, visited[0], "세 번째 행에서 멈춰야 한다");

            int[] inRange = {0};
            table.rangeByIdWhile(10, 90, record -> ++inRange[0] < 2);
            assertEquals(2, inRange[0]);
        }
        engine = new DatabaseEngine(dataDir);
    }

    // ---- 최대 행 수 ----

    @Test
    void 최대_행_수를_넘으면_잘라서_truncated로_표시한다() {
        engine.setMaxResultRows(10);

        QueryResult all = one("SELECT id FROM t");
        assertEquals(10, all.rows().size());
        assertTrue(all.truncated());
        assertEquals(List.of(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L, 10L), ids(all));

        assertTrue(one("SELECT id FROM t WHERE id > 0").truncated(), "인덱스 경로도 같은 상한");
        assertTrue(one("SELECT id FROM t LIMIT 50").truncated(), "LIMIT이 상한보다 크면 상한이 이긴다");
        assertEquals(10, one("SELECT id FROM t LIMIT 50").rows().size());
    }

    @Test
    void 결과가_상한과_같거나_적으면_잘리지_않는다() {
        engine.setMaxResultRows(10);
        QueryResult exact = one("SELECT id FROM t WHERE v = 3");   // v=3인 행은 정확히 10개
        assertEquals(10, exact.rows().size());
        assertFalse(exact.truncated(), "딱 상한만큼이면 잘린 게 아니다(하나 더 읽어 보고 판단)");
        assertFalse(one("SELECT id FROM t LIMIT 10").truncated());
        assertFalse(one("SELECT id FROM t WHERE id = 99").truncated());
    }

    @Test
    void 최대_행_수는_1_이상() {
        assertThrows(IllegalArgumentException.class, () -> engine.setMaxResultRows(0));
    }
}
