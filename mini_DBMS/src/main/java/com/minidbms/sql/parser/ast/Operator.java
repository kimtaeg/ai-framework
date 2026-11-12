package com.minidbms.sql.parser.ast;

public enum Operator {
    EQ("="), NEQ("!="), LT("<"), LTE("<="), GT(">"), GTE(">="),
    /** 양 끝 포함. 상한은 Condition.high에 있다. */
    BETWEEN("BETWEEN");

    private final String symbol;

    Operator(String symbol) {
        this.symbol = symbol;
    }

    public String symbol() {
        return symbol;
    }
}
