package com.minidbms.sql.parser.ast;

import java.util.List;

/**
 * @param columns 비어 있으면 컬럼 목록을 생략한 INSERT (스키마 순서대로 값을 넣는다)
 */
public record InsertStatement(String table, List<String> columns, List<Literal> values) implements Statement {
    public InsertStatement {
        columns = List.copyOf(columns);
        values = List.copyOf(values);
    }
}
