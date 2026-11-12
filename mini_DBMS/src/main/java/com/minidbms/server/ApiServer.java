package com.minidbms.server;

import com.minidbms.engine.DatabaseEngine;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.Closeable;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * JDK HttpServer 기반 API 서버.
 *
 * <pre>
 * 연결 ─▶ dispatcher 스레드 ─▶ executor.execute(요청)
 *                                  ├─ 워커 여유/큐 여유 → db-worker-N 이 핸들러 실행
 *                                  └─ 둘 다 가득 → BusyRejectionHandler: dispatcher가 "거절됨" 표시로 실행 → 503
 * </pre>
 *
 * 모든 핸들러는 {@link #guard}로 감싸서, 거절된 요청이면 본래 일을 하지 않고 503 SERVER_BUSY를 돌려준다.
 */
public final class ApiServer implements Closeable {
    static final int RETRY_AFTER_SECONDS = 1;

    private final ServerConfig config;
    private final DatabaseEngine engine;
    private final ThreadPoolExecutor executor;
    private final HttpServer server;
    private final long startedAt = System.currentTimeMillis();

    public ApiServer(ServerConfig config) throws IOException {
        this.config = config;
        this.executor = ThreadPoolFactory.create(config.coreThreads(), config.maxThreads(), config.queueCapacity());
        this.server = HttpServer.create(new InetSocketAddress(config.port()), 0);
        this.server.setExecutor(executor);
        this.engine = new DatabaseEngine(config.dataDir());
        route("/health", this::health);
        // 등록하지 않은 경로는 HttpServer 기본 HTML 404 대신 JSON 404로 답한다.
        route("/", exchange -> Json.send(exchange, 404,
                Json.error("NOT_FOUND", "없는 경로입니다: " + exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath())));
    }

    public void start() {
        server.start();
    }

    /** 실제로 열린 포트(설정이 0이면 OS가 고른 포트) */
    public int port() {
        return server.getAddress().getPort();
    }

    ThreadPoolExecutor executor() {
        return executor;
    }

    DatabaseEngine engine() {
        return engine;
    }

    /** 경로에 핸들러를 단다. 모든 핸들러는 거절 가드를 거친다. 테스트에서 느린 핸들러를 달 때도 쓴다. */
    void route(String path, HttpHandler handler) {
        server.createContext(path, guard(handler));
    }

    static HttpHandler guard(HttpHandler handler) {
        return exchange -> {
            try {
                if (BusyRejectionHandler.isRejectedRequest()) {
                    exchange.getResponseHeaders().set("Retry-After", Integer.toString(RETRY_AFTER_SECONDS));
                    Json.send(exchange, 503, Json.error("SERVER_BUSY", "서버가 처리할 수 있는 요청 수를 넘었습니다. 잠시 후 다시 시도하세요"));
                    return;
                }
                handler.handle(exchange);
            } catch (RuntimeException e) {
                // 핸들러의 예상 못 한 오류도 연결을 끊지 않고 JSON 500으로 답한다.
                Json.send(exchange, 500, Json.error("INTERNAL_ERROR", e.getClass().getSimpleName() + ": " + e.getMessage()));
            } finally {
                exchange.close();
            }
        };
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            exchange.getResponseHeaders().set("Allow", "GET");
            Json.send(exchange, 405, Json.error("METHOD_NOT_ALLOWED", "/health는 GET만 지원합니다"));
            return;
        }
        Map<String, Object> pool = new LinkedHashMap<>();
        pool.put("coreThreads", executor.getCorePoolSize());
        pool.put("maxThreads", executor.getMaximumPoolSize());
        pool.put("poolSize", executor.getPoolSize());
        pool.put("activeThreads", executor.getActiveCount());
        pool.put("queued", executor.getQueue().size());
        pool.put("queueCapacity", config.queueCapacity());
        pool.put("rejected", ThreadPoolFactory.rejectionHandler(executor).rejectedCount());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "UP");
        body.put("uptimeMs", System.currentTimeMillis() - startedAt);
        body.put("pool", pool);
        Json.send(exchange, 200, body);
    }

    /**
     * 새 연결을 그만 받고, 처리 중인 요청이 끝나기를 기다린 뒤 엔진을 닫는다(버퍼 flush).
     *
     * @param graceSeconds 처리 중인 요청을 기다릴 최대 시간
     */
    public void stop(int graceSeconds) {
        server.stop(graceSeconds);
        executor.shutdown();
        try {
            if (!executor.awaitTermination(graceSeconds + 5L, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        engine.close();
    }

    @Override
    public void close() {
        stop(0);
    }
}
