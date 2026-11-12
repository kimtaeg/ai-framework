package com.minidbms.server;

import java.util.concurrent.atomic.LongAdder;

/**
 * 워커가 처리한 요청의 개수와 시간 합. 여러 워커가 동시에 더하므로 LongAdder를 쓴다(AtomicLong보다 경합이 적다).
 * 거절된 요청(503)은 워커가 처리하지 않았으므로 여기에 넣지 않고 BusyRejectionHandler가 따로 센다.
 */
final class RequestStats {
    private final LongAdder requests = new LongAdder();
    private final LongAdder totalNanos = new LongAdder();
    private final LongAdder clientErrors = new LongAdder();
    private final LongAdder serverErrors = new LongAdder();

    void record(int status, long nanos) {
        requests.increment();
        totalNanos.add(nanos);
        if (status >= 500) {
            serverErrors.increment();
        } else if (status >= 400) {
            clientErrors.increment();
        }
    }

    long requests() {
        return requests.sum();
    }

    long clientErrors() {
        return clientErrors.sum();
    }

    long serverErrors() {
        return serverErrors.sum();
    }

    /** 처리한 요청이 없으면 0 */
    double averageMs() {
        long count = requests.sum();
        return count == 0 ? 0 : totalNanos.sum() / 1e6 / count;
    }
}
