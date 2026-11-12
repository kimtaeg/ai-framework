package com.minidbms.storage;

import com.minidbms.common.StorageException;

import java.util.Arrays;
import java.util.Locale;
import java.util.stream.Collectors;

public enum ColumnType {
    INT,
    STRING;

    /**
     * 스키마 파일의 타입 문자열을 읽는다. 사람이 직접 편집하는 파일이라
     * "int", " String " 같은 표기도 받아준다.
     */
    public static ColumnType parse(String raw) {
        String normalized = raw.trim().toUpperCase(Locale.ROOT);
        for (ColumnType type : values()) {
            if (type.name().equals(normalized)) {
                return type;
            }
        }
        String allowed = Arrays.stream(values()).map(Enum::name).collect(Collectors.joining(", "));
        throw new StorageException("알 수 없는 컬럼 타입 '" + raw.trim() + "' (허용: " + allowed + ")");
    }
}
