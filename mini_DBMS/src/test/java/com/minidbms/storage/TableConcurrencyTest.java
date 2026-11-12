package com.minidbms.storage;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
                List<Future<Integer>> futures = new ArrayList<>();
                for (int t = 0; t < threads; t++) {
                    futures.add(pool.submit(() -> {
                        gate.await();
                        int[] count = {0};
                        table.scan(record -> count[0]++);
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
}
