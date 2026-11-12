package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** HTTP로 여러 클라이언트가 동시에 쓰고 읽을 때 */
class ApiConcurrencyTest {
    @TempDir
    Path dir;

    /** 모든 작업을 동시에 출발시키고 끝날 때까지 기다린다. 작업의 예외는 그대로 던진다. */
    private static void runConcurrently(int threads, Callable<Void> task) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch gate = new CountDownLatch(1);
            List<Future<Void>> futures = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                futures.add(pool.submit(() -> {
                    gate.await();
                    return task.call();
                }));
            }
            gate.countDown();
            for (Future<Void> future : futures) {
                future.get(180, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @Timeout(240)
    void 클라이언트_50개가_200건씩_동시에_INSERT하면_10000건_모두_성공하고_id가_중복되지_않는다() throws Exception {
        int clients = 50;
        int perClient = 200;
        int total = clients * perClient;
        try (TestApi api = new TestApi(dir.resolve("data"), new ServerConfig(0, 8, 8, 1000, dir, 20_000, 10))) {
            AtomicInteger ok = new AtomicInteger();
            AtomicInteger clientIds = new AtomicInteger();
            Set<Long> insertedIds = ConcurrentHashMap.newKeySet();

            runConcurrently(clients, () -> {
                int client = clientIds.getAndIncrement();
                long lastId = 0;
                for (int seq = 0; seq < perClient; seq++) {
                    HttpResponse<String> response = api.query("INSERT INTO users (name, age) VALUES ('c" + client + "', " + seq + ")");
                    assertEquals(200, response.statusCode(), response.body());
                    long id = api.json(response).get("results").get(0).get("insertedId").asLong();
                    assertTrue(insertedIds.add(id), "id 중복: " + id);
                    assertTrue(id > lastId, "한 클라이언트 안에서 id가 줄었다");
                    lastId = id;
                    ok.incrementAndGet();
                }
                return null;
            });

            assertEquals(total, ok.get(), "성공 응답 수");
            assertEquals(total, insertedIds.size());

            JsonNode all = api.results("SELECT id, name, age FROM users").get(0);
            assertEquals(total, all.get("rowCount").asInt());
            assertFalse(all.get("truncated").asBoolean());
            Set<Long> ids = new HashSet<>();
            Map<String, Integer> perName = new ConcurrentHashMap<>();
            for (JsonNode row : all.get("rows")) {
                ids.add(row.get(0).asLong());
                perName.merge(row.get(1).asText(), 1, Integer::sum);
            }
            assertEquals(total, ids.size(), "SELECT 결과에 id 중복 없음");
            for (long id = 1; id <= total; id++) {
                assertTrue(ids.contains(id), "id " + id + " 누락 (1~" + total + " 연속이어야 함)");
            }
            assertEquals(clients, perName.size());
            perName.values().forEach(count -> assertEquals(perClient, count));
            assertEquals(0, api.json(api.get("/stats")).get("pool").get("rejected").asLong());
        }
    }

    @Test
    @Timeout(240)
    void 읽기와_쓰기를_섞어도_모든_응답이_200이고_읽은_행은_완전하다() throws Exception {
        try (TestApi api = new TestApi(dir.resolve("data"))) {
            AtomicInteger writers = new AtomicInteger();
            runConcurrently(32, () -> {
                boolean writer = writers.getAndIncrement() % 2 == 0;
                for (int i = 0; i < 100; i++) {
                    if (writer) {
                        assertEquals(200, api.query("INSERT INTO users (name, age, email) VALUES ('w', " + i + ", 'w" + i + "@x')").statusCode());
                    } else {
                        JsonNode result = api.results(i % 2 == 0 ? "SELECT * FROM users WHERE id >= 1 LIMIT 50" : "SELECT * FROM users WHERE name = 'w'").get(0);
                        for (JsonNode row : result.get("rows")) {
                            assertEquals(4, row.size());
                            assertEquals("w", row.get(1).asText());
                            assertEquals("w" + row.get(2).asInt() + "@x", row.get(3).asText(), "필드가 섞인 행: " + row);
                        }
                    }
                }
                return null;
            });
            assertEquals(16 * 100, api.results("SELECT id FROM users").get(0).get("rowCount").asInt());
        }
    }
}
