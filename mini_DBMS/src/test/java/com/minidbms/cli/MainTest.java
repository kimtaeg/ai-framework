package com.minidbms.cli;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MainTest {
    @TempDir
    Path dir;

    Path dataDir;
    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();
    private PrintStream originalOut;

    @BeforeEach
    void setUp() throws IOException {
        dataDir = Files.createDirectory(dir.resolve("data"));
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING,age:INT");
        originalOut = System.out;
        System.setOut(new PrintStream(outBytes, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void restore() {
        System.setOut(originalOut);
    }

    private String out() {
        // 실행 시간은 매번 달라지므로 비교 전에 고정값으로 바꾼다.
        return outBytes.toString(StandardCharsets.UTF_8).replaceAll("\\(\\d+ ms\\)", "(? ms)");
    }

    private Path sqlFile(String sql) throws IOException {
        return Files.writeString(dir.resolve("script.sql"), sql, StandardCharsets.UTF_8);
    }

    private int run(InputStream in, String... args) {
        return Main.run(args, in, System.out, new PrintStream(errBytes, true, StandardCharsets.UTF_8));
    }

    @Test
    void run_모드는_문장을_순서대로_실행하고_결과를_출력한다() throws IOException {
        Path file = sqlFile("""
                INSERT INTO users VALUES ('kim', 30);
                INSERT INTO users (name) VALUES ('이순신');
                SELECT * FROM users;
                SELECT name FROM users WHERE age > 100
                """);

        // System.out을 캡처한 상태로 실제 진입점을 호출한다. 성공하면 System.exit을 부르지 않는다.
        Main.main(new String[]{"run", file.toString(), "--data", dataDir.toString()});

        assertEquals("""
                1 row inserted (id=1)
                1 row inserted (id=2)
                +----+--------+------+
                | id | name   | age  |
                +----+--------+------+
                |  1 | kim    |   30 |
                |  2 | 이순신 | NULL |
                +----+--------+------+
                2 rows (? ms)
                +------+
                | name |
                +------+
                0 rows (? ms)
                """, out());
    }

    @Test
    void 실패한_문장은_ERROR를_출력하고_다음_문장을_계속한다() throws IOException {
        Path file = sqlFile("""
                INSERT INTO users VALUES ('a', 'x');
                SELEC * FROM users;
                SELECT nick FROM users;
                INSERT INTO users VALUES ('b', 2);
                SELECT id FROM users;
                """);

        int code = run(InputStream.nullInputStream(), "run", file.toString(), "--data", dataDir.toString());

        String out = out();
        assertEquals(Main.STATEMENT_ERROR, code);
        assertTrue(out.contains("ERROR: [line 1] 컬럼 'users.age'은(는) INT 타입인데"), out);
        assertTrue(out.contains("ERROR: [line 2] Expected INSERT or SELECT but found 'selec' at 0"), out);
        assertTrue(out.contains("ERROR: [line 3] 테이블 'users'에 컬럼 'nick'이(가) 없습니다"), out);
        // 실패한 INSERT는 id를 쓰지 않았으므로 성공한 첫 INSERT가 id=1을 받는다.
        assertTrue(out.endsWith("""
                1 row inserted (id=1)
                +----+
                | id |
                +----+
                |  1 |
                +----+
                1 row (? ms)
                """), out);
    }

    @Test
    void 종료하면_INSERT가_파일에_남아_다음_실행에서_보인다() throws IOException {
        run(InputStream.nullInputStream(), "run", sqlFile("INSERT INTO users VALUES ('kim', 1)").toString(),
                "--data", dataDir.toString());
        assertEquals("1|kim|1\n", Files.readString(dataDir.resolve("users.tbl")));

        outBytes.reset();
        run(InputStream.nullInputStream(), "run", sqlFile("SELECT name FROM users").toString(),
                "--data", dataDir.toString());
        assertTrue(out().contains("| kim  |"), out());
    }

    @Test
    void repl은_세미콜론까지_여러_줄을_모아_실행하고_exit로_끝난다() {
        String input = """
                INSERT INTO users
                  VALUES ('kim', 30); SELECT name
                FROM users;
                .exit
                SELECT * FROM users;
                """;
        int code = run(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)), "repl", "--data", dataDir.toString());

        assertEquals(Main.OK, code);
        assertEquals(Cli.PROMPT + Cli.CONTINUE_PROMPT
                + "1 row inserted (id=1)\n"
                + Cli.CONTINUE_PROMPT
                + """
                +------+
                | name |
                +------+
                | kim  |
                +------+
                1 row (? ms)
                """
                + Cli.PROMPT + "Bye\n", out());
    }

    @Test
    void repl에서_오류가_나도_계속_입력받는다() {
        String input = "SELECT * FROM ghost;\nINSERT INTO users VALUES ('a', 1);\n";
        run(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)), "repl", "--data", dataDir.toString());

        String out = out();
        assertTrue(out.contains("ERROR: 테이블 'ghost'이(가) 없습니다"), out);
        assertTrue(out.contains("1 row inserted (id=1)"), out);
    }

    @Test
    void 잘못된_사용법은_종료코드_2와_사용법을_출력한다() throws IOException {
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream()));
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream(), "drop"));
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream(), "run"));
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream(), "repl", "--data"));
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream(), "run", "nope.sql", "--data", dataDir.toString()));
        assertEquals(Main.USAGE_ERROR, run(InputStream.nullInputStream(), "run", sqlFile("").toString(),
                "--data", dir.resolve("missing").toString()));
        assertTrue(errBytes.toString(StandardCharsets.UTF_8).contains("사용법:"));
    }
}
