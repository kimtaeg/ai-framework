package com.minidbms.sql.parser.ast;

import java.util.List;
import java.util.Optional;

/**
 * @param columns 비어 있으면 SELECT *
 */
public record SelectStatement(String table, List<String> columns, Optional<Condition> where) implements Statement {
    public SelectStatement {
        columns = List.copyOf(columns);
    }

    public boolean selectsAll() {
        return columns.isEmpty();
    }
}
