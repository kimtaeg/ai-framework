package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

/**
 * 통합 테스트용: 임시 데이터 폴더 + 랜덤 포트로 실제 ApiServer를 띄우고 java.net.http.HttpClient로 부른다.
 * 테스트마다 새로 만들고 close한다.
 */
final class TestApi implements AutoCloseable {
    static final String USERS_SCHEMA = "id:INT,name:STRING,age:INT,email:STRING";

    final Path dataDir;
    final ApiServer server;
    final HttpClient client;
    final ObjectMapper mapper = new ObjectMapper();

    /** @param config 포트·데이터 폴더는 무시하고 임시 폴더·포트 0으로 바꾼다 */
    TestApi(Path dataDir, ServerConfig config) throws IOException {
        this.dataDir = dataDir;
        Files.createDirectories(dataDir);
        if (!Files.exists(dataDir.resolve("users.schema"))) {
            Files.writeString(dataDir.resolve("users.schema"), USERS_SCHEMA);
        }
        ServerConfig actual = new ServerConfig(0, config.coreThreads(), config.maxThreads(), config.queueCapacity(),
                dataDir, config.maxResultRows(), config.shutdownGraceSeconds(), config.queryTimeoutMillis());
        this.server = new ApiServer(actual, new PrintStream(OutputStream.nullOutputStream()));
        this.server.start();
        this.client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10)).build();
    }

    TestApi(Path dataDir) throws IOException {
        this(dataDir, new ServerConfig(0, 8, 8, 1000, dataDir));
    }

    URI uri(String path) {
        return URI.create("http://localhost:" + server.port() + path);
    }

    HttpResponse<String> get(String path) {
        return send(HttpRequest.newBuilder(uri(path)).GET());
    }

    HttpResponse<String> post(String path, String contentType, String body) {
        HttpRequest.Builder request = HttpRequest.newBuilder(uri(path)).POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (contentType != null) {
            request.header("Content-Type", contentType);
        }
        return send(request);
    }

    /** POST /query {"sql": sql} */
    HttpResponse<String> query(String sql) {
        try {
            return post("/query", "application/json", mapper.writeValueAsString(Map.of("sql", sql)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 200을 기대하고 results 배열을 돌려준다. */
    JsonNode results(String sql) {
        HttpResponse<String> response = query(sql);
        if (response.statusCode() != 200) {
            throw new AssertionError("200이 아님: " + response.statusCode() + " " + response.body() + " ← " + sql);
        }
        return json(response).get("results");
    }

    JsonNode json(HttpResponse<String> response) {
        try {
            return mapper.readTree(response.body());
        } catch (IOException e) {
            throw new AssertionError("JSON이 아닌 응답: " + response.body(), e);
        }
    }

    private HttpResponse<String> send(HttpRequest.Builder request) {
        try {
            return client.send(request.timeout(Duration.ofSeconds(30)).build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
