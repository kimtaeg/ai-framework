package com.minidbms.common;

/**
 * 문법과 타입은 맞지만 테이블 규칙을 어겼을 때. 예: 자동 부여 대상인 id에 값을 직접 넣음.
 */
public class ConstraintViolationException extends DbException {
    public ConstraintViolationException(String message) {
        super(message);
    }
}
