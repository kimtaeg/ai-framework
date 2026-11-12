package com.minidbms.common;

/**
 * 파일 I/O 실패 또는 저장 파일 형식이 깨졌을 때.
 */
public class StorageException extends DbException {
    public StorageException(String message) {
        super(message);
    }

    public StorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
