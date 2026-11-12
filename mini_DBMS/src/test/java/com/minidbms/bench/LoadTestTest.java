package com.minidbms.bench;

import com.minidbms.server.ApiServer;
import com.minidbms.server.ServerConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LoadTestTest {
    @TempDir
    Path dir;

    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();

    private int loadtest(String... args) {
        return LoadTest.run(args, new PrintStream(outBytes, true, StandardCharsets.UTF_8),
                new PrintStream(errBytes, true, StandardCharsets.UTF_8));
    }

    private Path generated(int rows) {
        Path data = dir.resolve("data");
        PrintStream quiet = new PrintStream(OutputStream.nullOutputStream());
        assertEquals(0, DataGenerator.run(new String[]{"--table", "users", "--count", Integer.toString(rows), "--data", data.toString()}, quiet, quiet));
        return data;
    }

    @Test
    @Timeout(60)
    void 클라이언트_수별_TPS와_지연_표를_출력하고_저장한다() throws IOException {
        Path data = generated(500);
        Path report = dir.resolve("load.md");
        assertEquals(0, loadtest("--data", data.toString(), "--clients", "1,3", "--duration", "1", "--warmup", "0",
                "--out", report.toString()), errBytes.toString(StandardCharsets.UTF_8));

        String md = Files.readString(report);
        assertTrue(md.contains("(id 1..500)"), md);
        assertTrue(md.contains("| 클라이언트 | 요청 수 | TPS | 평균 (ms) | p50 (ms) | p99 (ms) |"), md);
        List<String> rows = md.lines().filter(l -> l.matches("\\| [13] \\| .*")).toList();
        assertEquals(2, rows.size(), md);
        for (String row : rows) {
            assertTrue(row.endsWith("| 0 | 0 |"), "503·오류가 없어야 한다: " + row);
        }
    }

    @Test
    @Timeout(60)
    void insert_부하는_빈_테이블에서도_돈다() throws IOException {
        Path data = Files.createDirectories(dir.resolve("empty"));
        Files.writeString(data.resolve("users.schema"), DataGenerator.DEFAULT_SCHEMA);
        assertEquals(0, loadtest("--data", data.toString(), "--workload", "insert", "--clients", "2", "--duration", "1", "--warmup", "0"),
                errBytes.toString(StandardCharsets.UTF_8));
        assertTrue(Files.readAllLines(data.resolve("users.tbl")).size() > 0);
    }

    @Test
    void lookup은_빈_테이블이면_안내하고_실패한다() throws IOException {
        Path data = Files.createDirectories(dir.resolve("empty"));
        Files.writeString(data.resolve("users.schema"), DataGenerator.DEFAULT_SCHEMA);
        assertEquals(1, loadtest("--data", data.toString(), "--duration", "1"));
        assertTrue(errBytes.toString(StandardCharsets.UTF_8).contains("--workload insert"));
    }

    @Test
    @Timeout(60)
    void 최대_id를_로그_횟수로_찾는다() throws Exception {
        Path data = generated(1234);
        try (ApiServer server = new ApiServer(new ServerConfig(0, 2, 2, 100, data), new PrintStream(OutputStream.nullOutputStream()))) {
            server.start();
            LoadTest.Runner runner = new LoadTest.Runner("http://localhost:" + server.port(),
                    LoadTest.Options.parse(new String[]{"--url", "http://x"}));
            assertEquals(1234, runner.findMaxId());
        }
    }

    @Test
    void 잘못된_인자는_종료코드_2() {
        assertEquals(2, loadtest("--clients", "0,4"));
        assertEquals(2, loadtest("--clients", "a"));
        assertEquals(2, loadtest("--workload", "delete"));
        assertEquals(2, loadtest("--duration", "0"));
        assertEquals(2, loadtest("--duration"));
        assertEquals(2, loadtest("--nope", "1"));
        assertEquals(2, loadtest("--data", dir.resolve("missing").toString()));
    }
}
