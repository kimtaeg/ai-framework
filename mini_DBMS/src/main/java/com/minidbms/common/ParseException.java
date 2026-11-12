package com.minidbms.common;

/**
 * SQL 문법 오류.
 */
public class ParseException extends DbException {
    public ParseException(String message) {
        super(message);
    }

    public ParseException(String message, Throwable cause) {
        super(message, cause);
    }
}
