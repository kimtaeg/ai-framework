package com.minidbms.sql.parser.ast;

public enum Operator {
    EQ("="), NEQ("!="), LT("<"), LTE("<="), GT(">"), GTE(">=");

    private final String symbol;

    Operator(String symbol) {
        this.symbol = symbol;
    }

    public String symbol() {
        return symbol;
    }
}
