package com.minidbms.sql.lexer;

public enum TokenType {
    // 키워드
    INSERT, INTO, VALUES, SELECT, FROM, WHERE, AND, BETWEEN,

    // 값
    IDENT, NUMBER, STRING,

    // 기호
    COMMA, LPAREN, RPAREN, STAR, SEMICOLON,
    EQ, NEQ, LT, LTE, GT, GTE,

    EOF;

    public boolean isKeyword() {
        return ordinal() <= BETWEEN.ordinal();
    }
}
