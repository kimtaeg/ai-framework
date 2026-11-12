package com.minidbms.engine;

import com.minidbms.common.StorageException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** Phase 1 점검 체크리스트 중 엔진 레벨 엣지 케이스 */
class Phase1EdgeCaseTest {
    @TempDir
    Path dataDir;

    DatabaseEngine engine;

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,Name:STRING,age:INT");
        engine = new DatabaseEngine(dataDir);
    }

    @AfterEach
    void tearDown() {
        engine.close();
    }

    private List<List<Object>> rows(String sql) {
        return engine.execute(sql).get(0).rows();
    }

    private static List<Object> row(Object... values) {
        return Arrays.asList(values);
    }

    private void reopen() {
        engine.close();
        engine = new DatabaseEngine(dataDir);
    }

    // ---- 값 경계 ----

    @Test
    void Long_최대값과_최소값을_저장하고_비교한다() {
        engine.execute("INSERT INTO users VALUES ('max', 9223372036854775807);"
                + "INSERT INTO users VALUES ('min', -9223372036854775808)");
        assertEquals(List.of(row("max", Long.MAX_VALUE), row("min", Long.MIN_VALUE)), rows("SELECT name, age FROM users"));
        assertEquals(List.of(row("min")), rows("SELECT name FROM users WHERE age < 0"));
        assertEquals(List.of(row("max")), rows("SELECT name FROM users WHERE age = 9223372036854775807"));
    }

    @Test
    void 빈_문자열과_NULL은_구별된다() {
        engine.execute("INSERT INTO users VALUES ('', 1); INSERT INTO users VALUES (NULL, 2)");
        reopen(); // 파일을 거친 뒤에도 구별되는지
        assertEquals(List.of(row(1L)), rows("SELECT id FROM users WHERE name = ''"));
        assertEquals(List.of(row(1L, ""), row(2L, null)), rows("SELECT id, name FROM users"));
    }

    @Test
    void 아주_긴_문자열도_왕복된다() {
        // 쓰기 버퍼(64KB)보다 큰 값
        String longValue = "가|\\".repeat(40_000);
        engine.execute("INSERT INTO users VALUES ('" + longValue + "', 1)");
        reopen();
        assertEquals(List.of(row(longValue)), rows("SELECT name FROM users"));
    }

    // ---- 저장 파일 상태 ----

    @Test
    void 스키마만_있고_tbl이_없으면_빈_테이블이다() {
        assertEquals(List.of(), rows("SELECT * FROM users"));
        assertEquals(List.of(row(1L)), engine.execute("INSERT INTO users VALUES ('a', 1)").get(0).rows());
    }

    @Test
    void 깨진_tbl_줄은_StorageException() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "1|kim|30\nnot-a-record\n");
        assertThrows(StorageException.class, () -> engine.execute("SELECT * FROM users"));
    }

    @Test
    void 마지막_줄에_줄바꿈이_없는_tbl은_이번_로딩에서_그_줄을_무시하고_재시작하면_읽는다() throws IOException {
        // 손으로 편집했거나 쓰다가 중단되어 '\n' 없이 끝난 파일
        Files.writeString(dataDir.resolve("users.tbl"), "1|kim|30");
        engine.execute("INSERT INTO users VALUES ('lee', 20)");
        // 무시한 줄의 id(1)는 피해서 2를 받는다. 새 레코드가 그 줄 뒤에 붙지도 않는다.
        assertEquals(List.of(row(2L, "lee", 20L)), rows("SELECT * FROM users"));

        reopen();
        assertEquals(List.of(row(1L, "kim", 30L), row(2L, "lee", 20L)), rows("SELECT * FROM users"));
    }

    // ---- 재시작·이름 ----

    @Test
    void 재시작_후에도_id가_이어지고_중간에_빈_번호가_있어도_최대값_기준이다() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "1|a|1\n7|b|2\n3|c|3\n");
        engine.execute("INSERT INTO users VALUES ('d', 4)");
        reopen();
        engine.execute("INSERT INTO users VALUES ('e', 5)");
        assertEquals(List.of(row(8L), row(9L)), rows("SELECT id FROM users WHERE id > 7"));
    }

    @Test
    void 테이블과_컬럼_이름은_대소문자를_섞어도_된다() {
        engine.execute("INSERT INTO USERS (NAME, Age) VALUES ('kim', 1)");
        var result = engine.execute("SELECT nAmE, AGE FROM Users WHERE NAME = 'kim'").get(0);
        // 결과 컬럼 이름은 스키마 표기를 따른다.
        assertEquals(List.of("Name", "age"), result.columns());
        assertEquals(List.of(row("kim", 1L)), result.rows());
    }

    // ---- SELECT 세부 ----

    @Test
    void 같은_컬럼을_두_번_투영할_수_있다() {
        engine.execute("INSERT INTO users VALUES ('kim', 1)");
        var result = engine.execute("SELECT name, id, name FROM users").get(0);
        assertEquals(List.of("Name", "id", "Name"), result.columns());
        assertEquals(List.of(row("kim", 1L, "kim")), result.rows());
    }

    @Test
    void WHERE에서_음수와_비교한다() {
        engine.execute("INSERT INTO users VALUES ('a', -10); INSERT INTO users VALUES ('b', -1); INSERT INTO users VALUES ('c', 0)");
        assertEquals(List.of(row("a")), rows("SELECT name FROM users WHERE age<-5"));
        assertEquals(List.of(row("b"), row("c")), rows("SELECT name FROM users WHERE age >= -1"));
        assertEquals(List.of(row("b")), rows("SELECT name FROM users WHERE age=-1"));
    }

    @Test
    void 문자열은_코드_포인트_순으로_비교한다_대문자가_소문자보다_앞이다() {
        engine.execute("INSERT INTO users VALUES ('apple', 1); INSERT INTO users VALUES ('Banana', 2);"
                + "INSERT INTO users VALUES ('가나', 3); INSERT INTO users VALUES ('', 4)");
        // 'B'(0x42) < 'a'(0x61) < '가'(0xAC00). 빈 문자열이 가장 작다.
        assertEquals(List.of(row("Banana"), row("")), rows("SELECT name FROM users WHERE name < 'a'"));
        assertEquals(List.of(row("가나")), rows("SELECT name FROM users WHERE name > 'z'"));
    }
}
