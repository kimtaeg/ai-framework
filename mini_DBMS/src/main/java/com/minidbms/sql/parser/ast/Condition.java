package com.minidbms.sql.parser.ast;

/** WHERE column operator value */
public record Condition(String column, Operator operator, Literal value) {
}
