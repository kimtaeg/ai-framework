package com.minidbms.engine;

import com.minidbms.common.TypeMismatchException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlannerTest {
    @TempDir
    Path dataDir;

    DatabaseEngine engine;

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING,age:INT");
        engine = new DatabaseEngine(dataDir);
    }

    @AfterEach
    void tearDown() {
        engine.close();
    }

    private QueryResult one(String sql) {
        return engine.execute(sql).get(0);
    }

    private void seed(int n) {
        StringBuilder sql = new StringBuilder();
        for (int i = 1; i <= n; i++) {
            // 나이는 일부 NULL, 이름은 중복 허용
            sql.append("INSERT INTO users VALUES ('u").append(i % 7).append("', ")
                    .append(i % 5 == 0 ? "NULL" : Integer.toString(i % 40)).append(");");
        }
        engine.execute(sql.toString());
    }

    // ---- 조건별 경로 ----

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "                                  | FULL_SCAN",
            "WHERE id = 3                      | INDEX_LOOKUP",
            "WHERE ID = 3                      | INDEX_LOOKUP",
            "WHERE id = NULL                   | INDEX_LOOKUP",
            "WHERE id < 3                      | INDEX_RANGE",
            "WHERE id <= 3                     | INDEX_RANGE",
            "WHERE id > 3                      | INDEX_RANGE",
            "WHERE id >= 3                     | INDEX_RANGE",
            "WHERE id BETWEEN 2 AND 4          | INDEX_RANGE",
            "WHERE id BETWEEN 4 AND 2          | INDEX_RANGE",
            "WHERE id != 3                     | FULL_SCAN",
            "WHERE id <> 3                     | FULL_SCAN",
            "WHERE age = 3                     | FULL_SCAN",
            "WHERE age BETWEEN 1 AND 3         | FULL_SCAN",
            "WHERE name = 'u1'                 | FULL_SCAN",
    })
    void 조건에_따라_실행_경로를_고른다(String where, AccessPath expected) {
        seed(10);
        String sql = "SELECT * FROM users " + (where == null ? "" : where);
        assertEquals(expected, one(sql).accessPath(), sql);
        assertEquals(expected, one("EXPLAIN " + sql).accessPath(), "EXPLAIN " + sql);
    }

    @Test
    void 인덱스를_끄면_항상_FULL_SCAN() {
        seed(10);
        engine.setIndexEnabled(false);
        assertFalse(engine.isIndexEnabled());
        assertEquals(AccessPath.FULL_SCAN, one("SELECT * FROM users WHERE id = 3").accessPath());
        assertEquals(AccessPath.FULL_SCAN, one("SELECT * FROM users WHERE id BETWEEN 1 AND 3").accessPath());
        assertTrue(one("EXPLAIN SELECT * FROM users WHERE id = 3").rows().get(0).get(2).toString().contains("꺼짐"));

        engine.setIndexEnabled(true);
        assertEquals(AccessPath.INDEX_LOOKUP, one("SELECT * FROM users WHERE id = 3").accessPath());
    }

    @Test
    void 인덱스를_끈_동안_INSERT한_행도_다시_켜면_인덱스로_찾는다() {
        engine.setIndexEnabled(false);
        seed(3);
        engine.setIndexEnabled(true);
        assertEquals(1, one("SELECT * FROM users WHERE id = 3").rows().size());
    }

    // ---- EXPLAIN ----

    @Test
    void EXPLAIN은_실행하지_않고_계획만_돌려준다() {
        seed(5);
        QueryResult result = one("EXPLAIN SELECT name FROM users WHERE id BETWEEN 2 AND 4");
        assertEquals(QueryResult.Type.EXPLAIN, result.type());
        assertEquals(List.of("table", "access_path", "detail"), result.columns());
        assertEquals(List.of(List.of("users", "INDEX_RANGE", "id 2 .. 4 (id BETWEEN 2 AND 4)")), result.rows());
        assertEquals(0, result.affectedRows());
    }

    @Test
    void EXPLAIN도_컬럼과_타입을_검증한다() {
        assertThrows(TypeMismatchException.class, () -> engine.execute("EXPLAIN SELECT * FROM users WHERE id = 'x'"));
        assertThrows(TypeMismatchException.class, () -> engine.execute("EXPLAIN SELECT * FROM users WHERE id BETWEEN 1 AND 'x'"));
    }

    @Test
    void 열린_경계는_정수_닫힌_구간으로_바뀐다() {
        assertEquals("id -∞ .. 2 (id < 3)", detail("id < 3"));
        assertEquals("id 4 .. +∞ (id > 3)", detail("id > 3"));
        assertEquals("id = 7 (id = 7)", detail("id = 7"));
        // Long 끝값에서 ±1이 넘치지 않고 빈 범위가 된다.
        assertTrue(detail("id < -9223372036854775808").startsWith("id 범위가 비어 있음"));
        assertTrue(detail("id > 9223372036854775807").startsWith("id 범위가 비어 있음"));
        assertTrue(detail("id BETWEEN 5 AND 1").startsWith("id 범위가 비어 있음"));
    }

    private String detail(String where) {
        return one("EXPLAIN SELECT * FROM users WHERE " + where).rows().get(0).get(2).toString();
    }

    // ---- 인덱스 경로와 FULL_SCAN의 결과가 같은지 ----

    private List<List<Object>> withIndex(boolean enabled, String sql) {
        engine.setIndexEnabled(enabled);
        try {
            return one(sql).rows();
        } finally {
            engine.setIndexEnabled(true);
        }
    }

    @Test
    void 무작위_id_조건에서_인덱스와_FULL_SCAN의_결과가_같다() {
        seed(300);
        Random random = new Random(7);
        String[] ops = {"=", "<", "<=", ">", ">=", "!=", "BETWEEN"};
        for (int i = 0; i < 500; i++) {
            String op = ops[random.nextInt(ops.length)];
            long a = random.nextInt(340) - 20; // 범위 밖(음수, 300 초과)도 포함
            String where = op.equals("BETWEEN")
                    ? "id BETWEEN " + a + " AND " + (a + random.nextInt(60) - 10)
                    : "id " + op + " " + a;
            String sql = "SELECT name, id, age FROM users WHERE " + where;
            assertEquals(withIndex(false, sql), withIndex(true, sql), sql);
        }
    }

    @Test
    void 경계값과_NULL_조건에서도_결과가_같다() {
        seed(50);
        for (String where : List.of("id = 0", "id = 1", "id = 50", "id = 51", "id < 1", "id <= 1", "id > 50", "id >= 50",
                "id BETWEEN 50 AND 50", "id BETWEEN 51 AND 100", "id BETWEEN -5 AND 0",
                "id = NULL", "id < NULL", "id BETWEEN NULL AND 10", "id BETWEEN 1 AND NULL",
                "id < -9223372036854775808", "id <= 9223372036854775807", "id > 9223372036854775807",
                "id >= -9223372036854775808")) {
            String sql = "SELECT * FROM users WHERE " + where;
            assertEquals(withIndex(false, sql), withIndex(true, sql), sql);
        }
    }

    @Test
    void 재시작_후에도_결과가_같다() {
        seed(100);
        engine.close();
        engine = new DatabaseEngine(dataDir);
        for (String where : List.of("id = 42", "id BETWEEN 10 AND 20", "id > 95", "id <= 3")) {
            String sql = "SELECT * FROM users WHERE " + where;
            assertEquals(withIndex(false, sql), withIndex(true, sql), sql);
        }
    }

    @Test
    void 파일_순서와_id_순서가_다르면_순서만_다르고_행_집합은_같다() throws IOException {
        // 손으로 만든 파일: id가 파일 안에서 정렬되어 있지 않다. 인덱스 경로는 id 순, FULL_SCAN은 파일 순이다.
        Files.writeString(dataDir.resolve("users.tbl"), "5|a|1\n2|b|2\n9|c|3\n7|d|4\n");
        String sql = "SELECT * FROM users WHERE id >= 3";
        List<List<Object>> scan = withIndex(false, sql);
        List<List<Object>> index = withIndex(true, sql);

        assertEquals(List.of(row(5L, "a", 1L), row(9L, "c", 3L), row(7L, "d", 4L)), scan);
        assertEquals(List.of(row(5L, "a", 1L), row(7L, "d", 4L), row(9L, "c", 3L)), index);
        assertEquals(sortedById(scan), sortedById(index));
    }

    private static List<Object> row(Object... values) {
        return Arrays.asList(values);
    }

    private static List<List<Object>> sortedById(List<List<Object>> rows) {
        List<List<Object>> copy = new ArrayList<>(rows);
        copy.sort(Comparator.comparingLong(r -> (Long) r.get(0)));
        return copy;
    }
}
