package com.minidbms.sql.parser.ast;

/**
 * EXPLAIN SELECT ... : 실행하지 않고 선택될 실행 경로만 보여준다.
 */
public record ExplainStatement(SelectStatement select) implements Statement {
    @Override
    public String table() {
        return select.table();
    }
}
