package com.minidbms.bench;

import com.minidbms.engine.DatabaseEngine;
import com.minidbms.engine.QueryResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DataGeneratorTest {
    @TempDir
    Path dir;

    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();

    private int generate(String... args) {
        return DataGenerator.run(args, new PrintStream(outBytes, true, StandardCharsets.UTF_8),
                new PrintStream(errBytes, true, StandardCharsets.UTF_8));
    }

    private String out() {
        return outBytes.toString(StandardCharsets.UTF_8);
    }

    private String err() {
        return errBytes.toString(StandardCharsets.UTF_8);
    }

    private List<List<Object>> select(Path dataDir, String sql) {
        try (DatabaseEngine engine = new DatabaseEngine(dataDir)) {
            return engine.execute(sql).get(0).rows();
        }
    }

    @Test
    void 지정한_수만큼_엔진을_거쳐_생성하고_데이터_규칙을_지킨다() {
        Path data = dir.resolve("data");
        assertEquals(0, generate("--table", "users", "--count", "2500", "--data", data.toString(), "--batch", "300"));

        // 스키마가 없으면 기본 스키마로 만든다.
        assertTrue(Files.exists(data.resolve("users.schema")));
        List<List<Object>> rows = select(data, "SELECT id, name, age, email FROM users");
        assertEquals(2500, rows.size());

        Set<Object> emails = new HashSet<>();
        for (List<Object> row : rows) {
            long id = (Long) row.get(0);
            String name = (String) row.get(1);
            long age = (Long) row.get(2);
            assertTrue(name.matches("[a-z]{5,10}"), name);
            assertTrue(age >= 1 && age <= 100, "age=" + age);
            assertEquals("user" + id + "@test.com", row.get(3));
            emails.add(row.get(3));
        }
        assertEquals(2500, emails.size(), "email은 고유해야 한다");
        assertTrue(out().contains("완료: 2,500 rows"), out());
    }

    @Test
    void 같은_seed면_같은_데이터_다른_seed면_다른_데이터() {
        Path a = dir.resolve("a"), b = dir.resolve("b"), c = dir.resolve("c");
        generate("--table", "users", "--count", "200", "--seed", "7", "--data", a.toString());
        generate("--table", "users", "--count", "200", "--seed", "7", "--data", b.toString(), "--batch", "1");
        generate("--table", "users", "--count", "200", "--seed", "8", "--data", c.toString());

        String sql = "SELECT * FROM users";
        assertEquals(select(a, sql), select(b, sql), "배치 크기와 상관없이 seed가 같으면 같다");
        assertTrue(!select(a, sql).equals(select(c, sql)));
    }

    @Test
    void 진행률을_10만_건마다_출력한다() {
        generate("--table", "users", "--count", "250000", "--data", dir.resolve("d").toString(), "--batch", "7000");
        List<String> progress = out().lines().filter(l -> l.contains(" / 250,000")).toList();
        // 배치 크기가 10만의 약수가 아니어도 경계를 넘은 직후에 한 번씩 찍힌다.
        assertEquals(2, progress.size(), out());
        assertTrue(progress.get(0).startsWith("  105,000 / 250,000"), progress.get(0));
        assertTrue(progress.get(1).startsWith("  203,000 / 250,000"), progress.get(1));
        assertTrue(out().contains("rows/s"), out());
    }

    @Test
    void 데이터가_이미_있으면_reset_없이는_거부한다() {
        Path data = dir.resolve("data");
        generate("--table", "users", "--count", "10", "--data", data.toString());
        assertEquals(1, generate("--table", "users", "--count", "10", "--data", data.toString()));
        assertTrue(err().contains("--reset"), err());

        assertEquals(0, generate("--table", "users", "--count", "5", "--data", data.toString(), "--reset"));
        assertEquals(5, select(data, "SELECT * FROM users").size());
    }

    @Test
    void 필요한_컬럼이_없는_스키마는_거부한다() throws IOException {
        Path data = Files.createDirectories(dir.resolve("data"));
        Files.writeString(data.resolve("users.schema"), "id:INT,name:STRING");
        assertEquals(1, generate("--table", "users", "--count", "10", "--data", data.toString()));
        assertTrue(err().contains("'age'"), err());
    }

    @Test
    void out을_주면_실행하지_않고_run_모드로_실행할_수_있는_SQL을_쓴다() throws IOException {
        Path data = dir.resolve("data");
        Path sqlFile = dir.resolve("users.sql");
        assertEquals(0, generate("--table", "users", "--count", "300", "--data", data.toString(), "--out", sqlFile.toString()));
        assertTrue(!Files.exists(data.resolve("users.tbl")), "export만 하고 실행은 하지 않는다");

        List<String> lines = Files.readAllLines(sqlFile);
        assertEquals(301, lines.size(), "주석 한 줄 + 문장 300줄");
        assertTrue(lines.get(1).matches("INSERT INTO users \\(name, age, email\\) VALUES \\('[a-z]{5,10}', \\d+, 'user1@test.com'\\);"),
                lines.get(1));

        // 같은 seed로 엔진에 직접 넣은 데이터와 SQL 파일을 실행한 결과가 같다.
        Path direct = dir.resolve("direct");
        generate("--table", "users", "--count", "300", "--data", direct.toString());
        assertTrue(Files.exists(data.resolve("users.schema")), "run 모드가 바로 돌도록 스키마는 만들어 둔다");
        try (DatabaseEngine engine = new DatabaseEngine(data)) {
            List<QueryResult> results = engine.execute(Files.readString(sqlFile));
            assertEquals(300, results.size());
        }
        assertEquals(select(direct, "SELECT * FROM users"), select(data, "SELECT * FROM users"));
    }

    @Test
    void 잘못된_인자는_종료코드_2() {
        assertEquals(2, generate("--count", "10"));
        assertEquals(2, generate("--table", "users"));
        assertEquals(2, generate("--table", "users", "--count", "0"));
        assertEquals(2, generate("--table", "users", "--count", "abc"));
        assertEquals(2, generate("--table", "users", "--count", "10", "--bogus"));
        assertTrue(err().contains("사용법"), err());
    }

    @Test
    void 기존_데이터가_있는_테이블로는_SQL을_내보내지_않는다() {
        Path data = dir.resolve("data");
        generate("--table", "users", "--count", "10", "--data", data.toString());
        assertEquals(1, generate("--table", "users", "--count", "10", "--data", data.toString(), "--out", dir.resolve("x.sql").toString()));
        assertTrue(err().contains("email이 겹칩니다"), err());
        assertTrue(!Files.exists(dir.resolve("x.sql")));
    }

    @Test
    void 컬럼_타입이_맞지_않으면_reset_전에_거부해서_데이터를_지우지_않는다() throws IOException {
        Path data = Files.createDirectories(dir.resolve("data"));
        Files.writeString(data.resolve("users.schema"), "id:INT,name:STRING,age:STRING,email:STRING");
        Files.writeString(data.resolve("users.tbl"), "1|keep|30|k@x\n");
        assertEquals(1, generate("--table", "users", "--count", "10", "--data", data.toString(), "--reset"));
        assertTrue(err().contains("'age' 컬럼은 STRING"), err());
        assertEquals("1|keep|30|k@x\n", Files.readString(data.resolve("users.tbl")), "데이터가 그대로 남아야 한다");
    }
}
