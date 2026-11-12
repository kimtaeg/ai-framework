package com.minidbms.engine;

import com.minidbms.common.ColumnNotFoundException;
import com.minidbms.common.ConstraintViolationException;
import com.minidbms.common.DbException;
import com.minidbms.common.ParseException;
import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;
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
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DatabaseEngineTest {
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
        List<QueryResult> results = engine.execute(sql);
        assertEquals(1, results.size());
        return results.get(0);
    }

    private static List<Object> row(Object... values) {
        return Arrays.asList(values);
    }

    private void seed() {
        engine.execute("""
                INSERT INTO users VALUES ('kim', 30);
                INSERT INTO users VALUES ('lee', 20);
                INSERT INTO users VALUES ('park', NULL);
                INSERT INTO users VALUES ('choi', 40);
                """);
    }

    // ---- INSERT + SELECT ----

    @Test
    void INSERT_후_SELECT하면_id가_1부터_부여된다() {
        QueryResult insert = one("INSERT INTO users VALUES ('kim', 30)");
        assertEquals(QueryResult.Type.INSERT, insert.type());
        assertEquals(1, insert.affectedRows());
        assertEquals(List.of("id"), insert.columns());
        assertEquals(List.of(row(1L)), insert.rows());

        one("INSERT INTO users VALUES ('lee', 20)");
        QueryResult select = one("SELECT * FROM users");

        assertEquals(QueryResult.Type.SELECT, select.type());
        assertEquals(List.of("id", "name", "age"), select.columns());
        assertEquals(List.of(row(1L, "kim", 30L), row(2L, "lee", 20L)), select.rows());
        assertEquals(2, select.affectedRows());
    }

    @Test
    void 컬럼_순서를_바꾼_INSERT() {
        one("INSERT INTO users (age, name) VALUES (25, 'han')");
        assertEquals(List.of(row(1L, "han", 25L)), one("SELECT * FROM users").rows());
    }

    @Test
    void 지정하지_않은_컬럼은_NULL() {
        one("INSERT INTO users (name) VALUES ('solo')");
        assertEquals(List.of(row(1L, "solo", null)), one("SELECT * FROM users").rows());
    }

    @Test
    void 컬럼_투영은_요청한_순서와_스키마_표기를_따른다() {
        seed();
        QueryResult result = one("SELECT AGE, name FROM users WHERE id <= 2");
        assertEquals(List.of("age", "name"), result.columns());
        assertEquals(List.of(row(30L, "kim"), row(20L, "lee")), result.rows());
    }

    @Test
    void 여러_문장의_결과를_순서대로_돌려준다() {
        List<QueryResult> results = engine.execute("INSERT INTO users VALUES ('a', 1); SELECT name FROM users;");
        assertEquals(List.of(QueryResult.Type.INSERT, QueryResult.Type.SELECT),
                results.stream().map(QueryResult::type).toList());
        assertEquals(List.of(row("a")), results.get(1).rows());
    }

    @Test
    void 엔진을_다시_열면_기존_최대_id_다음부터_부여한다() {
        seed();
        engine.close();

        engine = new DatabaseEngine(dataDir);
        one("INSERT INTO users VALUES ('new', 1)");
        assertEquals(List.of(row(5L, "new")), one("SELECT id, name FROM users WHERE name = 'new'").rows());
    }

    @Test
    void 특수문자와_한글_값이_그대로_조회된다() {
        one("INSERT INTO users VALUES ('김|정\\글 ''따옴표''', 1)");
        assertEquals(List.of(row("김|정\\글 '따옴표'")),
                one("SELECT name FROM users").rows());
    }

    // ---- WHERE ----

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "age = 30   | kim",
            "age != 30  | lee,choi",
            "age <> 30  | lee,choi",
            "age < 30   | lee",
            "age <= 30  | kim,lee",
            "age > 30   | choi",
            "age >= 30  | kim,choi",
            "name = 'park' | park",
            "name < 'kim'  | choi",
            "name >= 'lee' | lee,park",
            "id > 2     | park,choi",
    })
    void WHERE_연산자(String where, String expectedNames) {
        seed();
        List<Object> names = one("SELECT name FROM users WHERE " + where).rows().stream().map(r -> r.get(0)).toList();
        assertEquals(List.of((Object[]) expectedNames.split(",")), names);
    }

    @Test
    void NULL은_어떤_비교에서도_false() {
        seed();
        // park의 age는 NULL이라 = 와 != 어느 쪽에도 걸리지 않는다.
        assertEquals(1, one("SELECT * FROM users WHERE age = 30").rows().size());
        assertEquals(2, one("SELECT * FROM users WHERE age != 30").rows().size());
        assertEquals(0, one("SELECT * FROM users WHERE age = NULL").rows().size());
        assertEquals(0, one("SELECT * FROM users WHERE age != NULL").rows().size());
    }

    @Test
    void 조건에_맞는_행이_없으면_빈_결과() {
        seed();
        QueryResult result = one("SELECT * FROM users WHERE age > 100");
        assertEquals(List.of(), result.rows());
        assertEquals(0, result.affectedRows());
    }

    // ---- 에러 ----

    @Test
    void 없는_테이블() {
        assertThrows(TableNotFoundException.class, () -> engine.execute("SELECT * FROM ghost"));
        assertThrows(TableNotFoundException.class, () -> engine.execute("INSERT INTO ghost VALUES (1)"));
    }

    @Test
    void 없는_컬럼() {
        assertThrows(ColumnNotFoundException.class, () -> engine.execute("INSERT INTO users (nick) VALUES ('x')"));
        assertThrows(ColumnNotFoundException.class, () -> engine.execute("SELECT nick FROM users"));
        assertThrows(ColumnNotFoundException.class, () -> engine.execute("SELECT * FROM users WHERE nick = 'x'"));
    }

    @Test
    void 컬럼_생략_INSERT의_값_개수_불일치() {
        DbException e = assertThrows(ParseException.class, () -> engine.execute("INSERT INTO users VALUES ('kim')"));
        assertTrue(e.getMessage().contains("name, age"), e.getMessage());
        assertThrows(ParseException.class, () -> engine.execute("INSERT INTO users VALUES ('kim', 1, 2)"));
    }

    @Test
    void 타입_불일치() {
        assertThrows(TypeMismatchException.class, () -> engine.execute("INSERT INTO users VALUES ('kim', 'thirty')"));
        assertThrows(TypeMismatchException.class, () -> engine.execute("INSERT INTO users VALUES (1, 30)"));
        assertThrows(TypeMismatchException.class, () -> engine.execute("SELECT * FROM users WHERE age = '30'"));
    }

    @Test
    void id를_직접_넣으면_오류() {
        assertThrows(ConstraintViolationException.class,
                () -> engine.execute("INSERT INTO users (id, name) VALUES (7, 'x')"));
    }

    @Test
    void 같은_컬럼을_두_번_지정하면_오류() {
        assertThrows(ParseException.class, () -> engine.execute("INSERT INTO users (name, NAME) VALUES ('a', 'b')"));
    }

    @Test
    void 실패한_INSERT는_기록되지_않고_id도_소모하지_않는다() {
        assertThrows(TypeMismatchException.class, () -> engine.execute("INSERT INTO users VALUES ('kim', 'x')"));
        one("INSERT INTO users VALUES ('lee', 1)");
        assertEquals(List.of(row(1L, "lee", 1L)), one("SELECT * FROM users").rows());
    }

    @Test
    void 문법_오류가_있으면_앞_문장도_실행하지_않는다() {
        assertThrows(ParseException.class, () -> engine.execute("INSERT INTO users VALUES ('a', 1); SELEC * FROM users"));
        assertEquals(0, one("SELECT * FROM users").rows().size());
    }

    @Test
    void 실행_오류는_앞_문장의_결과를_남긴다() {
        assertThrows(ColumnNotFoundException.class,
                () -> engine.execute("INSERT INTO users VALUES ('a', 1); SELECT nick FROM users"));
        assertEquals(1, one("SELECT * FROM users").rows().size());
    }

    @Test
    void id_INT_컬럼이_없는_스키마는_거부한다() throws IOException {
        Files.writeString(dataDir.resolve("noid.schema"), "name:STRING");
        Files.writeString(dataDir.resolve("strid.schema"), "id:STRING");
        assertThrows(StorageException.class, () -> engine.execute("SELECT * FROM noid"));
        assertThrows(StorageException.class, () -> engine.execute("SELECT * FROM strid"));
    }

    @Test
    void 결과_행은_수정할_수_없다() {
        seed();
        QueryResult result = one("SELECT * FROM users");
        assertThrows(UnsupportedOperationException.class, () -> result.rows().clear());
        assertThrows(UnsupportedOperationException.class, () -> result.rows().get(0).set(0, 99L));
    }
}
