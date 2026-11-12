package com.minidbms.server;

import java.nio.file.Path;

/**
 * @param port          0이면 비어 있는 포트를 고른다(테스트용)
 * @param coreThreads   평소 유지하는 워커 수
 * @param maxThreads    큐가 가득 찼을 때 늘릴 수 있는 최대 워커 수
 * @param queueCapacity 워커를 기다리는 요청 큐 크기. 넘치면 503
 */
public record ServerConfig(int port, int coreThreads, int maxThreads, int queueCapacity, Path dataDir) {
    public ServerConfig {
        if (port < 0 || port > 65535) {
            throw new IllegalArgumentException("포트는 0~65535여야 합니다: " + port);
        }
    }
}
