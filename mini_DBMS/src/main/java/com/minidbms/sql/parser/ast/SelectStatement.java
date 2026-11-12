package com.minidbms.sql.parser.ast;

import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;

/**
 * @param columns 비어 있으면 SELECT *
 * @param limit   LIMIT n (0 이상). 없으면 empty
 */
public record SelectStatement(String table, List<String> columns, Optional<Condition> where, OptionalLong limit)
        implements Statement {
    public SelectStatement {
        columns = List.copyOf(columns);
        if (limit.isPresent() && limit.getAsLong() < 0) {
            throw new IllegalArgumentException("LIMIT은 0 이상이어야 합니다: " + limit.getAsLong());
        }
    }

    /** LIMIT 없는 SELECT */
    public SelectStatement(String table, List<String> columns, Optional<Condition> where) {
        this(table, columns, where, OptionalLong.empty());
    }

    public boolean selectsAll() {
        return columns.isEmpty();
    }
}
