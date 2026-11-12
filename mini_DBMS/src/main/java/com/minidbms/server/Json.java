package com.minidbms.server;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/** JSON 응답 쓰기. ObjectMapper는 설정 후 불변이라 스레드 간에 공유해도 안전하다. */
final class Json {
    static final ObjectMapper MAPPER = new ObjectMapper();

    private Json() {
    }

    static void send(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes;
        try {
            bytes = MAPPER.writeValueAsBytes(body);
        } catch (JsonProcessingException e) {
            throw new IOException("JSON 직렬화 실패", e);
        }
        // 읽지 않은 요청 본문은 여기서 비우지 않는다. 413처럼 큰 본문을 끝까지 받으면 안 되는 경우가 있고,
        // HttpExchange.close가 남은 본문을 조금 버린 뒤 필요하면 연결을 닫아 keep-alive가 꼬이지 않게 처리한다.
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    static Map<String, Object> error(String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message);
        return body;
    }
}
