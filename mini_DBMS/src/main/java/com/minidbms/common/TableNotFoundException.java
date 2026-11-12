package com.minidbms.common;

/**
 * 존재하지 않는 테이블을 참조했을 때.
 */
public class TableNotFoundException extends DbException {
    public TableNotFoundException(String message) {
        super(message);
    }

    public TableNotFoundException(String message, Throwable cause) {
        super(message, cause);
    }
}
