package com.minidbms.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.net.http.HttpResponse;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class QueryTimeoutApiTest {
    @TempDir
    Path dir;

    @Test
    @Timeout(60)
    void 제한_시간을_넘은_쿼리는_503_QUERY_TIMEOUT이고_워커가_바로_풀린다() throws Exception {
        // 워커 1개: 타임아웃 뒤에도 워커가 잡혀 있으면 다음 요청이 처리되지 않는다.
        try (TestApi api = new TestApi(dir.resolve("data"), new ServerConfig(0, 1, 1, 10, dir, 100, 5, 20))) {
            StringBuilder sql = new StringBuilder();
            for (int i = 0; i < 200_000; i++) {
                sql.append("INSERT INTO users (name, age) VALUES ('u', ").append(i % 100).append(");");
            }
            // 데이터 준비는 제한 시간 없이 하고, 측정할 때만 서버 설정(20 ms)으로 되돌린다.
            api.server.engine().setQueryTimeoutMillis(0);
            api.server.engine().execute(sql.toString());
            api.server.engine().setQueryTimeoutMillis(20);
            api.results("SELECT id FROM users WHERE id = 1"); // 로딩 완료

            long start = System.nanoTime();
            HttpResponse<String> slow = api.query("SELECT * FROM users WHERE name = 'nobody'");
            double ms = (System.nanoTime() - start) / 1e6;

            assertEquals(503, slow.statusCode(), slow.body());
            assertEquals("QUERY_TIMEOUT", api.json(slow).get("error").asText());
            assertTrue(api.json(slow).get("message").asText().contains("20 ms"));
            assertTrue(slow.headers().firstValue("Retry-After").isEmpty(), "다시 보내도 같으므로 Retry-After를 주지 않는다");
            assertTrue(ms < 2_000, "제한 시간 근처에서 응답해야 한다: " + ms + " ms");

            // 워커가 풀려 다음 요청을 바로 처리한다. 타임아웃은 서버 결함이 아니므로 serverErrors가 아니다.
            assertEquals(200, api.query("SELECT * FROM users WHERE id = 5").statusCode());
            assertEquals(1, api.json(api.get("/stats")).get("requests").get("serverErrors").asLong(),
                    "503은 5xx로 집계된다");
        }
    }

    @Test
    void ErrorMapper는_타임아웃을_503_QUERY_TIMEOUT으로_매핑하고_스택_트레이스는_남기지_않는다() {
        ErrorMapper.ApiError error = ErrorMapper.map(new com.minidbms.common.QueryTimeoutException("x"));
        assertEquals(503, error.status());
        assertEquals("QUERY_TIMEOUT", error.code());
        assertEquals(false, error.serverFault());
    }
}
