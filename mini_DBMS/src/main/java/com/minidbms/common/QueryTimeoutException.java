package com.minidbms.common;

/**
 * 쿼리가 제한 시간을 넘어 중단됐을 때. 그 앞 문장의 결과는 이미 반영됐을 수 있다(트랜잭션 없음).
 */
public class QueryTimeoutException extends DbException {
    public QueryTimeoutException(String message) {
        super(message);
    }
}
