package com.minidbms.bench;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BenchmarkTest {
    @TempDir
    Path dir;

    Path data;
    private final ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
    private final ByteArrayOutputStream errBytes = new ByteArrayOutputStream();

    @BeforeEach
    void setUp() {
        data = dir.resolve("data");
        PrintStream quiet = new PrintStream(OutputStream.nullOutputStream());
        assertEquals(0, DataGenerator.run(new String[]{"--table", "users", "--count", "3000", "--data", data.toString()}, quiet, quiet));
    }

    private int bench(String... args) {
        return Benchmark.run(args, new PrintStream(outBytes, true, StandardCharsets.UTF_8),
                new PrintStream(errBytes, true, StandardCharsets.UTF_8));
    }

    private String err() {
        return errBytes.toString(StandardCharsets.UTF_8);
    }

    @Test
    void 세_항목을_세_위치에서_재고_결과를_마크다운으로_저장한다() throws IOException {
        Path report = dir.resolve("bench-result.md");
        assertEquals(0, bench("--table", "users", "--data", data.toString(), "--out", report.toString(),
                "--queries", "30", "--scan-queries", "2", "--warmup", "5"), err());

        String md = Files.readString(report);
        assertTrue(md.contains("| 키 수 | 3,000 |"), md);
        assertTrue(md.contains("| 트리 높이 | 2 |"), md);
        assertTrue(md.contains("| 노드 수 |"), md);
        assertTrue(md.contains("재구성 시간"), md);
        for (String item : new String[]{"A. id = ? (인덱스)", "B. id = ? (인덱스 OFF)", "C. email = ? (선형 탐색)"}) {
            for (String position : new String[]{"앞", "중간", "끝"}) {
                assertTrue(md.contains("| " + item + " | " + position + " | "), item + " " + position + "\n" + md);
            }
        }
        assertTrue(md.contains("| A. id = ? (인덱스) | 앞 | 30 |"), "인덱스 항목은 --queries 횟수");
        assertTrue(md.contains("| C. email = ? (선형 탐색) | 끝 | 2 |"), "스캔 항목은 --scan-queries 횟수");
        assertTrue(md.contains("## 해석") && md.contains("O(log n)") && md.contains("O(n)"), md);
        // 표준 출력에도 같은 보고서가 나온다.
        assertTrue(outBytes.toString(StandardCharsets.UTF_8).contains("## 조회 시간"));
    }

    @Test
    void 빈_테이블이나_email이_없는_테이블은_거부한다() throws IOException {
        Path empty = Files.createDirectories(dir.resolve("empty"));
        Files.writeString(empty.resolve("users.schema"), DataGenerator.DEFAULT_SCHEMA);
        assertEquals(1, bench("--table", "users", "--data", empty.toString(), "--out", dir.resolve("x.md").toString()));
        assertTrue(err().contains("비어 있습니다"), err());

        Path noEmail = Files.createDirectories(dir.resolve("noemail"));
        Files.writeString(noEmail.resolve("t.schema"), "id:INT,name:STRING");
        Files.writeString(noEmail.resolve("t.tbl"), "1|a\n");
        assertEquals(1, bench("--table", "t", "--data", noEmail.toString(), "--out", dir.resolve("y.md").toString()));
        assertTrue(err().contains("email"), err());
    }

    @Test
    void 잘못된_인자는_종료코드_2() {
        assertEquals(2, bench("--queries", "10"));
        assertEquals(2, bench("--table", "users", "--queries", "0"));
        assertEquals(2, bench("--table", "users", "--warmup", "-1"));
        assertEquals(2, bench("--table", "users", "--nope"));
        assertTrue(err().contains("사용법"), err());
    }

    @Test
    void 백분위는_nearest_rank() {
        long[] nanos = new long[100];
        for (int i = 0; i < 100; i++) {
            nanos[i] = (100 - i) * 1_000_000L; // 100ms..1ms, 섞인 순서
        }
        Benchmark.Summary s = Benchmark.Summary.of(nanos);
        assertEquals(100, s.count());
        assertEquals(50.5, s.mean(), 1e-9);
        assertEquals(50.0, s.p50(), 1e-9);
        assertEquals(99.0, s.p99(), 1e-9);
        assertEquals(1.0, s.min(), 1e-9);
        assertEquals(100.0, s.max(), 1e-9);

        Benchmark.Summary one = Benchmark.Summary.of(new long[]{3_000_000});
        assertEquals(3.0, one.p50(), 1e-9);
        assertEquals(3.0, one.p99(), 1e-9);
    }
}
