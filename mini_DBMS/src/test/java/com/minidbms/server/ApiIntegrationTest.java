package com.minidbms.server;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.http.HttpResponse;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** README의 API 명세 시나리오를 실제 서버에 HTTP로 그대로 실행한다. */
class ApiIntegrationTest {
    @TempDir
    Path dir;

    TestApi api;

    @BeforeEach
    void setUp() throws IOException {
        api = new TestApi(dir.resolve("data"));
    }

    @AfterEach
    void tearDown() {
        api.close();
    }

    @Test
    void INSERT_SELECT_EXPLAIN_흐름() {
        JsonNode inserted = api.results("INSERT INTO users (name, age, email) VALUES ('kim', 30, 'kim@test.com');"
                + "INSERT INTO users (name) VALUES ('lee')");
        assertEquals(1, inserted.get(0).get("insertedId").asLong());
        assertEquals(2, inserted.get(1).get("insertedId").asLong());

        JsonNode lookup = api.results("SELECT name, age FROM users WHERE id = 1").get(0);
        assertEquals("[[\"kim\",30]]", lookup.get("rows").toString());
        assertEquals("INDEX_LOOKUP", lookup.get("accessPath").asText());

        JsonNode range = api.results("SELECT id, email FROM users WHERE id BETWEEN 1 AND 2").get(0);
        assertEquals("[[1,\"kim@test.com\"],[2,null]]", range.get("rows").toString());
        assertEquals("INDEX_RANGE", range.get("accessPath").asText());

        JsonNode scan = api.results("SELECT id FROM users WHERE name = 'lee'").get(0);
        assertEquals("[[2]]", scan.get("rows").toString());
        assertEquals("FULL_SCAN", scan.get("accessPath").asText());

        JsonNode explain = api.results("EXPLAIN SELECT * FROM users WHERE id >= 2 LIMIT 1").get(0);
        assertEquals("EXPLAIN", explain.get("type").asText());
        assertEquals("[\"users\",\"INDEX_RANGE\",\"id 2 .. +∞ (id >= 2), LIMIT 1\"]", explain.get("rows").get(0).toString());
    }

    @Test
    void 서버를_다시_띄워도_데이터와_id가_이어진다() throws IOException {
        api.results("INSERT INTO users (name) VALUES ('a'); INSERT INTO users (name) VALUES ('b')");
        api.close();

        api = new TestApi(dir.resolve("data"));
        assertEquals(3, api.results("INSERT INTO users (name) VALUES ('c')").get(0).get("insertedId").asLong());
        assertEquals("[[\"a\"],[\"b\"],[\"c\"]]", api.results("SELECT name FROM users").get(0).get("rows").toString());
    }

    @Test
    void 오류_응답은_명세의_JSON_형식이다() {
        HttpResponse<String> response = api.query("SELECT * FORM users");
        assertEquals(400, response.statusCode());
        JsonNode body = api.json(response);
        assertEquals("PARSE_ERROR", body.get("error").asText());
        assertEquals("Expected FROM but found 'form' at 9", body.get("message").asText());
        assertEquals(2, body.size(), "error와 message 두 필드");
    }

    @Test
    void health와_stats() {
        api.results("SELECT * FROM users");
        assertEquals("UP", api.json(api.get("/health")).get("status").asText());
        JsonNode stats = api.json(api.get("/stats"));
        assertTrue(stats.get("requests").get("handled").asLong() >= 2);
        assertEquals(8, stats.get("pool").get("coreThreads").asInt());
    }
}
