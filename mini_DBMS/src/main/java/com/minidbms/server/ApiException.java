package com.minidbms.server;

import java.util.Map;

/**
 * HTTP 계층의 요청 오류(잘못된 JSON, 크기 초과, 메서드 불일치 등). DB 오류(DbException)와 달리 SQL을 실행하기 전에 난다.
 *
 * @param headers 응답에 함께 실을 헤더 (예: 405의 Allow)
 */
final class ApiException extends RuntimeException {
    private final int status;
    private final String code;
    private final Map<String, String> headers;

    ApiException(int status, String code, String message) {
        this(status, code, message, Map.of());
    }

    ApiException(int status, String code, String message, Map<String, String> headers) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }

    int status() {
        return status;
    }

    String code() {
        return code;
    }

    Map<String, String> headers() {
        return headers;
    }

    static ApiException methodNotAllowed(String path, String allowed) {
        return new ApiException(405, "METHOD_NOT_ALLOWED", path + "는 " + allowed + "만 지원합니다", Map.of("Allow", allowed));
    }
}
