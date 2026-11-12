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
import java.util.concurrent.atomic.AtomicBoolean;

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
    /** SELECT 결과 크기 상한(대략적인 문자 수). 큰 값을 여러 번 투영한 결과가 힙을 다 쓰지 않게 한다. */
    static final long MAX_RESULT_BYTES = 16L * 1024 * 1024;
    /**
     * 요청 줄과 헤더를 다 받을 때까지 기다리는 최대 초. 넘으면 JDK HttpServer의 타이머가 연결을 끊는다.
     * 포화 시 거절된 요청은 dispatcher 스레드에서 파싱되므로, 헤더를 끝내지 않는 연결이 dispatcher를 묶지 못하게 하는 상한이다.
     */
    static final String MAX_REQUEST_TIME_PROPERTY = "sun.net.httpserver.maxReqTime";
    static final long MAX_REQUEST_TIME_SECONDS = 10;

    private final ServerConfig config;
    private final DatabaseEngine engine;
    private final ThreadPoolExecutor executor;
    private final HttpServer server;
    private final ServerLog log;
    private final RequestStats stats = new RequestStats();
    private final long startedAt = System.currentTimeMillis();
    private final AtomicBoolean stopped = new AtomicBoolean();

    public ApiServer(ServerConfig config) throws IOException {
        this(config, System.out);
    }

    /** @param logOut 요청 로그와 서버 오류를 쓸 곳 */
    public ApiServer(ServerConfig config, PrintStream logOut) throws IOException {
        this.config = config;
        this.log = new ServerLog(logOut);
        this.executor = ThreadPoolFactory.create(config.coreThreads(), config.maxThreads(), config.queueCapacity());
        // JDK HttpServer는 이 속성을 처음 서버를 만들 때 한 번 읽는다. 운영자가 -D로 이미 정했으면 그 값을 존중한다.
        if (System.getProperty(MAX_REQUEST_TIME_PROPERTY) == null) {
            System.setProperty(MAX_REQUEST_TIME_PROPERTY, Long.toString(MAX_REQUEST_TIME_SECONDS));
        }
        // 기본은 루프백. 인증·TLS가 없으므로 다른 컴퓨터에서 접속하게 하려면 --host로 명시해야 한다.
        this.server = HttpServer.create(new InetSocketAddress(config.host(), config.port()), 0);
        this.server.setExecutor(executor);
        this.engine = new DatabaseEngine(config.dataDir());
        this.engine.setMaxResultRows(config.maxResultRows());
        this.engine.setQueryTimeoutMillis(config.queryTimeoutMillis());
        this.engine.setMaxResultBytes(MAX_RESULT_BYTES);
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

    /** 실제로 바인딩된 주소 */
    java.net.InetSocketAddress address() {
        return server.getAddress();
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
                    respondRejected(exchange, BusyRejectionHandler.rejectionReason());
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

    private static void respondRejected(HttpExchange exchange, BusyRejectionHandler.Reason reason) throws IOException {
        if (reason == BusyRejectionHandler.Reason.SHUTTING_DOWN) {
            // 이 연결로 다음 요청을 보내지 말라고 알린다. 곧 연결이 닫힌다.
            exchange.getResponseHeaders().set("Connection", "close");
            Json.send(exchange, 503, Json.error("SHUTTING_DOWN", "서버가 종료 중입니다. 새 요청을 받지 않습니다"));
            return;
        }
        exchange.getResponseHeaders().set("Retry-After", Integer.toString(RETRY_AFTER_SECONDS));
        Json.send(exchange, 503, Json.error("SERVER_BUSY", "서버가 처리할 수 있는 요청 수를 넘었습니다. 잠시 후 다시 시도하세요"));
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

    /** 설정의 종료 대기 시간으로 {@link #stop(int)} */
    public void stop() {
        stop(config.shutdownGraceSeconds());
    }

    /**
     * 우아한 종료. 순서가 중요하다.
     * <ol>
     *   <li><b>새 요청 거부</b>: executor.shutdown(). 이후 dispatcher가 넘기는 요청은 거절 핸들러로 가서 503 SHUTTING_DOWN을 받는다.
     *       이미 큐에 들어온 요청과 처리 중인 요청은 그대로 실행된다.</li>
     *   <li><b>완료 대기</b>: 워커가 모두 끝날 때까지 최대 graceSeconds 기다린다. 넘기면 워커를 interrupt하고 조금 더 기다린다.</li>
     *   <li><b>연결 닫기</b>: server.stop(0)으로 리스너와 남은 연결을 닫는다.</li>
     *   <li><b>flush</b>: engine.close()가 모든 테이블 버퍼를 파일로 내려쓰고 닫는다. 테이블 쓰기 락을 거치므로
     *       아직 읽는 중인 요청이 있으면 그 요청이 끝난 뒤에 닫는다.</li>
     * </ol>
     * HttpServer.stop을 먼저 부르면 리스너와 함께 연결도 닫혀서, 큐에서 기다리던 요청이 응답할 곳을 잃는다.
     * 여러 번 불러도 한 번만 실행된다.
     */
    public void stop(int graceSeconds) {
        if (!stopped.compareAndSet(false, true)) {
            return;
        }
        int inFlight = executor.getActiveCount() + executor.getQueue().size();
        log.info("종료 시작: 새 요청 거부, 처리 중·대기 중 요청 " + inFlight + "개를 최대 " + graceSeconds + "초 기다립니다");
        executor.shutdown();
        boolean terminated = false;
        try {
            terminated = executor.awaitTermination(graceSeconds, TimeUnit.SECONDS);
            if (!terminated) {
                log.info("종료 대기 시간 초과: 남은 요청 " + (executor.getActiveCount() + executor.getQueue().size())
                        + "개의 워커를 중단합니다");
                executor.shutdownNow();
                terminated = executor.awaitTermination(5, TimeUnit.SECONDS);
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        server.stop(0);
        if (!terminated) {
            // interrupt로도 끝나지 않은 워커가 테이블 읽기 락을 쥐고 있으면 engine.close()의 쓰기 락이 무기한 기다린다.
            // 그래서 엔진을 닫지 않고 끝낸다. 끝난 요청은 execute가 반환될 때 이미 flush했으므로, 잃는 것은
            // 아직 끝나지 않은 그 요청의 결과뿐이다.
            log.info("종료: 워커 " + executor.getActiveCount() + "개가 끝나지 않아 엔진을 닫지 않고 종료합니다"
                    + " (끝난 요청은 이미 flush됨)");
            return;
        }
        engine.close();
        log.info("종료 완료: 테이블 파일 flush 후 닫음");
    }

    /** stop 이후 워커가 모두 끝났는지 */
    boolean isTerminated() {
        return executor.isTerminated();
    }

    @Override
    public void close() {
        stop(0);
    }
}
