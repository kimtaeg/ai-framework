package com.minidbms.server;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;

/**
 * <pre>
 * java -jar mini-dbms.jar serve [--port 8080] [--threads 8] [--max-threads 8] [--queue 1000] [--data ./data]
 * </pre>
 * Ctrl+C(종료 신호)를 받으면 처리 중인 요청을 마치고 엔진을 닫은 뒤 끝난다.
 */
public final class ServeCommand {
    static final String USAGE = """
            사용법:
              java -jar mini-dbms.jar serve [--port 8080] [--threads 8] [--max-threads N] [--queue 1000] [--data ./data]
              --threads      평소 유지하는 워커 수 (core, 기본 8)
              --max-threads  큐가 가득 찼을 때 늘릴 최대 워커 수 (기본 --threads와 같음)
              --queue        워커를 기다리는 요청 큐 크기, 넘치면 503 (기본 1000)""";

    static final int GRACE_SECONDS = 3;

    private ServeCommand() {
    }

    static ServerConfig parse(String[] args) {
        int port = 8080;
        int threads = 8;
        Integer maxThreads = null;
        int queue = 1000;
        Path dataDir = Path.of("data");
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            switch (arg) {
                case "--port" -> port = intValue(args, ++i, arg, 0);
                case "--threads" -> threads = intValue(args, ++i, arg, 1);
                case "--max-threads" -> maxThreads = intValue(args, ++i, arg, 1);
                case "--queue" -> queue = intValue(args, ++i, arg, 1);
                case "--data" -> {
                    if (++i >= args.length) {
                        throw new IllegalArgumentException("--data 다음에 경로가 필요합니다");
                    }
                    dataDir = Path.of(args[i]);
                }
                default -> throw new IllegalArgumentException("알 수 없는 인자 '" + arg + "'");
            }
        }
        int max = maxThreads == null ? threads : maxThreads;
        if (max < threads) {
            throw new IllegalArgumentException("--max-threads(" + max + ")는 --threads(" + threads + ") 이상이어야 합니다");
        }
        return new ServerConfig(port, threads, max, queue, dataDir);
    }

    private static int intValue(String[] args, int i, String option, int min) {
        if (i >= args.length) {
            throw new IllegalArgumentException(option + " 다음에 값이 필요합니다");
        }
        int value;
        try {
            value = Integer.parseInt(args[i]);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(option + " 값은 정수여야 합니다: '" + args[i] + "'");
        }
        if (value < min) {
            throw new IllegalArgumentException(option + " 값은 " + min + " 이상이어야 합니다: " + value);
        }
        return value;
    }

    /** 서버를 띄우고 종료 신호까지 기다린다. */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        ServerConfig config;
        try {
            config = parse(args);
        } catch (IllegalArgumentException e) {
            err.println("ERROR: " + e.getMessage());
            err.println(USAGE);
            return 2;
        }
        if (!Files.isDirectory(config.dataDir())) {
            err.println("ERROR: 데이터 디렉터리가 없습니다: " + config.dataDir().toAbsolutePath());
            return 2;
        }

        ApiServer server;
        try {
            server = new ApiServer(config);
        } catch (IOException e) {
            err.println("ERROR: 서버를 열 수 없습니다 (포트 " + config.port() + "): " + e.getMessage());
            return 1;
        }
        CountDownLatch stopped = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            out.println("종료 중... 처리 중인 요청을 최대 " + GRACE_SECONDS + "초 기다립니다");
            server.stop(GRACE_SECONDS);
            stopped.countDown();
        }, "mini-dbms-server-shutdown"));

        server.start();
        out.printf("mini-dbms API 서버: http://localhost:%d (워커 %d~%d, 큐 %d, data=%s)%n",
                server.port(), config.coreThreads(), config.maxThreads(), config.queueCapacity(), config.dataDir());
        out.println("GET /health · 종료: Ctrl+C");
        try {
            stopped.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return 0;
    }
}
