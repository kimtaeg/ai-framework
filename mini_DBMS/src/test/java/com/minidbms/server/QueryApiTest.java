package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.minidbms.common.ColumnNotFoundException;
import com.minidbms.common.ConstraintViolationException;
import com.minidbms.common.DbException;
import com.minidbms.common.DuplicateKeyException;
import com.minidbms.common.ParseException;
import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;
import com.minidbms.common.TypeMismatchException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

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
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class QueryApiTest {
    @TempDir
    Path dataDir;

    ApiServer server;
    private final ByteArrayOutputStream logBytes = new ByteArrayOutputStream();
    private final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING,age:INT");
        server = new ApiServer(new ServerConfig(0, 4, 4, 100, dataDir), new PrintStream(logBytes, true, StandardCharsets.UTF_8));
        server.start();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private String log() {
        return logBytes.toString(StandardCharsets.UTF_8);
    }

    private HttpResponse<String> post(String path, String contentType, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path))
                .timeout(Duration.ofSeconds(10)).POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (contentType != null) {
            request.header("Content-Type", contentType);
        }
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private HttpResponse<String> query(String sql) throws Exception {
        return post("/query", "application/json", mapper.writeValueAsString(java.util.Map.of("sql", sql)));
    }

    private HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path)).build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private JsonNode ok(HttpResponse<String> response) throws IOException {
        assertEquals(200, response.statusCode(), response.body());
        return mapper.readTree(response.body());
    }

    private void assertError(HttpResponse<String> response, int status, String code) throws IOException {
        assertEquals(status, response.statusCode(), response.body());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
        JsonNode body = mapper.readTree(response.body());
        assertEquals(code, body.get("error").asText(), response.body());
        assertFalse(body.get("message").asText().isBlank());
    }

    // ---- 정상 ----

    @Test
    void INSERT는_affectedRows와_insertedId를_돌려준다() throws Exception {
        JsonNode result = ok(query("INSERT INTO users VALUES ('kim', 30)")).get("results").get(0);
        assertEquals("INSERT", result.get("type").asText());
        assertEquals(1, result.get("affectedRows").asInt());
        assertEquals(1, result.get("insertedId").asLong());
        assertTrue(result.get("elapsedMs").isNumber());
        assertFalse(result.has("rows"));
    }

    @Test
    void SELECT는_columns_rows_rowCount_accessPath를_돌려준다() throws Exception {
        query("INSERT INTO users VALUES ('kim', 30); INSERT INTO users (name) VALUES ('이순신')");

        JsonNode body = ok(query("SELECT id, name, age FROM users WHERE id >= 1"));
        JsonNode result = body.get("results").get(0);
        assertEquals("SELECT", result.get("type").asText());
        assertEquals("[\"id\",\"name\",\"age\"]", result.get("columns").toString());
        assertEquals("[[1,\"kim\",30],[2,\"이순신\",null]]", result.get("rows").toString(), "NULL은 JSON null");
        assertEquals(2, result.get("rowCount").asInt());
        assertEquals("INDEX_RANGE", result.get("accessPath").asText());
        assertTrue(result.get("elapsedMs").asDouble() >= 0);
        assertTrue(body.get("elapsedMs").isNumber());

        assertEquals("INDEX_LOOKUP", ok(query("SELECT * FROM users WHERE id = 2")).get("results").get(0).get("accessPath").asText());
        assertEquals("FULL_SCAN", ok(query("SELECT * FROM users WHERE name = 'kim'")).get("results").get(0).get("accessPath").asText());
    }

    @Test
    void 여러_문장의_결과를_순서대로_배열로_준다() throws Exception {
        JsonNode results = ok(query("INSERT INTO users VALUES ('a', 1); SELECT name FROM users; EXPLAIN SELECT * FROM users WHERE id = 1"))
                .get("results");
        assertEquals(3, results.size());
        assertEquals(List.of("INSERT", "SELECT", "EXPLAIN"),
                List.of(results.get(0).get("type").asText(), results.get(1).get("type").asText(), results.get(2).get("type").asText()));
        assertEquals("INDEX_LOOKUP", results.get(2).get("accessPath").asText());
        assertEquals("users", results.get(2).get("rows").get(0).get(0).asText());
    }

    @Test
    void 특수문자와_한글이_JSON으로_왕복된다() throws Exception {
        String name = "김\"정|글\\ 'x' \n 😀";
        query("INSERT INTO users (name) VALUES ('" + name.replace("'", "''") + "')");
        assertEquals(name, ok(query("SELECT name FROM users")).get("results").get(0).get("rows").get(0).get(0).asText());
    }

    @Test
    void Content_Type에_charset_utf8이_붙어도_된다() throws Exception {
        ok(post("/query", "application/json; charset=UTF-8", "{\"sql\":\"SELECT * FROM users\"}"));
    }

    // ---- DB 오류 코드 ----

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "SELEC * FROM users                          | 400 | PARSE_ERROR",
            "INSERT INTO users VALUES ('a')              | 400 | PARSE_ERROR",
            "SELECT nick FROM users                      | 400 | COLUMN_NOT_FOUND",
            "INSERT INTO users VALUES ('a', 'thirty')    | 400 | TYPE_MISMATCH",
            "SELECT * FROM ghost                         | 404 | TABLE_NOT_FOUND",
            "INSERT INTO users (id, name) VALUES (1, 'a')| 409 | CONSTRAINT_VIOLATION",
    })
    void DB_오류는_종류별_상태_코드와_code로_바뀐다(String sql, int status, String code) throws Exception {
        assertError(query(sql), status, code);
    }

    @Test
    void 저장소_오류는_500_STORAGE_ERROR이고_서버_로그에_남는다() throws Exception {
        Files.writeString(dataDir.resolve("broken.schema"), "id:INT,name:STRING");
        Files.writeString(dataDir.resolve("broken.tbl"), "1|a\n1|b\n"); // id 중복 → 로딩 실패
        HttpResponse<String> response = query("SELECT * FROM broken");
        assertError(response, 500, "STORAGE_ERROR");
        assertFalse(response.body().contains(dataDir.toString()), "응답에 서버 경로가 없어야 한다: " + response.body());
        assertFalse(response.body().contains("broken.tbl"), response.body());
        assertTrue(log().contains("ERROR POST /query → STORAGE_ERROR"), log());
        assertTrue(log().contains("StorageException"), "스택 트레이스가 로그에 있어야 한다");
    }

    @Test
    void 예상하지_못한_예외는_500이고_메시지는_감추고_로그에_남긴다() throws Exception {
        server.route("/test/npe", exchange -> {
            throw new NullPointerException("secret internal detail");
        });
        HttpResponse<String> response = post("/test/npe", "application/json", "{}");
        assertError(response, 500, "INTERNAL_ERROR");
        assertFalse(response.body().contains("secret"), "내부 메시지를 클라이언트에 보내지 않는다");
        assertTrue(log().contains("NullPointerException: secret internal detail"), log());
    }

    @Test
    void ErrorMapper는_모든_DbException_하위_타입을_매핑한다() {
        assertEquals(400, ErrorMapper.map(new ParseException("x")).status());
        assertEquals("COLUMN_NOT_FOUND", ErrorMapper.map(new ColumnNotFoundException("x")).code());
        assertEquals("TYPE_MISMATCH", ErrorMapper.map(new TypeMismatchException("x")).code());
        assertEquals(404, ErrorMapper.map(new TableNotFoundException("x")).status());
        assertEquals(409, ErrorMapper.map(new ConstraintViolationException("x")).status());
        assertEquals("DUPLICATE_KEY", ErrorMapper.map(new DuplicateKeyException("x")).code());
        assertEquals(409, ErrorMapper.map(new DuplicateKeyException("x")).status());
        assertTrue(ErrorMapper.map(new StorageException("x")).serverFault());
        assertEquals("DB_ERROR", ErrorMapper.map(new DbException("x")).code());
        assertEquals(500, ErrorMapper.map(new IllegalStateException("x")).status());
        assertFalse(ErrorMapper.map(new ParseException("x")).serverFault(), "4xx는 서버 로그 대상이 아니다");
    }

    // ---- 요청 오류 ----

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "{\"sql\": \"SELECT * FROM users\"     | INVALID_JSON",
            "not json                              | INVALID_JSON",
            "''                                    | INVALID_JSON",
            "[\"SELECT 1\"]                        | INVALID_REQUEST",
            "{}                                    | INVALID_REQUEST",
            "{\"query\": \"SELECT * FROM users\"}  | INVALID_REQUEST",
            "{\"sql\": null}                       | INVALID_REQUEST",
            "{\"sql\": 42}                         | INVALID_REQUEST",
            "{\"sql\": \"\"}                       | INVALID_REQUEST",
            "{\"sql\": \"   \"}                    | INVALID_REQUEST",
            "{\"sql\": \"-- 주석만;\"}             | INVALID_REQUEST",
    })
    void 잘못된_요청_본문은_400(String body, String code) throws Exception {
        assertError(post("/query", "application/json", body), 400, code);
    }

    @Test
    void Content_Type이_JSON이_아니면_415() throws Exception {
        String body = "{\"sql\":\"SELECT * FROM users\"}";
        assertError(post("/query", null, body), 415, "UNSUPPORTED_MEDIA_TYPE");
        assertError(post("/query", "text/plain", body), 415, "UNSUPPORTED_MEDIA_TYPE");
        assertError(post("/query", "application/json; charset=euc-kr", body), 415, "UNSUPPORTED_MEDIA_TYPE");
    }

    @Test
    void 본문이_1MB를_넘으면_413() throws Exception {
        String big = "{\"sql\": \"SELECT * FROM users WHERE name = '" + "x".repeat(QueryHandler.MAX_BODY_BYTES) + "'\"}";
        assertError(post("/query", "application/json", big), 413, "PAYLOAD_TOO_LARGE");

        // 1MB 이하는 받는다.
        String justUnder = "{\"sql\": \"SELECT * FROM users WHERE name = '" + "x".repeat(QueryHandler.MAX_BODY_BYTES - 100) + "'\"}";
        ok(post("/query", "application/json", justUnder));
    }

    @Test
    void query에_GET은_405() throws Exception {
        HttpResponse<String> response = get("/query");
        assertError(response, 405, "METHOD_NOT_ALLOWED");
        assertEquals("POST", response.headers().firstValue("Allow").orElseThrow());
        assertError(post("/stats", "application/json", "{}"), 405, "METHOD_NOT_ALLOWED");
    }

    // ---- /stats · 로그 ----

    @Test
    void stats는_풀_상태와_처리_통계를_준다() throws Exception {
        query("INSERT INTO users VALUES ('a', 1)");
        query("SELECT * FROM users");
        query("SELECT * FROM ghost");     // 404
        post("/query", "text/plain", ""); // 415

        JsonNode stats = ok(get("/stats"));
        JsonNode pool = stats.get("pool");
        assertEquals(1, pool.get("activeThreads").asInt(), "이 /stats 요청을 처리 중인 워커");
        assertEquals(0, pool.get("queued").asInt());
        assertTrue(pool.get("completedTasks").asLong() >= 3, stats.toString());
        assertEquals(0, pool.get("rejected").asLong());
        assertEquals(100, pool.get("queueCapacity").asInt());

        JsonNode requests = stats.get("requests");
        assertEquals(4, requests.get("handled").asLong(), "/stats 자신은 응답 뒤에 집계된다");
        assertEquals(2, requests.get("clientErrors").asLong());
        assertEquals(0, requests.get("serverErrors").asLong());
        assertTrue(requests.get("averageMs").asDouble() > 0);
    }

    @Test
    void 요청마다_스레드_메서드_경로_상태_시간을_한_줄로_로그에_남긴다() throws Exception {
        query("SELECT * FROM users");
        get("/nope");
        List<String> lines = log().lines().toList();
        assertTrue(lines.stream().anyMatch(l -> l.matches("\\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[db-worker-\\d+] POST /query 200 \\d+\\.\\d{3} ms")),
                log());
        assertTrue(lines.stream().anyMatch(l -> l.matches(".* \\[db-worker-\\d+] GET /nope 404 \\d+\\.\\d{3} ms")), log());
    }

    @Test
    void 경로의_줄바꿈으로_가짜_로그_줄을_만들_수_없다() throws Exception {
        get("/x%0a00:00:00.000%20%5Bdb-worker-9%5D%20POST%20/query%20200%200.001%20ms");
        List<String> lines = log().lines().toList();
        assertTrue(lines.stream().noneMatch(l -> l.startsWith("00:00:00.000")), log());
        assertTrue(log().contains("/x\\u000a00:00:00.000"), log());
    }

    @Test
    void TABLE_NOT_FOUND_응답에는_서버_경로가_없다() throws Exception {
        HttpResponse<String> response = query("SELECT * FROM ghost");
        assertError(response, 404, "TABLE_NOT_FOUND");
        assertFalse(response.body().contains(dataDir.toString()), response.body());
    }
}
