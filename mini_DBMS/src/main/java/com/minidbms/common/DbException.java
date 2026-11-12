package com.minidbms.common;

/**
 * 미니 DBMS의 모든 예외의 부모. 호출자가 DbException 하나만 잡아도
 * DB 오류와 JVM 오류(NPE 등)를 구분할 수 있게 한다.
 */
public class DbException extends RuntimeException {
    public DbException(String message) {
        super(message);
    }

    public DbException(String message, Throwable cause) {
        super(message, cause);
    }
}
