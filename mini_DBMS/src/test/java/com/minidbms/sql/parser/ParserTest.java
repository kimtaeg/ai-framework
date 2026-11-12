package com.minidbms.sql.parser;

import com.minidbms.common.ParseException;
import com.minidbms.sql.parser.ast.Condition;
import com.minidbms.sql.parser.ast.ExplainStatement;
import com.minidbms.sql.parser.ast.InsertStatement;
import com.minidbms.sql.parser.ast.Literal;
import com.minidbms.sql.parser.ast.Operator;
import com.minidbms.sql.parser.ast.SelectStatement;
import com.minidbms.sql.parser.ast.Statement;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ParserTest {
    private static Statement parseOne(String sql) {
        List<Statement> statements = Parser.parseAll(sql);
        assertEquals(1, statements.size());
        return statements.get(0);
    }

    private static String errorOf(String sql) {
        return assertThrows(ParseException.class, () -> Parser.parseAll(sql)).getMessage();
    }

    @Test
    void 컬럼을_지정한_INSERT() {
        assertEquals(new InsertStatement("users", List.of("name", "age"), List.of(Literal.of("kim"), Literal.of(-3))),
                parseOne("INSERT INTO Users (Name, age) VALUES ('kim', -3);"));
    }

    @Test
    void 컬럼을_생략한_INSERT는_빈_컬럼_목록() {
        InsertStatement insert = (InsertStatement) parseOne("insert into users values ('lee', 20, NULL)");
        assertEquals(List.of(), insert.columns());
        assertEquals(List.of(Literal.of("lee"), Literal.of(20), Literal.NULL), insert.values());
    }

    @Test
    void SELECT_별표() {
        SelectStatement select = (SelectStatement) parseOne("SELECT * FROM users");
        assertEquals(new SelectStatement("users", List.of(), Optional.empty()), select);
        assertTrue(select.selectsAll());
    }

    @Test
    void SELECT_컬럼_목록과_WHERE() {
        assertEquals(new SelectStatement("users", List.of("id", "name"),
                        Optional.of(new Condition("id", Operator.GTE, Literal.of(10)))),
                parseOne("SELECT id, name FROM users WHERE id >= 10;"));
    }

    @ParameterizedTest
    @CsvSource({"=, EQ", "!=, NEQ", "<>, NEQ", "<, LT", "<=, LTE", ">, GT", ">=, GTE"})
    void WHERE_비교_연산자(String symbol, Operator expected) {
        SelectStatement select = (SelectStatement) parseOne("SELECT * FROM t WHERE name " + symbol + " 'a'");
        assertEquals(new Condition("name", expected, Literal.of("a")), select.where().orElseThrow());
    }

    @Test
    void 여러_문장을_순서대로_파싱한다() {
        List<Statement> statements = Parser.parseAll("""
                INSERT INTO t VALUES (1);
                -- 주석
                SELECT * FROM t;
                SELECT a FROM t WHERE a = 1""");
        assertEquals(3, statements.size());
        assertTrue(statements.get(0) instanceof InsertStatement);
        assertTrue(statements.get(1) instanceof SelectStatement);
        assertTrue(statements.get(2) instanceof SelectStatement);
    }

    @Test
    void 빈_입력은_빈_목록() {
        assertEquals(List.of(), Parser.parseAll("  -- 주석만\n"));
    }

    @Test
    void 키워드_오타는_기대한_것과_실제_토큰과_위치를_알려준다() {
        assertEquals("Expected FROM but found 'form' at 9", errorOf("SELECT * FORM users"));
    }

    @Test
    void 빠진_닫는_괄호() {
        assertEquals("Expected ')' but found end of input at 28", errorOf("INSERT INTO t VALUES (1, 'a'"));
        assertEquals("Expected ')' but found 'VALUES' at 17", errorOf("INSERT INTO t (a values (1)"));
    }

    @Test
    void 빠진_여는_괄호() {
        assertEquals("Expected '(' but found '1' at 21", errorOf("INSERT INTO t VALUES 1)"));
    }

    @Test
    void VALUES가_비어있으면_오류() {
        assertEquals("Expected value (number, 'string' or NULL) but found ')' at 22",
                errorOf("INSERT INTO t VALUES ()"));
    }

    @Test
    void 컬럼_수와_값_수가_다르면_오류() {
        assertTrue(errorOf("INSERT INTO t (a, b) VALUES (1)").contains("Column count 2 does not match value count 1"));
    }

    @Test
    void 알_수_없는_문장() {
        assertEquals("Expected INSERT, SELECT or EXPLAIN but found 'delete' at 0", errorOf("DELETE FROM users"));
    }

    @Test
    void 문장_사이에_세미콜론이_없으면_오류() {
        assertEquals("Expected ';' or end of input but found 'SELECT' at 16", errorOf("SELECT * FROM t SELECT * FROM u"));
    }

    @Test
    void 연속된_세미콜론은_빈_문장이라_오류() {
        assertEquals("Expected INSERT, SELECT or EXPLAIN but found ';' at 16", errorOf("SELECT * FROM t;;"));
    }

    @Test
    void 범위를_넘는_숫자는_오류() {
        assertTrue(errorOf("INSERT INTO t VALUES (9223372036854775808)").contains("out of range"));
    }

    @Test
    void 비교_연산자가_없으면_오류() {
        assertEquals("Expected comparison operator (=, !=, <, <=, >, >=) or BETWEEN but found '5' at 25",
                errorOf("SELECT * FROM t WHERE id 5"));
    }

    @Test
    void 렉서_오류는_ParseException으로_그대로_전달된다() {
        assertThrows(ParseException.class, () -> Parser.parseAll("SELECT * FROM t WHERE name = 'abc"));
    }

    // ---- BETWEEN · EXPLAIN ----

    @Test
    void BETWEEN은_하한과_상한을_가진다() {
        SelectStatement select = (SelectStatement) parseOne("SELECT * FROM t WHERE id BETWEEN -3 AND 10");
        assertEquals(Condition.between("id", Literal.of(-3), Literal.of(10)), select.where().orElseThrow());
        assertEquals("id BETWEEN -3 AND 10", select.where().orElseThrow().toString());
    }

    @Test
    void BETWEEN에_AND가_없으면_오류() {
        assertEquals("Expected AND but found '10' at 35", errorOf("SELECT * FROM t WHERE id BETWEEN 1 10"));
    }

    @Test
    void EXPLAIN은_SELECT를_감싼다() {
        Statement statement = parseOne("explain SELECT name FROM users WHERE id = 1");
        assertEquals(new ExplainStatement(new SelectStatement("users", List.of("name"),
                Optional.of(new Condition("id", Operator.EQ, Literal.of(1))))), statement);
        assertEquals("users", statement.table());
    }

    @Test
    void EXPLAIN_뒤에는_SELECT만_올_수_있다() {
        assertEquals("Expected SELECT after EXPLAIN but found 'INSERT' at 8", errorOf("EXPLAIN INSERT INTO t VALUES (1)"));
    }

    @Test
    void BETWEEN이_아닌_조건에_상한을_주면_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> new Condition("id", Operator.EQ, Literal.of(1), Literal.of(2)));
        assertThrows(IllegalArgumentException.class, () -> new Condition("id", Operator.BETWEEN, Literal.of(1)));
    }

    // ---- LIMIT ----

    @Test
    void LIMIT은_WHERE_뒤에_온다() {
        SelectStatement select = (SelectStatement) parseOne("SELECT * FROM t WHERE id > 3 LIMIT 10");
        assertEquals(java.util.OptionalLong.of(10), select.limit());
        assertEquals(java.util.OptionalLong.of(0), ((SelectStatement) parseOne("select * from t limit 0")).limit());
        assertEquals(java.util.OptionalLong.empty(), ((SelectStatement) parseOne("SELECT * FROM t")).limit());
    }

    @Test
    void LIMIT_오류() {
        assertEquals("Expected row count after LIMIT but found end of input at 21", errorOf("SELECT * FROM t LIMIT"));
        assertEquals("Expected row count after LIMIT but found 'ten' at 22", errorOf("SELECT * FROM t LIMIT ten"));
        assertEquals("LIMIT must be 0 or greater but found -1 at 22", errorOf("SELECT * FROM t LIMIT -1"));
        assertEquals("Expected ';' or end of input but found 'WHERE' at 24", errorOf("SELECT * FROM t LIMIT 1 WHERE id = 1"));
    }
}
