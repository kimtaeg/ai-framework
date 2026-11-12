package com.minidbms.engine;

import com.minidbms.sql.parser.Parser;
import com.minidbms.sql.parser.ast.Statement;
import com.minidbms.storage.RecordCodec;
import com.minidbms.storage.Table;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * DatabaseEngine을 여러 스레드가 동시에 쓰는 경우.
 * 레코드는 (writer, seq, check)로 만들어서 읽은 행만 보고도 "완전한 레코드"인지 검사할 수 있게 한다.
 */
class ConcurrencyTest {
    @TempDir
    Path dataDir;

    DatabaseEngine engine;
    ExecutorService pool;

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("t.schema"), "id:INT,writer:INT,seq:INT,check:STRING");
        engine = new DatabaseEngine(dataDir);
    }

    @AfterEach
    void tearDown() throws InterruptedException {
        if (pool != null) {
            pool.shutdownNow();
            pool.awaitTermination(10, TimeUnit.SECONDS);
        }
        engine.close();
    }

    private static String check(long writer, long seq) {
        // 구분자·이스케이프 대상 문자를 섞어서, 쪼개진 줄이면 디코딩이나 비교에서 드러나게 한다.
        return "w" + writer + "|s" + seq + "\\끝";
    }

    private static String insertSql(long writer, long seq) {
        return "INSERT INTO t (writer, seq, check) VALUES (" + writer + ", " + seq + ", '" + check(writer, seq) + "')";
    }

    /** 행 하나가 쓰다 만 것이 아닌 완전한 레코드인지 */
    private static void assertComplete(List<Object> row) {
        assertEquals(4, row.size(), row.toString());
        for (Object value : row) {
            if (value == null) {
                fail("NULL 필드가 있는 불완전한 레코드: " + row);
            }
        }
        assertEquals(check((Long) row.get(1), (Long) row.get(2)), row.get(3), "필드가 섞인 레코드: " + row);
    }

    /** 모든 작업을 동시에 출발시키고, 하나라도 예외가 나면 그 예외로 실패한다. */
    private void runConcurrently(List<Callable<Void>> tasks) throws Exception {
        pool = Executors.newFixedThreadPool(tasks.size());
        CountDownLatch startGate = new CountDownLatch(1);
        List<Future<Void>> futures = new ArrayList<>();
        for (Callable<Void> task : tasks) {
            futures.add(pool.submit(() -> {
                startGate.await();
                return task.call();
            }));
        }
        startGate.countDown();
        for (Future<Void> future : futures) {
            future.get(120, TimeUnit.SECONDS); // 작업 안의 예외(AssertionError 포함)가 여기서 다시 던져진다.
        }
    }

    // ---- INSERT만 동시에 ----

    @Test
    @Timeout(180)
    void 스레드_16개가_1만_건씩_INSERT하면_id가_1부터_160000까지_중복_없이_연속이다() throws Exception {
        int threads = 16;
        int perThread = 10_000;
        List<Callable<Void>> tasks = new ArrayList<>();
        for (int w = 0; w < threads; w++) {
            long writer = w;
            tasks.add(() -> {
                long lastId = 0;
                for (long seq = 0; seq < perThread; seq++) {
                    long id = (Long) engine.execute(insertSql(writer, seq)).get(0).rows().get(0).get(0);
                    // 한 스레드 안에서는 나중 INSERT가 항상 더 큰 id를 받는다.
                    assertTrue(id > lastId, "id가 줄었다: " + lastId + " → " + id);
                    lastId = id;
                }
                return null;
            });
        }
        runConcurrently(tasks);

        int total = threads * perThread;
        List<List<Object>> rows = engine.execute("SELECT * FROM t").get(0).rows();
        assertEquals(total, rows.size());
        // 파일 순서 = id 부여 순서여야 한다(id 부여와 append가 같은 쓰기 락 안에 있으므로).
        Map<Long, Long> perWriter = new HashMap<>();
        for (int i = 0; i < total; i++) {
            List<Object> row = rows.get(i);
            assertEquals((long) i + 1, row.get(0), "id가 1부터 연속이 아니다 (행 " + i + ")");
            assertComplete(row);
            perWriter.merge((Long) row.get(1), 1L, Long::sum);
        }
        assertEquals(threads, perWriter.size());
        perWriter.values().forEach(count -> assertEquals(perThread, count));
        assertEquals(List.of(List.of(160_000L)), engine.execute("SELECT id FROM t WHERE id = 160000").get(0).rows());
        assertEquals(List.of(), engine.execute("SELECT id FROM t WHERE id = 160001").get(0).rows());

        // ---- 재시작해서 파일과 인덱스가 일치하는지 ----
        engine.close();
        try (Table table = Table.open(dataDir, "t")) {
            assertEquals(total, table.idIndexStats().keys());
            assertEquals(java.util.OptionalLong.of(total + 1), table.nextId());
            long[] seen = {0};
            table.scan(record -> {
                long id = (Long) record[0];
                Object[] viaIndex = table.findById(id).orElseThrow(() -> new AssertionError("인덱스에 없는 id " + id));
                assertEquals(List.of(record), List.of(viaIndex), "id " + id + ": 인덱스가 가리키는 줄이 다르다");
                seen[0]++;
            });
            assertEquals(total, seen[0]);
        }
        engine = new DatabaseEngine(dataDir);
        assertEquals(total, engine.execute("SELECT id FROM t WHERE id BETWEEN 1 AND 160000").get(0).rows().size());
    }

    // ---- INSERT와 SELECT를 섞어서 ----

    @Test
    @Timeout(180)
    void INSERT와_SELECT를_섞어_동시에_실행해도_예외가_없고_항상_완전한_레코드를_읽는다() throws Exception {
        int writers = 8;
        int perWriter = 3_000;
        int readers = 8;
        AtomicLong committedMaxId = new AtomicLong();   // 어떤 writer가 INSERT를 끝낸 가장 큰 id
        AtomicBoolean writing = new AtomicBoolean(true);
        CountDownLatch writersDone = new CountDownLatch(writers);
        ConcurrentLinkedQueue<String> observations = new ConcurrentLinkedQueue<>();

        List<Callable<Void>> tasks = new ArrayList<>();
        for (int w = 0; w < writers; w++) {
            long writer = w;
            tasks.add(() -> {
                try {
                    for (long seq = 0; seq < perWriter; seq++) {
                        long id = (Long) engine.execute(insertSql(writer, seq)).get(0).rows().get(0).get(0);
                        committedMaxId.accumulateAndGet(id, Math::max);
                    }
                } finally {
                    writersDone.countDown();
                }
                return null;
            });
        }
        for (int r = 0; r < readers; r++) {
            int reader = r;
            tasks.add(() -> {
                ThreadLocalRandom random = ThreadLocalRandom.current();
                long lastScanCount = 0;
                int queries = 0;
                while (writing.get() || queries < 20) {
                    long known = committedMaxId.get();
                    switch ((reader + queries) % 4) {
                        case 0 -> { // 인덱스 단건: 이미 INSERT가 끝난 id는 반드시 보여야 한다.
                            if (known > 0) {
                                long id = 1 + random.nextLong(known);
                                List<List<Object>> rows = engine.execute("SELECT * FROM t WHERE id = " + id).get(0).rows();
                                assertEquals(1, rows.size(), "커밋된 id " + id + "가 안 보인다");
                                assertComplete(rows.get(0));
                            }
                        }
                        case 1 -> { // 인덱스 범위: id 오름차순, 경계 안, 완전한 레코드
                            long from = 1 + random.nextLong(Math.max(1, known));
                            List<List<Object>> rows = engine.execute(
                                    "SELECT * FROM t WHERE id BETWEEN " + from + " AND " + (from + 200)).get(0).rows();
                            long prev = from - 1;
                            for (List<Object> row : rows) {
                                long id = (Long) row.get(0);
                                assertTrue(id > prev && id <= from + 200, "범위 결과 순서/경계 오류: " + id);
                                prev = id;
                                assertComplete(row);
                            }
                        }
                        case 2 -> { // 전체 스캔: 행 수는 줄지 않고, 각 행은 완전하다
                            List<List<Object>> rows = engine.execute("SELECT * FROM t").get(0).rows();
                            assertTrue(rows.size() >= lastScanCount, "스캔 결과가 줄었다");
                            assertTrue(rows.size() >= known, "커밋된 행이 스캔에 빠졌다");
                            lastScanCount = rows.size();
                            rows.forEach(ConcurrencyTest::assertComplete);
                        }
                        default -> { // id가 아닌 컬럼 조건(FULL_SCAN + 필터)
                            long writer = random.nextLong(writers);
                            for (List<Object> row : engine.execute("SELECT * FROM t WHERE writer = " + writer).get(0).rows()) {
                                assertEquals(writer, row.get(1));
                                assertComplete(row);
                            }
                        }
                    }
                    queries++;
                }
                observations.add("reader " + reader + ": " + queries + " queries");
                return null;
            });
        }
        // 모든 writer가 끝나면 reader들에게 마무리하라고 알린다.
        Thread stopper = new Thread(() -> {
            try {
                writersDone.await();
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            writing.set(false);
        });
        stopper.start();
        runConcurrently(tasks);
        stopper.join();

        int total = writers * perWriter;
        assertEquals(readers, observations.size());
        List<List<Object>> rows = engine.execute("SELECT * FROM t").get(0).rows();
        assertEquals(total, rows.size());
        for (int i = 0; i < total; i++) {
            assertEquals((long) i + 1, rows.get(i).get(0));
        }

        // 재시작 후: 인덱스 경로와 FULL_SCAN 경로가 같은 결과
        engine.close();
        engine = new DatabaseEngine(dataDir);
        List<List<Object>> viaIndex = engine.execute("SELECT * FROM t WHERE id >= 1").get(0).rows();
        engine.setIndexEnabled(false);
        List<List<Object>> viaScan = engine.execute("SELECT * FROM t WHERE id >= 1").get(0).rows();
        assertEquals(viaScan, viaIndex);
        assertEquals(total, viaIndex.size());
    }

    // ---- 테이블 캐시 ----

    @Test
    @Timeout(60)
    void 처음_쓰는_테이블을_여러_스레드가_동시에_열어도_한_번만_로딩한다() throws Exception {
        // 기존 데이터가 있는 테이블: 두 번 열리면 각자 nextId=3을 들고 같은 id를 부여하게 된다.
        Files.writeString(dataDir.resolve("t.tbl"), RecordCodec.encode(new Object[]{1L, 0L, 0L, check(0, 0)}) + "\n"
                + RecordCodec.encode(new Object[]{2L, 0L, 1L, check(0, 1)}) + "\n");
        int threads = 16;
        List<Callable<Void>> tasks = new ArrayList<>();
        for (int w = 0; w < threads; w++) {
            long writer = w + 1;
            tasks.add(() -> {
                engine.execute(insertSql(writer, 0));
                return null;
            });
        }
        runConcurrently(tasks);

        List<List<Object>> rows = engine.execute("SELECT * FROM t").get(0).rows();
        assertEquals(threads + 2, rows.size());
        for (int i = 0; i < rows.size(); i++) {
            assertEquals((long) i + 1, rows.get(i).get(0), "id 중복 또는 누락");
            assertComplete(rows.get(i));
        }
    }

    // ---- Lexer / Parser ----

    @Test
    @Timeout(60)
    void Lexer와_Parser는_공유_상태가_없어_동시에_써도_같은_결과를_낸다() throws Exception {
        List<String> sqls = List.of(
                "SELECT a, b FROM t WHERE id BETWEEN 1 AND 9",
                "INSERT INTO t (x, y) VALUES ('it''s', -3)",
                "EXPLAIN SELECT * FROM t WHERE name >= 'kim'",
                "SELECT * FROM t; INSERT INTO t VALUES (NULL, 'a|b')");
        Map<String, List<Statement>> expected = new HashMap<>();
        sqls.forEach(sql -> expected.put(sql, Parser.parseAll(sql)));

        List<Callable<Void>> tasks = new ArrayList<>();
        for (int t = 0; t < 16; t++) {
            tasks.add(() -> {
                for (int i = 0; i < 5_000; i++) {
                    String sql = sqls.get(i % sqls.size());
                    assertEquals(expected.get(sql), Parser.parseAll(sql), sql);
                }
                return null;
            });
        }
        runConcurrently(tasks);
    }

    @Test
    @Timeout(30)
    void 인덱스_스위치는_이미_실행_중인_다른_스레드에_보인다() throws Exception {
        engine.execute(insertSql(0, 0));
        CountDownLatch running = new CountDownLatch(1);
        pool = Executors.newSingleThreadExecutor();
        // 작업을 먼저 시작해 두고, 그 뒤에 스위치를 바꾼다. 작업 쪽에는 바뀐 뒤 아무 동기화 신호도 보내지 않으므로
        // 작업이 변경을 보는 것은 indexEnabled의 volatile 덕분이다.
        Future<Integer> observer = pool.submit(() -> {
            running.countDown();
            int loops = 0;
            while (engine.execute("EXPLAIN SELECT * FROM t WHERE id = 1").get(0).accessPath() != AccessPath.FULL_SCAN) {
                loops++;
            }
            return loops;
        });
        assertTrue(running.await(5, TimeUnit.SECONDS));
        Thread.sleep(50); // 작업이 INDEX_LOOKUP을 몇 번 보게 한다
        engine.setIndexEnabled(false);
        assertTrue(observer.get(20, TimeUnit.SECONDS) > 0, "스위치를 바꾸기 전에는 INDEX_LOOKUP을 봤어야 한다");
        assertEquals(Optional.of(false), Optional.of(engine.isIndexEnabled()));
    }
}
