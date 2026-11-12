package com.minidbms.sql.parser.ast;

/**
 * SQL 값. 타입별 record를 따로 두지 않고 하나로 통일해서, 컬럼 타입과의 대조는 Executor가 한 곳에서 하게 한다.
 *
 * @param value Long, String, 또는 null(SQL NULL)
 */
public record Literal(Object value) {
    public static final Literal NULL = new Literal(null);

    public Literal {
        if (value != null && !(value instanceof Long) && !(value instanceof String)) {
            throw new IllegalArgumentException("Literal은 Long, String, null만 담을 수 있습니다: " + value.getClass());
        }
    }

    public static Literal of(long value) {
        return new Literal(value);
    }

    public static Literal of(String value) {
        return new Literal(value);
    }

    public boolean isNull() {
        return value == null;
    }

    @Override
    public String toString() {
        if (value instanceof String s) {
            return "'" + s.replace("'", "''") + "'";
        }
        return String.valueOf(value).toUpperCase();
    }
}
