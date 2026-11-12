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
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 협조적 쿼리 타임아웃. 실제 실행 속도에 기대지 않도록 시계를 주입한다:
 * {@link StepClock}은 읽을 때마다 1 ms씩 흐르므로 "몇 번 확인하면 마감을 넘는가"가 환경과 상관없이 정해지고,
 * 시계를 읽은 횟수로 스캔이 끝까지 가지 않고 일찍 멈췄는지도 확인할 수 있다.
 */
class QueryTimeoutTest {
    static final int ROWS = 200_000;
    // 조건에 맞는 행이 없어 끝까지 훑는 쿼리(결과는 0행이라 최대 행 수 제한으로는 멈추지 않는다)
    static final String SLOW = "SELECT * FROM t WHERE v = -1";
    static final long STEP_NANOS = 1_000_000;

    // 20만 행을 테스트마다 만들지 않도록 클래스 전체에서 한 번만 만든다.
    @TempDir
    static Path dataDir;

    DatabaseEngine engine;

    /** 읽을 때마다 1 ms씩 흐르는 시계 */
    static final class StepClock implements LongSupplier {
        final AtomicLong reads = new AtomicLong();

        @Override
        public long getAsLong() {
            return reads.incrementAndGet() * STEP_NANOS;
        }
    }

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
        engine.execute("SELECT * FROM t WHERE id = 1"); // 테이블 로딩(인덱스 재구성)을 미리 끝낸다
    }

    @AfterEach
    void close() {
        engine.close();
    }

    private StepClock stepClock(long timeoutMillis) {
        StepClock clock = new StepClock();
        engine.setClock(clock);
        engine.setQueryTimeoutMillis(timeoutMillis);
        return clock;
    }

    @Test
    void 기본값은_제한_없음() {
        assertEquals(0, engine.queryTimeoutMillis());
        assertEquals(0, engine.execute(SLOW).get(0).rows().size());
    }

    @Test
    @Timeout(30)
    void 전체_스캔이_제한_시간을_넘으면_QueryTimeoutException으로_일찍_멈춘다() {
        StepClock clock = stepClock(10);
        QueryTimeoutException e = assertThrows(QueryTimeoutException.class, () -> engine.execute(SLOW));
        assertTrue(e.getMessage().contains("10 ms"), e.getMessage());
        // 끝까지 훑었다면 1,024행마다 한 번씩 약 200번 시계를 봤을 것이다. 10 ms 마감이면 열몇 번 만에 멈춘다.
        long checksForFullScan = ROWS / Deadline.CHECK_EVERY_ROWS;
        assertTrue(clock.reads.get() < 20, "시계를 " + clock.reads.get() + "번 읽었다 (끝까지 읽으면 약 " + checksForFullScan + "번)");
    }

    @Test
    @Timeout(30)
    void 인덱스_범위_읽기도_멈춘다() {
        StepClock clock = stepClock(10);
        // 20만 행 범위를 최대 행 수 제한 없이 끝까지 읽는 쿼리
        assertThrows(QueryTimeoutException.class, () -> engine.execute("SELECT id FROM t WHERE id >= 1"));
        assertTrue(clock.reads.get() < 20, "범위 읽기가 일찍 멈춰야 한다: " + clock.reads.get());
    }

    @Test
    @Timeout(30)
    void 타임아웃_뒤에도_락이_풀려_바로_쓰고_읽을_수_있다() {
        stepClock(10);
        assertThrows(QueryTimeoutException.class, () -> engine.execute(SLOW));
        engine.setQueryTimeoutMillis(0);
        // 읽기 락이 남아 있으면 INSERT(쓰기 락)가 영원히 기다린다.
        long id = (Long) assertDoesNotThrow(() -> engine.execute("INSERT INTO t VALUES (7, 'after')")).get(0).rows().get(0).get(0);
        assertEquals(List.of(List.of(id, 7L, "after")), engine.execute("SELECT * FROM t WHERE id = " + id).get(0).rows());
    }

    @Test
    void 시간이_흐르지_않으면_빠른_쿼리도_느린_쿼리도_끊기지_않는다() {
        engine.setClock(() -> 0L); // 멈춘 시계: 마감에 닿지 않는다
        engine.setQueryTimeoutMillis(1);
        for (int i = 1; i <= 100; i++) {
            assertEquals(1, engine.execute("SELECT * FROM t WHERE id = " + i).get(0).rows().size());
        }
        assertEquals(0, engine.execute(SLOW).get(0).rows().size());
    }

    @Test
    @Timeout(30)
    void 여러_문장이면_전체에_걸리고_앞_문장의_INSERT는_남는다() {
        stepClock(10);
        assertThrows(QueryTimeoutException.class, () -> engine.execute("INSERT INTO t VALUES (-7, 'before'); " + SLOW));
        engine.setQueryTimeoutMillis(0);
        List<List<Object>> rows = engine.execute("SELECT v, s FROM t WHERE v = -7").get(0).rows();
        assertEquals(List.of(List.of(-7L, "before")), rows, "트랜잭션이 없으므로 앞 문장은 반영된다");
    }

    @Test
    @Timeout(30)
    void 짧은_문장이_많이_이어져도_문장_사이에서_끊는다() {
        StepClock clock = stepClock(10);
        StringBuilder sql = new StringBuilder();
        for (int i = 0; i < 2000; i++) {
            sql.append("SELECT id FROM t WHERE id = ").append(i + 1).append(';');
        }
        assertThrows(QueryTimeoutException.class, () -> engine.execute(sql.toString()));
        assertTrue(clock.reads.get() < 40, "2000문장을 다 돌기 전에 끊겨야 한다: 시계 " + clock.reads.get() + "번");
    }

    @Test
    @Timeout(60)
    void 테이블을_처음_여는_인덱스_재구성_시간은_타임아웃에서_뺀다() {
        engine.close();
        engine = new DatabaseEngine(dataDir); // 아직 테이블을 열지 않은 엔진: 첫 쿼리가 20만 행을 훑어 인덱스를 만든다
        // 실제 시간을 1,000배로 늘린 시계: 실제 1 µs가 1 ms가 된다. 제한 1,000 ms = 실제 1 ms이고,
        // 20만 행 로딩은 실제로 수십 ms 이상(= 수만 ms) 걸리므로 로딩 시간을 빼지 않으면 반드시 실패한다.
        engine.setClock(() -> System.nanoTime() * 1000);
        engine.setQueryTimeoutMillis(1_000);
        assertEquals(1, engine.execute("SELECT * FROM t WHERE id = 3").get(0).rows().size());
    }

    @Test
    void 음수_제한_시간은_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> engine.setQueryTimeoutMillis(-1));
    }

    @Test
    void Deadline_0이면_제한_없음() {
        assertTrue(Deadline.after(0).isUnlimited());
        assertDoesNotThrow(() -> Deadline.NONE.check());
        AtomicLong now = new AtomicLong();
        Deadline deadline = Deadline.after(5, now::get);
        now.set(4 * STEP_NANOS);
        assertDoesNotThrow(deadline::check);
        assertEquals(STEP_NANOS, deadline.remainingNanos());
        now.set(5 * STEP_NANOS);
        assertThrows(QueryTimeoutException.class, deadline::check);
        assertEquals(0, deadline.remainingNanos());
        assertDoesNotThrow(deadline.extendedBy(STEP_NANOS)::check, "미룬 만큼 아직 마감 전");
    }
}
