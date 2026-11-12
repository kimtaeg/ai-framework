package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.minidbms.engine.DatabaseEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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

class ShutdownTest {
    @TempDir
    Path dataDir;

    ApiServer server;
    Thread stopper;
    private final ByteArrayOutputStream logBytes = new ByteArrayOutputStream();
    private final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final ObjectMapper mapper = new ObjectMapper();
    private final CountDownLatch release = new CountDownLatch(1);

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING");
    }

    @AfterEach
    void tearDown() throws InterruptedException {
        release.countDown();
        if (stopper != null) {
            stopper.join(30_000);
        }
        if (server != null) {
            server.stop(0);
        }
    }

    private void start(int threads, int queue) throws IOException {
        server = new ApiServer(new ServerConfig(0, threads, threads, queue, dataDir, 100, 10),
                new PrintStream(logBytes, true, StandardCharsets.UTF_8));
        // 응답 전에 release를 기다리는 느린 요청. INSERT를 하고 기다리므로 종료 후 파일에 남는지도 볼 수 있다.
        server.route("/test/slow-insert", exchange -> {
            server.engine().execute("INSERT INTO users VALUES ('slow')");
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            Json.send(exchange, 200, Map.of("done", true));
        });
        server.start();
    }

    private URI uri(String path) {
        return URI.create("http://localhost:" + server.port() + path);
    }

    private CompletableFuture<HttpResponse<String>> getAsync(String path) {
        return client.sendAsync(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(30)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(10)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private void stopInBackground(int graceSeconds) {
        stopper = new Thread(() -> server.stop(graceSeconds), "test-stopper");
        stopper.start();
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

    @Test
    @Timeout(60)
    void 종료하면_새_요청은_503_SHUTTING_DOWN이고_처리_중_대기_중_요청은_끝까지_처리한다() throws Exception {
        start(1, 5);
        CompletableFuture<HttpResponse<String>> running = getAsync("/test/slow-insert");
        waitUntil(() -> server.executor().getActiveCount() == 1, "처리 중");
        CompletableFuture<HttpResponse<String>> queued = getAsync("/test/slow-insert");
        waitUntil(() -> server.executor().getQueue().size() == 1, "큐 대기");

        stopInBackground(10);
        waitUntil(() -> server.executor().isShutdown(), "종료 시작");

        // 1) 새 요청 거부
        HttpResponse<String> rejected = get("/health");
        assertEquals(503, rejected.statusCode());
        JsonNode body = mapper.readTree(rejected.body());
        assertEquals("SHUTTING_DOWN", body.get("error").asText());
        assertEquals("close", rejected.headers().firstValue("Connection").orElse(""));
        assertTrue(stopper.isAlive(), "처리 중인 요청이 끝날 때까지 stop은 기다린다");

        // 2) 처리 중·대기 중 요청 완료
        release.countDown();
        assertEquals(200, running.get(20, TimeUnit.SECONDS).statusCode());
        assertEquals(200, queued.get(20, TimeUnit.SECONDS).statusCode(), "종료 전에 큐에 들어온 요청도 처리한다");
        stopper.join(20_000);
        assertTrue(!stopper.isAlive(), "stop이 끝나야 한다");

        // 3) 연결 닫힘
        assertThrows(IOException.class, () -> get("/health"));

        // 4) flush: 처리 중이던 INSERT 두 건이 파일에 남아 재시작하면 보인다
        try (DatabaseEngine engine = new DatabaseEngine(dataDir)) {
            assertEquals(2, engine.execute("SELECT * FROM users").get(0).rows().size());
        }
        String log = logBytes.toString(StandardCharsets.UTF_8);
        assertTrue(log.contains("종료 시작: 새 요청 거부, 처리 중·대기 중 요청 2개"), log);
        assertTrue(log.contains("종료 완료"), log);
    }

    @Test
    @Timeout(60)
    void 대기_시간을_넘기면_워커를_중단하고_종료한다() throws Exception {
        start(1, 5);
        CompletableFuture<HttpResponse<String>> running = getAsync("/test/slow-insert");
        waitUntil(() -> server.executor().getActiveCount() == 1, "처리 중");

        long start = System.nanoTime();
        server.stop(1); // release를 주지 않는다 → 1초 뒤 interrupt
        double seconds = (System.nanoTime() - start) / 1e9;

        assertTrue(seconds < 8, "대기 시간 + 여유 안에 끝나야 한다: " + seconds + "s");
        assertTrue(logBytes.toString(StandardCharsets.UTF_8).contains("종료 대기 시간 초과"), logBytes.toString(StandardCharsets.UTF_8));
        // interrupt로 깨어난 요청은 응답을 쓰려 하지만 연결은 이미 닫히고 있다. 어느 쪽이든 서버는 멈춰야 한다.
        running.handle((r, e) -> null).get(20, TimeUnit.SECONDS);
        assertTrue(server.isTerminated(), "interrupt된 워커가 끝나야 stop이 엔진까지 닫는다");
        assertTrue(logBytes.toString(StandardCharsets.UTF_8).contains("종료 완료"), logBytes.toString(StandardCharsets.UTF_8));
        server = null;
    }

    @Test
    void stop은_여러_번_불러도_한_번만_실행된다() throws Exception {
        start(1, 5);
        server.stop(0);
        server.stop(0);
        server.close();
        long starts = logBytes.toString(StandardCharsets.UTF_8).lines().filter(l -> l.contains("종료 시작")).count();
        assertEquals(1, starts);
        server = null;
    }

    @Test
    void 큰_SELECT는_서버_최대_행_수에서_잘리고_truncated로_알린다() throws Exception {
        start(2, 5);
        StringBuilder sql = new StringBuilder();
        for (int i = 0; i < 150; i++) {
            sql.append("INSERT INTO users VALUES ('u").append(i).append("');");
        }
        server.engine().execute(sql.toString());

        JsonNode all = query("SELECT * FROM users");
        assertEquals(100, all.get("rowCount").asInt());
        assertEquals(100, all.get("rows").size());
        assertTrue(all.get("truncated").asBoolean());

        JsonNode limited = query("SELECT * FROM users LIMIT 20");
        assertEquals(20, limited.get("rowCount").asInt());
        assertEquals(false, limited.get("truncated").asBoolean());
    }

    private JsonNode query(String sql) throws Exception {
        HttpResponse<String> response = client.send(HttpRequest.newBuilder(uri("/query"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(Map.of("sql", sql)))).build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        return mapper.readTree(response.body()).get("results").get(0);
    }
}
