package com.minidbms.server;

import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * 서버 로그. 요청마다 한 줄, 서버 오류는 스택 트레이스까지.
 * <pre>
 * 20:31:05.123 [db-worker-3] POST /query 200 1.234 ms
 * </pre>
 * PrintStream.println은 내부에서 동기화되므로 여러 워커가 동시에 써도 줄이 섞이지 않는다.
 * 스택 트레이스는 한 문자열로 만들어 한 번에 쓴다(여러 번 나눠 쓰면 다른 스레드의 줄이 끼어든다).
 */
final class ServerLog {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");

    private final PrintStream out;

    ServerLog(PrintStream out) {
        this.out = out;
    }

    void request(String thread, String method, String path, int status, double ms) {
        out.println(String.format(Locale.ROOT, "%s [%s] %s %s %d %.3f ms", now(), thread, method, path, status, ms));
    }

    void error(String context, Throwable error) {
        StringWriter trace = new StringWriter();
        error.printStackTrace(new PrintWriter(trace));
        out.print(now() + " [" + Thread.currentThread().getName() + "] ERROR " + context + "\n" + trace);
        out.flush();
    }

    private static String now() {
        return LocalTime.now().format(TIME);
    }
}
