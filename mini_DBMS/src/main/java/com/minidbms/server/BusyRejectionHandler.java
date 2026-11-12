package com.minidbms.server;

import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 워커 풀과 큐가 모두 찼을 때 HttpServer의 요청을 503 SERVER_BUSY로 끝내기 위한 거절 정책.
 *
 * <p><b>왜 그냥 예외를 던지면 안 되나</b>: HttpServer의 dispatcher 스레드는 연결마다 내부 Exchange Runnable을 만들어
 * executor.execute()에 넘긴다. HTTP 요청을 읽어 HttpExchange를 만드는 일은 그 Runnable 안에서 일어나므로,
 * 거절 시점에는 응답을 쓸 HttpExchange가 아직 없다. 예외를 던지면 dispatcher가 로그만 남기고 연결이 응답 없이 끊긴다.
 *
 * <p><b>방법</b>: 거절된 Runnable을 호출한 스레드(dispatcher)에서 "거절됨" 표시를 단 채로 바로 실행한다.
 * 그러면 요청 파싱과 핸들러 호출이 이 스레드에서 일어나고, 핸들러 가드({@link ApiServer})가 표시를 보고
 * DB 작업 없이 503 JSON만 쓴다. 헤더를 읽고 작은 응답을 쓰는 비용이라 dispatcher를 오래 붙잡지 않는다.
 * (한계: 헤더를 아주 느리게 보내는 클라이언트가 있으면 그동안 dispatcher가 묶인다.)
 */
public final class BusyRejectionHandler implements RejectedExecutionHandler {
    private static final ThreadLocal<Boolean> REJECTED = ThreadLocal.withInitial(() -> false);

    private final AtomicLong rejectedCount = new AtomicLong();

    @Override
    public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
        rejectedCount.incrementAndGet();
        REJECTED.set(true);
        try {
            task.run();
        } finally {
            REJECTED.remove();
        }
    }

    /** 지금 스레드가 거절된 요청을 처리 중인지. 핸들러가 503으로 답할지 판단할 때 쓴다. */
    public static boolean isRejectedRequest() {
        return REJECTED.get();
    }

    public long rejectedCount() {
        return rejectedCount.get();
    }
}
