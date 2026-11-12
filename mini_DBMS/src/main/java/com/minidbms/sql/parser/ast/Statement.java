package com.minidbms.sql.parser.ast;

/**
 * 파싱된 SQL 문장. sealed로 닫아두면 Executor의 switch가 모든 문장 종류를 다뤘는지 컴파일러가 확인해준다.
 */
public sealed interface Statement permits InsertStatement, SelectStatement, ExplainStatement {
    String table();
}
