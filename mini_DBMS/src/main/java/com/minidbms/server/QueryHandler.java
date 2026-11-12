package com.minidbms.server;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.minidbms.engine.DatabaseEngine;
import com.minidbms.engine.QueryResult;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * POST /query {"sql": "..."} → engine.execute(sql) 결과를 JSON으로.
 *
 * <pre>
 * 200 {"results": [
 *        {"type":"SELECT","columns":["id","name"],"rows":[[1,"kim"]],"rowCount":1,"accessPath":"INDEX_LOOKUP","elapsedMs":0.021},
 *        {"type":"INSERT","affectedRows":1,"insertedId":2,"elapsedMs":0.012},
 *        {"type":"EXPLAIN","columns":[...],"rows":[[...]],"accessPath":"INDEX_RANGE","elapsedMs":0.004}],
 *      "elapsedMs": 0.05}
 * </pre>
 * 행은 객체가 아니라 columns 순서의 배열이다. 컬럼 이름을 행마다 반복하지 않아 응답이 작다.
 *
 * <p>요청 검사 순서: 메서드(405) → Content-Type(415) → 크기(413) → JSON(400 INVALID_JSON) → sql 필드(400 INVALID_REQUEST).
 * 여러 문장 중 하나가 실행 중 실패하면 그 오류만 돌려준다. 앞 문장은 이미 반영됐을 수 있다(트랜잭션 없음).
 */
final class QueryHandler implements HttpHandler {
    static final int MAX_BODY_BYTES = 1024 * 1024;

    private final DatabaseEngine engine;

    QueryHandler(DatabaseEngine engine) {
        this.engine = engine;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            throw ApiException.methodNotAllowed("/query", "POST");
        }
        requireJsonContentType(exchange);
        String sql = readSql(readBody(exchange));

        long start = System.nanoTime();
        List<QueryResult> results = engine.execute(sql);
        double totalMs = (System.nanoTime() - start) / 1e6;
        if (results.isEmpty()) {
            throw new ApiException(400, "INVALID_REQUEST", "실행할 SQL 문장이 없습니다 (주석이나 세미콜론만 있음)");
        }

        List<Map<String, Object>> body = new ArrayList<>(results.size());
        for (QueryResult result : results) {
            body.add(toJson(result));
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("results", body);
        response.put("elapsedMs", round(totalMs));
        Json.send(exchange, 200, response);
    }

    static Map<String, Object> toJson(QueryResult result) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("type", result.type().name());
        if (result.type() == QueryResult.Type.INSERT) {
            json.put("affectedRows", result.affectedRows());
            json.put("insertedId", result.rows().get(0).get(0));
        } else {
            json.put("columns", result.columns());
            json.put("rows", result.rows());
            if (result.type() == QueryResult.Type.SELECT) {
                json.put("rowCount", result.affectedRows());
                // true면 서버의 최대 행 수에서 잘렸다는 뜻이다. 전체가 필요하면 WHERE로 좁히거나 id 범위로 나눠 받는다.
                json.put("truncated", result.truncated());
            }
            json.put("accessPath", result.accessPath().name());
        }
        json.put("elapsedMs", round(result.elapsedMs()));
        return json;
    }

    /** 소수 셋째 자리까지. 마이크로초 단위면 충분하고 응답이 짧아진다. */
    private static double round(double ms) {
        return Math.round(ms * 1000) / 1000.0;
    }

    private static void requireJsonContentType(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("Content-Type");
        if (header == null) {
            throw new ApiException(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type: application/json 헤더가 필요합니다");
        }
        String[] parts = header.split(";");
        String mediaType = parts[0].trim().toLowerCase(Locale.ROOT);
        if (!mediaType.equals("application/json")) {
            throw new ApiException(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type은 application/json이어야 합니다: " + header);
        }
        for (int i = 1; i < parts.length; i++) {
            String[] param = parts[i].trim().split("=", 2);
            if (param[0].trim().equalsIgnoreCase("charset") && param.length == 2
                    && !param[1].trim().replace("\"", "").equalsIgnoreCase("utf-8")) {
                throw new ApiException(415, "UNSUPPORTED_MEDIA_TYPE", "charset은 utf-8만 지원합니다: " + header);
            }
        }
    }

    /**
     * 최대 1MB까지만 읽는다. Content-Length가 있으면 읽기 전에 거절하고, 없으면(chunked) 1MB+1바이트까지 읽어 넘는지 본다.
     * 남은 본문은 읽지 않는다. HttpExchange.close가 조금만 버리고 연결을 닫으므로 큰 업로드를 끝까지 받지 않는다.
     */
    static byte[] readBody(HttpExchange exchange) throws IOException {
        String length = exchange.getRequestHeaders().getFirst("Content-Length");
        if (length != null) {
            try {
                if (Long.parseLong(length.trim()) > MAX_BODY_BYTES) {
                    throw tooLarge();
                }
            } catch (NumberFormatException e) {
                throw new ApiException(400, "INVALID_REQUEST", "Content-Length가 숫자가 아닙니다: " + length);
            }
        }
        try (InputStream in = exchange.getRequestBody()) {
            byte[] body = in.readNBytes(MAX_BODY_BYTES + 1);
            if (body.length > MAX_BODY_BYTES) {
                throw tooLarge();
            }
            return body;
        }
    }

    private static ApiException tooLarge() {
        return new ApiException(413, "PAYLOAD_TOO_LARGE", "요청 본문은 최대 " + MAX_BODY_BYTES + "바이트(1MB)입니다");
    }

    static String readSql(byte[] body) {
        JsonNode root;
        try {
            root = Json.MAPPER.readTree(body);
        } catch (JsonProcessingException e) {
            throw new ApiException(400, "INVALID_JSON", "JSON을 해석할 수 없습니다: " + e.getOriginalMessage());
        } catch (IOException e) {
            throw new ApiException(400, "INVALID_JSON", "JSON을 해석할 수 없습니다: " + e.getMessage());
        }
        if (root == null || root.isMissingNode()) {
            throw new ApiException(400, "INVALID_JSON", "요청 본문이 비어 있습니다. {\"sql\": \"...\"} 형식이어야 합니다");
        }
        if (!root.isObject()) {
            throw new ApiException(400, "INVALID_REQUEST", "요청 본문은 {\"sql\": \"...\"} 형태의 JSON 객체여야 합니다");
        }
        JsonNode sql = root.get("sql");
        if (sql == null || sql.isNull()) {
            throw new ApiException(400, "INVALID_REQUEST", "\"sql\" 필드가 필요합니다");
        }
        if (!sql.isTextual()) {
            throw new ApiException(400, "INVALID_REQUEST", "\"sql\"은 문자열이어야 합니다 (받은 타입: " + sql.getNodeType() + ")");
        }
        if (sql.asText().isBlank()) {
            throw new ApiException(400, "INVALID_REQUEST", "\"sql\"이 비어 있습니다");
        }
        return sql.asText();
    }
}
