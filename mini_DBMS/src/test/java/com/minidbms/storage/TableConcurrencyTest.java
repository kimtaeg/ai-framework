package com.minidbms.storage;

import com.minidbms.common.QueryTimeoutException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BrokenBarrierException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Table 수준의 읽기 락: 읽기끼리 동시에 돌아도 상태를 바꾸지 않는지 */
class TableConcurrencyTest {
    @TempDir
    Path dataDir;

    @Test
    @Timeout(60)
    void flush_전_버퍼가_남아_있어도_동시_스캔은_파일을_바꾸지_않는다() throws Exception {
        Files.writeString(dataDir.resolve("t.schema"), "id:INT,v:STRING");
        int rows = 2_000;
        int threads = 16;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try (Table table = Table.open(dataDir, "t")) {
            // flush하지 않아서 대부분의 레코드가 메모리 버퍼에만 있다.
            for (int i = 0; i < rows; i++) {
                table.insert(new Object[]{null, "v" + i});
            }
            long sizeBefore = Files.size(dataDir.resolve("t.tbl"));

            for (int round = 0; round < 20; round++) {
                CountDownLatch gate = new CountDownLatch(1);
                // 모든 스캔이 첫 행을 받은 상태(= 모두 읽기 락 안)에서 만나야 넘어간다. 스캔이 직렬화되면
                // 첫 스캔이 여기서 다른 스캔을 영원히 기다리므로 시간 초과로 실패한다. 즉 실제로 동시에 읽는지 확인한다.
                CyclicBarrier allInside = new CyclicBarrier(threads);
                List<Future<Integer>> futures = new ArrayList<>();
                for (int t = 0; t < threads; t++) {
                    futures.add(pool.submit(() -> {
                        gate.await();
                        int[] count = {0};
                        table.scan(record -> {
                            if (count[0]++ == 0) {
                                await(allInside);
                            }
                        });
                        return count[0];
                    }));
                }
                gate.countDown();
                for (Future<Integer> future : futures) {
                    assertEquals(rows, future.get(30, TimeUnit.SECONDS));
                }
            }
            // 스캔(읽기)은 디스크에 아무것도 쓰지 않는다.
            assertEquals(sizeBefore, Files.size(dataDir.resolve("t.tbl")));
        } finally {
            pool.shutdownNow();
        }
        // 닫으면서 한 번만 flush되어 정확히 rows줄이 남는다.
        assertEquals(rows, Files.readAllLines(dataDir.resolve("t.tbl")).size());
    }

    private static void await(CyclicBarrier barrier) {
        try {
            barrier.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException | BrokenBarrierException | TimeoutException e) {
            throw new AssertionError("스캔들이 동시에 읽기 락 안에 있지 못했다(직렬화됨)", e);
        }
    }

    @Test
    @Timeout(30)
    void 락을_제한_시간_안에_못_잡으면_QueryTimeoutException() throws Exception {
        Files.writeString(dataDir.resolve("t.schema"), "id:INT,v:STRING");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch reading = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (Table table = Table.open(dataDir, "t")) {
            table.insert(new Object[]{null, "a"});
            // 1) 긴 스캔이 읽기 락을 쥔다
            Future<?> scan = pool.submit(() -> table.scan(r -> {
                reading.countDown();
                awaitQuietly(release);
            }));
            assertTrue(reading.await(5, TimeUnit.SECONDS));

            // 2) 쓰기는 그 락을 기다리다 제한 시간에 포기한다. 파일·인덱스는 그대로다.
            long start = System.nanoTime();
            assertThrows(QueryTimeoutException.class, () -> table.insert(new Object[]{null, "b"}, 50_000_000L));
            assertTrue((System.nanoTime() - start) / 1e6 < 5_000, "제한 시간 근처에서 포기해야 한다");
            assertEquals(1, table.idIndexStats().keys());

            // 3) 기다리는 쓰기가 있으면 새 읽기도 줄을 선다(쓰기 기아 방지). 제한 시간이 있으면 무기한 기다리지 않는다.
            Future<?> waitingWriter = pool.submit(() -> table.insert(new Object[]{null, "c"}));
            Thread.sleep(100);
            assertThrows(QueryTimeoutException.class, () -> table.findById(1, 50_000_000L));
            assertThrows(QueryTimeoutException.class, () -> table.scanWhile(r -> true, 0));

            release.countDown();
            scan.get(10, TimeUnit.SECONDS);
            waitingWriter.get(10, TimeUnit.SECONDS);
            assertEquals(2, table.idIndexStats().keys(), "제한 시간 없는 쓰기는 기다렸다가 성공한다");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
