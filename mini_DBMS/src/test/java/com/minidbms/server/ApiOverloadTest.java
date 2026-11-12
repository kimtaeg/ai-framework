package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 워커 1개 + 큐 1칸인 서버에 동시에 많은 요청을 보내면 일부는 503이어야 한다. */
class ApiOverloadTest {
    @TempDir
    Path dir;

    @Test
    @Timeout(120)
    void 워커_1개_큐_1개_서버에_동시_요청을_몰면_일부는_503_SERVER_BUSY다() throws Exception {
        try (TestApi api = new TestApi(dir.resolve("data"), new ServerConfig(0, 1, 1, 1, dir, 10, 5))) {
            // 요청 하나가 몇 ms 걸리도록 인덱스 없는 컬럼으로 전체 스캔할 데이터를 넣어 둔다(결과는 0행).
            StringBuilder sql = new StringBuilder();
            for (int i = 0; i < 20_000; i++) {
                sql.append("INSERT INTO users (name, age) VALUES ('u").append(i).append("', ").append(i % 100).append(");");
            }
            api.server.engine().execute(sql.toString());

            int requests = 60;
            ExecutorService pool = Executors.newFixedThreadPool(requests);
            List<Future<HttpResponse<String>>> futures = new ArrayList<>();
            CountDownLatch gate = new CountDownLatch(1);
            try {
                for (int i = 0; i < requests; i++) {
                    futures.add(pool.submit(() -> {
                        gate.await();
                        return api.query("SELECT * FROM users WHERE name = 'nobody'");
                    }));
                }
                gate.countDown();

                int ok = 0;
                int busy = 0;
                for (Future<HttpResponse<String>> future : futures) {
                    HttpResponse<String> response = future.get(60, TimeUnit.SECONDS);
                    if (response.statusCode() == 200) {
                        ok++;
                    } else {
                        assertEquals(503, response.statusCode(), "200 아니면 503이어야 한다: " + response.body());
                        assertEquals("SERVER_BUSY", api.json(response).get("error").asText());
                        assertEquals("1", response.headers().firstValue("Retry-After").orElse(""));
                        busy++;
                    }
                }
                assertTrue(busy > 0, "503이 하나도 없다 (ok=" + ok + ")");
                assertTrue(ok > 0, "200이 하나도 없다 (busy=" + busy + ")");
                assertEquals(requests, ok + busy);

                // 과부하가 지나면 다시 정상. 거절 수는 503 응답 수와 같다.
                JsonNode stats = api.json(api.get("/stats"));
                assertEquals(busy, stats.get("pool").get("rejected").asLong());
                assertEquals(200, api.get("/health").statusCode());
            } finally {
                pool.shutdownNow();
            }
        }
    }
}
