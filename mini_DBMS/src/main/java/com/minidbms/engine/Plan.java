package com.minidbms.engine;

/**
 * Planner가 고른 실행 계획.
 *
 * @param low    인덱스 경로일 때 id 하한(포함). FULL_SCAN이면 의미 없음
 * @param high   인덱스 경로일 때 id 상한(포함). low > high면 결과가 없는 범위다.
 * @param reason EXPLAIN에 보여줄 선택 이유
 */
record Plan(AccessPath path, long low, long high, String reason) {
    static Plan fullScan(String reason) {
        return new Plan(AccessPath.FULL_SCAN, 0, -1, reason);
    }

    boolean isEmptyRange() {
        return path != AccessPath.FULL_SCAN && low > high;
    }

    /** EXPLAIN의 detail 칸 */
    String detail() {
        if (path == AccessPath.FULL_SCAN) {
            return reason;
        }
        if (isEmptyRange()) {
            return "id 범위가 비어 있음 (" + reason + ") → 읽지 않음";
        }
        return (path == AccessPath.INDEX_LOOKUP ? "id = " + low : "id " + bound(low) + " .. " + bound(high))
                + " (" + reason + ")";
    }

    private static String bound(long value) {
        if (value == Long.MIN_VALUE) {
            return "-∞";
        }
        return value == Long.MAX_VALUE ? "+∞" : Long.toString(value);
    }
}
