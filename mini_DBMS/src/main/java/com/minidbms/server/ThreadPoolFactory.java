package com.minidbms.server;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * API 서버의 워커 풀을 만든다.
 *
 * <p>ThreadPoolExecutor는 (1) core개까지 스레드를 만들고 (2) 그다음 큐에 쌓고 (3) 큐가 차면 max개까지 스레드를 늘리고
 * (4) 그래도 안 되면 거절한다. 큐가 유한(ArrayBlockingQueue)이어야 4단계가 생겨 과부하가 503으로 드러난다.
 * 무한 큐면 요청이 끝없이 쌓여 응답 시간만 길어지고 결국 메모리가 바닥난다.
 */
public final class ThreadPoolFactory {
    static final String THREAD_PREFIX = "db-worker-";
    static final long KEEP_ALIVE_SECONDS = 60;

    private ThreadPoolFactory() {
    }

    public static ThreadPoolExecutor create(int coreThreads, int maxThreads, int queueCapacity) {
        if (coreThreads < 1 || maxThreads < coreThreads || queueCapacity < 1) {
            throw new IllegalArgumentException("스레드 풀 설정이 잘못됐습니다: core=" + coreThreads + ", max=" + maxThreads
                    + ", queue=" + queueCapacity + " (1 <= core <= max, queue >= 1)");
        }
        return new ThreadPoolExecutor(coreThreads, maxThreads, KEEP_ALIVE_SECONDS, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(queueCapacity), namedThreads(), new BusyRejectionHandler());
    }

    /** "db-worker-1", "db-worker-2", ... 스레드 덤프·로그에서 DB 요청 스레드를 바로 알아보게 한다. */
    static ThreadFactory namedThreads() {
        AtomicInteger next = new AtomicInteger(1);
        return runnable -> {
            Thread thread = new Thread(runnable, THREAD_PREFIX + next.getAndIncrement());
            // 종료는 ApiServer.stop이 책임진다. 데몬이 아니어야 처리 중인 요청이 JVM 종료로 잘리지 않는다.
            thread.setDaemon(false);
            return thread;
        };
    }

    public static BusyRejectionHandler rejectionHandler(ThreadPoolExecutor executor) {
        return (BusyRejectionHandler) executor.getRejectedExecutionHandler();
    }
}
