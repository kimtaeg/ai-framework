package com.minidbms.server;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ThreadPoolFactoryTest {
    @Test
    void 설정한_core_max_큐_용량으로_만든다() {
        ThreadPoolExecutor pool = ThreadPoolFactory.create(2, 4, 10);
        try {
            assertEquals(2, pool.getCorePoolSize());
            assertEquals(4, pool.getMaximumPoolSize());
            assertInstanceOf(ArrayBlockingQueue.class, pool.getQueue());
            assertEquals(10, pool.getQueue().remainingCapacity());
            assertInstanceOf(BusyRejectionHandler.class, pool.getRejectedExecutionHandler());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void 스레드_이름은_db_worker_N() throws Exception {
        ThreadPoolExecutor pool = ThreadPoolFactory.create(3, 3, 10);
        try {
            List<String> names = new ArrayList<>();
            CountDownLatch allStarted = new CountDownLatch(3);
            CountDownLatch release = new CountDownLatch(1);
            for (int i = 0; i < 3; i++) {
                pool.execute(() -> {
                    synchronized (names) {
                        names.add(Thread.currentThread().getName());
                    }
                    allStarted.countDown();
                    await(release);
                });
            }
            assertTrue(allStarted.await(5, TimeUnit.SECONDS));
            release.countDown();
            names.sort(String::compareTo);
            assertEquals(List.of("db-worker-1", "db-worker-2", "db-worker-3"), names);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void 워커와_큐가_가득_차면_호출_스레드에서_거절됨_표시를_달고_실행한다() throws Exception {
        ThreadPoolExecutor pool = ThreadPoolFactory.create(1, 1, 1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch running = new CountDownLatch(1);
        try {
            pool.execute(() -> {   // 워커 점유
                running.countDown();
                await(release);
            });
            assertTrue(running.await(5, TimeUnit.SECONDS));
            AtomicBoolean queuedSawRejected = new AtomicBoolean(true);
            pool.execute(() -> queuedSawRejected.set(BusyRejectionHandler.isRejectedRequest())); // 큐에 들어감

            AtomicReference<String> thread = new AtomicReference<>();
            AtomicBoolean rejectedFlag = new AtomicBoolean();
            pool.execute(() -> {   // 거절 → 지금 스레드에서 바로 실행
                thread.set(Thread.currentThread().getName());
                rejectedFlag.set(BusyRejectionHandler.isRejectedRequest());
            });

            assertEquals(Thread.currentThread().getName(), thread.get(), "거절된 작업은 호출한 스레드에서 돈다");
            assertTrue(rejectedFlag.get(), "거절된 작업 안에서는 표시가 보여야 한다");
            assertFalse(BusyRejectionHandler.isRejectedRequest(), "끝나면 표시를 지운다");
            assertEquals(1, ThreadPoolFactory.rejectionHandler(pool).rejectedCount());

            release.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS));
            assertFalse(queuedSawRejected.get(), "정상적으로 큐에서 실행된 작업에는 표시가 없다");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void 잘못된_설정은_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> ThreadPoolFactory.create(0, 1, 1));
        assertThrows(IllegalArgumentException.class, () -> ThreadPoolFactory.create(4, 2, 1));
        assertThrows(IllegalArgumentException.class, () -> ThreadPoolFactory.create(1, 1, 0));
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
