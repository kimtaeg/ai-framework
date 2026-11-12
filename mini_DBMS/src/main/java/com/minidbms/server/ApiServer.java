package com.minidbms.server;

import com.minidbms.engine.DatabaseEngine;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.Closeable;
import java.io.IOException;
import java.io.PrintStream;
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
 * 모든 핸들러는 {@link #guard}로 감싼다. 가드가 하는 일:
 * 거절된 요청이면 503, 핸들러 예외는 ErrorMapper로 JSON 오류 응답, 처리 시간 집계, 요청 로그 한 줄.
 */
public final class ApiServer implements Closeable {
    static final int RETRY_AFTER_SECONDS = 1;

    private final ServerConfig config;
    private final DatabaseEngine engine;
    private final ThreadPoolExecutor executor;
    private final HttpServer server;
    private final ServerLog log;
    private final RequestStats stats = new RequestStats();
    private final long startedAt = System.currentTimeMillis();

    public ApiServer(ServerConfig config) throws IOException {
        this(config, System.out);
    }

    /** @param logOut 요청 로그와 서버 오류를 쓸 곳 */
    public ApiServer(ServerConfig config, PrintStream logOut) throws IOException {
        this.config = config;
        this.log = new ServerLog(logOut);
        this.executor = ThreadPoolFactory.create(config.coreThreads(), config.maxThreads(), config.queueCapacity());
        this.server = HttpServer.create(new InetSocketAddress(config.port()), 0);
        this.server.setExecutor(executor);
        this.engine = new DatabaseEngine(config.dataDir());
        route("/health", this::health);
        route("/stats", this::stats);
        route("/query", new QueryHandler(engine));
        // 등록하지 않은 경로는 HttpServer 기본 HTML 404 대신 JSON 404로 답한다.
        route("/", exchange -> {
            throw new ApiException(404, "NOT_FOUND",
                    "없는 경로입니다: " + exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
        });
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

    /** 경로에 핸들러를 단다. 모든 핸들러는 가드를 거친다. 테스트에서 느린 핸들러를 달 때도 쓴다. */
    void route(String path, HttpHandler handler) {
        // HttpServer는 접두사로 경로를 고른다("/query"는 "/query/x"도 받는다). 정확히 일치할 때만 처리하고 나머지는 404.
        server.createContext(path, guard(exchange -> {
            String requested = exchange.getRequestURI().getPath();
            if (!path.equals("/") && !requested.equals(path)) {
                throw new ApiException(404, "NOT_FOUND", "없는 경로입니다: " + exchange.getRequestMethod() + " " + requested);
            }
            handler.handle(exchange);
        }));
    }

    HttpHandler guard(HttpHandler handler) {
        return exchange -> {
            long start = System.nanoTime();
            boolean rejected = BusyRejectionHandler.isRejectedRequest();
            try {
                if (rejected) {
                    exchange.getResponseHeaders().set("Retry-After", Integer.toString(RETRY_AFTER_SECONDS));
                    Json.send(exchange, 503, Json.error("SERVER_BUSY", "서버가 처리할 수 있는 요청 수를 넘었습니다. 잠시 후 다시 시도하세요"));
                    return;
                }
                handler.handle(exchange);
            } catch (Exception e) {
                respondError(exchange, e);
            } finally {
                int status = exchange.getResponseCode();
                long nanos = System.nanoTime() - start;
                if (!rejected) {
                    stats.record(status, nanos);
                }
                log.request(Thread.currentThread().getName(), exchange.getRequestMethod(),
                        exchange.getRequestURI().getPath(), status, nanos / 1e6);
                exchange.close();
            }
        };
    }

    private void respondError(HttpExchange exchange, Exception error) {
        ErrorMapper.ApiError mapped = ErrorMapper.map(error);
        if (mapped.serverFault()) {
            log.error(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath() + " → " + mapped.code(), error);
        }
        if (exchange.getResponseCode() != -1) {
            return; // 이미 응답 헤더를 보냈으면 상태를 바꿀 수 없다. 로그만 남긴다.
        }
        try {
            mapped.headers().forEach((name, value) -> exchange.getResponseHeaders().set(name, value));
            Json.send(exchange, mapped.status(), mapped.body());
        } catch (IOException e) {
            // 클라이언트가 이미 연결을 끊은 경우 등. 응답할 방법이 없다.
            log.error("오류 응답을 보내지 못했습니다", e);
        }
    }

    private void health(HttpExchange exchange) throws IOException {
        requireGet(exchange, "/health");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "UP");
        body.put("uptimeMs", System.currentTimeMillis() - startedAt);
        body.put("pool", poolStatus());
        Json.send(exchange, 200, body);
    }

    /** 워커 풀과 요청 처리 통계 */
    private void stats(HttpExchange exchange) throws IOException {
        requireGet(exchange, "/stats");
        Map<String, Object> requests = new LinkedHashMap<>();
        requests.put("handled", stats.requests());
        requests.put("clientErrors", stats.clientErrors());
        requests.put("serverErrors", stats.serverErrors());
        requests.put("averageMs", Math.round(stats.averageMs() * 1000) / 1000.0);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("pool", poolStatus());
        body.put("requests", requests);
        body.put("uptimeMs", System.currentTimeMillis() - startedAt);
        Json.send(exchange, 200, body);
    }

    private Map<String, Object> poolStatus() {
        Map<String, Object> pool = new LinkedHashMap<>();
        pool.put("coreThreads", executor.getCorePoolSize());
        pool.put("maxThreads", executor.getMaximumPoolSize());
        pool.put("poolSize", executor.getPoolSize());
        pool.put("largestPoolSize", executor.getLargestPoolSize());
        pool.put("activeThreads", executor.getActiveCount());
        pool.put("queued", executor.getQueue().size());
        pool.put("queueCapacity", config.queueCapacity());
        // completedTaskCount는 근사값이다(ThreadPoolExecutor 문서). 지금 처리 중인 /stats 요청은 아직 포함되지 않는다.
        pool.put("completedTasks", executor.getCompletedTaskCount());
        pool.put("rejected", ThreadPoolFactory.rejectionHandler(executor).rejectedCount());
        return pool;
    }

    private static void requireGet(HttpExchange exchange, String path) {
        if (!exchange.getRequestMethod().equals("GET")) {
            throw ApiException.methodNotAllowed(path, "GET");
        }
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
