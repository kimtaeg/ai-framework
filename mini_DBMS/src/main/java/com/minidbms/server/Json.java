package com.minidbms.server;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.InputStream;
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
        // 요청 본문을 다 읽지 않으면 keep-alive 연결에서 다음 요청과 섞일 수 있어 비워 둔다.
        try (InputStream in = exchange.getRequestBody()) {
            in.transferTo(OutputStream.nullOutputStream());
        }
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
