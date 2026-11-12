package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApiServerTest {
    @TempDir
    Path dataDir;

    ApiServer server;
    private final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5)).build();
    private final ObjectMapper mapper = new ObjectMapper();

    private ApiServer start(int core, int max, int queue) throws IOException {
        server = new ApiServer(new ServerConfig(0, core, max, queue, dataDir), new java.io.PrintStream(java.io.OutputStream.nullOutputStream()));
        server.start();
        return server;
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
        }
    }

    private URI uri(String path) {
        return URI.create("http://localhost:" + server.port() + path);
    }

    private HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(10)).build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private CompletableFuture<HttpResponse<String>> getAsync(String path) {
        return client.sendAsync(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(20)).build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private JsonNode json(HttpResponse<String> response) throws IOException {
        assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("application/json"),
                "JSON 응답이어야 한다: " + response.headers().map());
        return mapper.readTree(response.body());
    }

    private static void waitUntil(BooleanSupplier condition, String what) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError("시간 안에 " + what + " 상태가 되지 않았다");
            }
            Thread.sleep(5);
        }
    }

    // ---- /health ----

    @Test
    void GET_health는_200과_풀_상태를_JSON으로_준다() throws Exception {
        start(4, 6, 50);
        HttpResponse<String> response = get("/health");

        assertEquals(200, response.statusCode());
        JsonNode body = json(response);
        assertEquals("UP", body.get("status").asText());
        assertTrue(body.get("uptimeMs").asLong() >= 0);
        JsonNode pool = body.get("pool");
        assertEquals(4, pool.get("coreThreads").asInt());
        assertEquals(6, pool.get("maxThreads").asInt());
        assertEquals(50, pool.get("queueCapacity").asInt());
        assertEquals(1, pool.get("activeThreads").asInt(), "지금 이 요청을 처리하는 워커 하나");
        assertEquals(0, pool.get("rejected").asLong());
    }

    @Test
    void health_외의_메서드는_405() throws Exception {
        start(1, 1, 10);
        HttpResponse<String> response = client.send(HttpRequest.newBuilder(uri("/health"))
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(405, response.statusCode());
        assertEquals("GET", response.headers().firstValue("Allow").orElseThrow());
        assertEquals("METHOD_NOT_ALLOWED", json(response).get("error").asText());
    }

    @Test
    void 없는_경로는_JSON_404() throws Exception {
        start(1, 1, 10);
        HttpResponse<String> response = get("/nope");
        assertEquals(404, response.statusCode());
        assertEquals(404, get("/health/extra").statusCode(), "등록한 경로의 하위 경로도 404");
        assertEquals("NOT_FOUND", json(response).get("error").asText());
    }

    @Test
    void 요청은_db_worker_스레드에서_처리된다() throws Exception {
        start(2, 2, 10);
        server.route("/test/thread", exchange -> Json.send(exchange, 200, Map.of("thread", Thread.currentThread().getName())));
        String thread = json(get("/test/thread")).get("thread").asText();
        assertTrue(thread.startsWith("db-worker-"), thread);
    }

    @Test
    void 핸들러의_예상_못한_오류는_JSON_500() throws Exception {
        start(1, 1, 10);
        server.route("/test/boom", exchange -> {
            throw new IllegalStateException("boom");
        });
        HttpResponse<String> response = get("/test/boom");
        assertEquals(500, response.statusCode());
        assertEquals("INTERNAL_ERROR", json(response).get("error").asText());
    }

    // ---- 과부하 ----

    @Test
    @Timeout(60)
    void 워커와_큐가_가득_차면_503_SERVER_BUSY를_JSON으로_돌려준다() throws Exception {
        start(1, 1, 1);
        CountDownLatch release = new CountDownLatch(1);
        server.route("/test/slow", exchange -> {
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            Json.send(exchange, 200, Map.of("done", true));
        });

        CompletableFuture<HttpResponse<String>> first = getAsync("/test/slow");   // 워커 1개 점유
        waitUntil(() -> server.executor().getActiveCount() == 1, "워커 점유");
        CompletableFuture<HttpResponse<String>> second = getAsync("/test/slow");  // 큐 1칸
        waitUntil(() -> server.executor().getQueue().size() == 1, "큐 가득");

        HttpResponse<String> third = get("/test/slow");                           // 거절
        assertEquals(503, third.statusCode());
        assertEquals("1", third.headers().firstValue("Retry-After").orElseThrow());
        JsonNode busy = json(third);
        assertEquals("SERVER_BUSY", busy.get("error").asText());
        assertTrue(busy.get("message").asText().length() > 0);

        // /health도 같은 풀을 거치므로 지금은 503이다(서버가 정말 바쁘다는 신호).
        assertEquals(503, get("/health").statusCode());

        release.countDown();
        assertEquals(200, first.get(20, TimeUnit.SECONDS).statusCode());
        assertEquals(200, second.get(20, TimeUnit.SECONDS).statusCode());
        waitUntil(() -> server.executor().getActiveCount() == 0, "워커 반환");
        JsonNode health = json(get("/health"));
        assertEquals(2, health.get("pool").get("rejected").asLong());
    }

    @Test
    @Timeout(60)
    void max_threads까지는_큐가_찬_뒤에_스레드를_늘려_받는다() throws Exception {
        start(1, 2, 1);
        CountDownLatch release = new CountDownLatch(1);
        server.route("/test/slow", exchange -> {
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            Json.send(exchange, 200, Map.of("done", true));
        });
        var a = getAsync("/test/slow");
        waitUntil(() -> server.executor().getActiveCount() == 1, "core 점유");
        var b = getAsync("/test/slow");
        waitUntil(() -> server.executor().getQueue().size() == 1, "큐 가득");
        var c = getAsync("/test/slow");    // 큐가 찼으므로 두 번째 스레드가 생겨 받는다
        waitUntil(() -> server.executor().getPoolSize() == 2, "max까지 증가");
        assertEquals(503, get("/test/slow").statusCode(), "core+큐+추가 스레드가 모두 차면 거절");

        release.countDown();
        for (var response : java.util.List.of(a, b, c)) {
            assertEquals(200, response.get(20, TimeUnit.SECONDS).statusCode());
        }
    }

    @Test
    void stop하면_더_이상_요청을_받지_않는다() throws Exception {
        start(1, 1, 10);
        assertEquals(200, get("/health").statusCode());
        server.stop(0);
        assertThrows(IOException.class, () -> get("/health"));
        server = null;
    }
}
