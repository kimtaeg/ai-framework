package com.minidbms.common;

/**
 * 값의 타입이 컬럼 타입과 맞지 않을 때.
 */
public class TypeMismatchException extends DbException {
    public TypeMismatchException(String message) {
        super(message);
    }

    public TypeMismatchException(String message, Throwable cause) {
        super(message, cause);
    }
}
