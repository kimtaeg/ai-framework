package com.minidbms.sql.parser.ast;

import java.util.Objects;

/**
 * WHERE column operator value. BETWEEN이면 value가 하한, high가 상한이다(양 끝 포함).
 *
 * @param high BETWEEN일 때만 값이 있고 그 외에는 null
 */
public record Condition(String column, Operator operator, Literal value, Literal high) {
    public Condition {
        Objects.requireNonNull(value, "value");
        if ((operator == Operator.BETWEEN) != (high != null)) {
            throw new IllegalArgumentException("BETWEEN만 상한 값을 가집니다: " + operator);
        }
    }

    /** BETWEEN이 아닌 비교 조건 */
    public Condition(String column, Operator operator, Literal value) {
        this(column, operator, value, null);
    }

    public static Condition between(String column, Literal low, Literal high) {
        return new Condition(column, Operator.BETWEEN, low, high);
    }

    @Override
    public String toString() {
        return operator == Operator.BETWEEN
                ? column + " BETWEEN " + value + " AND " + high
                : column + " " + operator.symbol() + " " + value;
    }
}
