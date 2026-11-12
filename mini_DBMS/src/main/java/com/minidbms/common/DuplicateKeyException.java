package com.minidbms.common;

/**
 * 유일해야 하는 키(인덱스의 id 등)가 이미 있을 때.
 */
public class DuplicateKeyException extends DbException {
    public DuplicateKeyException(String message) {
        super(message);
    }
}
