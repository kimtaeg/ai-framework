package com.minidbms.server;

import java.nio.file.Path;

/**
 * @param port                 0이면 비어 있는 포트를 고른다(테스트용)
 * @param coreThreads          평소 유지하는 워커 수
 * @param maxThreads           큐가 가득 찼을 때 늘릴 수 있는 최대 워커 수
 * @param queueCapacity        워커를 기다리는 요청 큐 크기. 넘치면 503
 * @param maxResultRows        SELECT 한 번이 돌려줄 최대 행 수. 넘으면 잘라서 truncated=true
 * @param shutdownGraceSeconds 종료할 때 처리 중인 요청을 기다리는 최대 시간
 * @param queryTimeoutMillis   요청 하나(/query의 SQL 전체)의 제한 시간. 0이면 제한 없음
 */
public record ServerConfig(int port, int coreThreads, int maxThreads, int queueCapacity, Path dataDir,
                           long maxResultRows, int shutdownGraceSeconds, long queryTimeoutMillis) {
    public static final long DEFAULT_MAX_RESULT_ROWS = 10_000;
    public static final int DEFAULT_SHUTDOWN_GRACE_SECONDS = 10;
    public static final long DEFAULT_QUERY_TIMEOUT_MILLIS = 5_000;

    public ServerConfig {
        if (port < 0 || port > 65535) {
            throw new IllegalArgumentException("포트는 0~65535여야 합니다: " + port);
        }
        if (maxResultRows < 1) {
            throw new IllegalArgumentException("최대 행 수는 1 이상이어야 합니다: " + maxResultRows);
        }
        if (shutdownGraceSeconds < 0) {
            throw new IllegalArgumentException("종료 대기 시간은 0 이상이어야 합니다: " + shutdownGraceSeconds);
        }
        if (queryTimeoutMillis < 0) {
            throw new IllegalArgumentException("쿼리 제한 시간은 0 이상이어야 합니다: " + queryTimeoutMillis);
        }
    }

    /** 쿼리 제한 시간은 기본값 */
    public ServerConfig(int port, int coreThreads, int maxThreads, int queueCapacity, Path dataDir,
                        long maxResultRows, int shutdownGraceSeconds) {
        this(port, coreThreads, maxThreads, queueCapacity, dataDir, maxResultRows, shutdownGraceSeconds,
                DEFAULT_QUERY_TIMEOUT_MILLIS);
    }

    /** 최대 행 수·종료 대기·쿼리 제한 시간은 기본값 */
    public ServerConfig(int port, int coreThreads, int maxThreads, int queueCapacity, Path dataDir) {
        this(port, coreThreads, maxThreads, queueCapacity, dataDir, DEFAULT_MAX_RESULT_ROWS, DEFAULT_SHUTDOWN_GRACE_SECONDS,
                DEFAULT_QUERY_TIMEOUT_MILLIS);
    }
}
