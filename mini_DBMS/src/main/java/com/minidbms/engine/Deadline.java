package com.minidbms.engine;

import com.minidbms.common.QueryTimeoutException;

/**
 * execute 호출 하나의 마감 시각. 협조적 타임아웃이다: 스레드를 강제로 멈추지 않고, 실행 중인 코드가
 * 적당한 간격으로 {@link #check()}를 불러 스스로 그만둔다. 그래서 락·파일 스트림은 평소처럼 finally에서 정리된다.
 */
final class Deadline {
    /** 이 간격(읽은 후보 행 수)마다 시계를 본다. nanoTime 호출 비용을 행마다 내지 않으려고. */
    static final int CHECK_EVERY_ROWS = 1024;

    static final Deadline NONE = new Deadline(0, 0);

    private final long timeoutMillis;
    private final long deadlineNanos;

    private Deadline(long timeoutMillis, long deadlineNanos) {
        this.timeoutMillis = timeoutMillis;
        this.deadlineNanos = deadlineNanos;
    }

    /** @param timeoutMillis 0 이하면 제한 없음 */
    static Deadline after(long timeoutMillis) {
        if (timeoutMillis <= 0) {
            return NONE;
        }
        return new Deadline(timeoutMillis, System.nanoTime() + timeoutMillis * 1_000_000L);
    }

    /**
     * 마감을 nanos만큼 미룬 Deadline. 타임아웃에서 빼기로 한 구간(테이블을 처음 열 때의 인덱스 재구성)에 쓴 시간을 돌려준다.
     * 그러지 않으면 큰 테이블을 처음 쓰는 쿼리는 로딩만으로 제한 시간을 넘겨 항상 실패한다.
     */
    Deadline extendedBy(long nanos) {
        return isUnlimited() || nanos <= 0 ? this : new Deadline(timeoutMillis, deadlineNanos + nanos);
    }

    boolean isUnlimited() {
        return timeoutMillis <= 0;
    }

    void check() {
        // nanoTime은 넘칠 수 있으므로 두 값을 직접 비교하지 않고 차이의 부호를 본다.
        if (!isUnlimited() && System.nanoTime() - deadlineNanos >= 0) {
            throw new QueryTimeoutException("쿼리가 제한 시간 " + timeoutMillis + " ms를 넘어 중단했습니다. "
                    + "WHERE id 조건이나 LIMIT으로 읽는 범위를 줄이세요");
        }
    }
}
