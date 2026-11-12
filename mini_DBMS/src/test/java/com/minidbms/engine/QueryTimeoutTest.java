package com.minidbms.engine;

import com.minidbms.common.QueryTimeoutException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class QueryTimeoutTest {
    static final int ROWS = 200_000;
    // 조건에 맞는 행이 없어 끝까지 훑는 쿼리(결과는 0행이라 최대 행 수 제한으로는 멈추지 않는다)
    static final String SLOW = "SELECT * FROM t WHERE v = -1";

    // 20만 행을 테스트마다 만들지 않도록 클래스 전체에서 한 번만 만든다.
    @TempDir
    static Path dataDir;

    DatabaseEngine engine;

    @BeforeAll
    static void seed() throws IOException {
        Files.writeString(dataDir.resolve("t.schema"), "id:INT,v:INT,s:STRING");
        try (DatabaseEngine seeder = new DatabaseEngine(dataDir)) {
            StringBuilder sql = new StringBuilder();
            for (int i = 0; i < ROWS; i++) {
                sql.append("INSERT INTO t VALUES (").append(i % 100).append(", 'row');");
            }
            seeder.execute(sql.toString());
        }
    }

    @BeforeEach
    void open() {
        engine = new DatabaseEngine(dataDir);
        engine.execute("SELECT * FROM t WHERE id = 1"); // 테이블 로딩(인덱스 재구성)은 타임아웃 대상이 아니므로 미리 끝낸다
    }

    @AfterEach
    void close() {
        engine.close();
    }

    @Test
    void 기본값은_제한_없음() {
        assertEquals(0, engine.queryTimeoutMillis());
        assertEquals(0, engine.execute(SLOW).get(0).rows().size());
    }

    @Test
    @Timeout(30)
    void 전체_스캔이_제한_시간을_넘으면_QueryTimeoutException으로_멈춘다() {
        engine.setQueryTimeoutMillis(5);
        long start = System.nanoTime();
        QueryTimeoutException e = assertThrows(QueryTimeoutException.class, () -> engine.execute(SLOW));
        double ms = (System.nanoTime() - start) / 1e6;

        assertTrue(e.getMessage().contains("5 ms"), e.getMessage());
        // 끝까지 훑었다면 제한 없이 잰 시간만큼 걸렸을 것이다. 그보다 확실히 빨리 멈췄는지 본다.
        engine.setQueryTimeoutMillis(0);
        long full = System.nanoTime();
        engine.execute(SLOW);
        double fullMs = (System.nanoTime() - full) / 1e6;
        assertTrue(ms < fullMs, "타임아웃(" + ms + " ms)이 전체 스캔(" + fullMs + " ms)보다 빨리 끝나야 한다");
    }

    @Test
    @Timeout(30)
    void 인덱스_범위_읽기도_멈춘다() {
        engine.setQueryTimeoutMillis(5);
        // 20만 행 범위를 최대 행 수 제한 없이 끝까지 읽는 쿼리
        QueryResult[] holder = new QueryResult[1];
        assertThrows(QueryTimeoutException.class, () -> holder[0] = engine.execute("SELECT id FROM t WHERE id >= 1").get(0));
        assertEquals(null, holder[0]);
    }

    @Test
    @Timeout(30)
    void 타임아웃_뒤에도_락이_풀려_바로_쓰고_읽을_수_있다() {
        engine.setQueryTimeoutMillis(5);
        assertThrows(QueryTimeoutException.class, () -> engine.execute(SLOW));
        // 읽기 락이 남아 있으면 INSERT(쓰기 락)가 영원히 기다린다.
        assertDoesNotThrow(() -> engine.execute("INSERT INTO t VALUES (7, 'after')"));
        assertEquals(1, engine.execute("SELECT * FROM t WHERE id = " + (ROWS + 1)).get(0).rows().size());
    }

    @Test
    void 빠른_쿼리는_영향이_없다() {
        engine.setQueryTimeoutMillis(1_000);
        for (int i = 1; i <= 1000; i++) {
            assertEquals(1, engine.execute("SELECT * FROM t WHERE id = " + i).get(0).rows().size());
        }
        assertEquals(10, engine.execute("SELECT * FROM t LIMIT 10").get(0).rows().size());
    }

    @Test
    @Timeout(30)
    void 여러_문장이면_전체에_걸리고_앞_문장의_INSERT는_남는다() {
        engine.setQueryTimeoutMillis(5);
        assertThrows(QueryTimeoutException.class, () -> engine.execute("INSERT INTO t VALUES (-7, 'before'); " + SLOW));
        engine.setQueryTimeoutMillis(0);
        assertEquals(1, engine.execute("SELECT * FROM t WHERE v = -7").get(0).rows().size(), "트랜잭션이 없으므로 앞 문장은 반영된다");
    }

    @Test
    @Timeout(30)
    void 짧은_문장이_많이_이어져도_문장_사이에서_끊는다() {
        engine.setQueryTimeoutMillis(5);
        StringBuilder sql = new StringBuilder();
        for (int i = 0; i < 2000; i++) {
            sql.append("SELECT id FROM t WHERE v = 3 LIMIT 500;");
        }
        assertThrows(QueryTimeoutException.class, () -> engine.execute(sql.toString()));
    }

    @Test
    void 음수_제한_시간은_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> engine.setQueryTimeoutMillis(-1));
    }

    @Test
    void Deadline_0이면_제한_없음() {
        assertTrue(Deadline.after(0).isUnlimited());
        assertDoesNotThrow(() -> Deadline.NONE.check());
        Deadline passed = Deadline.after(1);
        long until = System.nanoTime() + 3_000_000;
        while (System.nanoTime() < until) {
            Thread.onSpinWait();
        }
        assertThrows(QueryTimeoutException.class, passed::check);
    }

    @Test
    @Timeout(30)
    void 테이블을_처음_여는_인덱스_재구성_시간은_타임아웃에서_뺀다() {
        engine.close();
        engine = new DatabaseEngine(dataDir); // 아직 테이블을 열지 않은 엔진: 첫 쿼리가 20만 행을 훑어 인덱스를 만든다
        engine.setQueryTimeoutMillis(20);
        long start = System.nanoTime();
        assertEquals(1, engine.execute("SELECT * FROM t WHERE id = 3").get(0).rows().size());
        double ms = (System.nanoTime() - start) / 1e6;
        assertTrue(ms > 20, "로딩이 제한 시간보다 오래 걸려야 이 테스트가 의미 있다: " + ms + " ms");
    }
}
