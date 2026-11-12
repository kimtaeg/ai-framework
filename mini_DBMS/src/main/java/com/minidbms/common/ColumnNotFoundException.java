package com.minidbms.common;

/**
 * 테이블에 없는 컬럼을 참조했을 때.
 */
public class ColumnNotFoundException extends DbException {
    public ColumnNotFoundException(String message) {
        super(message);
    }

    public ColumnNotFoundException(String message, Throwable cause) {
        super(message, cause);
    }
}
