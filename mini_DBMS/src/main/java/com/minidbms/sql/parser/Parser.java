package com.minidbms.sql.parser;

import com.minidbms.common.ParseException;
import com.minidbms.sql.lexer.Lexer;
import com.minidbms.sql.lexer.Token;
import com.minidbms.sql.lexer.TokenType;
import com.minidbms.sql.parser.ast.Condition;
import com.minidbms.sql.parser.ast.InsertStatement;
import com.minidbms.sql.parser.ast.Literal;
import com.minidbms.sql.parser.ast.Operator;
import com.minidbms.sql.parser.ast.SelectStatement;
import com.minidbms.sql.parser.ast.Statement;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 재귀 하강 파서. 문법 규칙 하나가 메서드 하나에 대응하고, 각 메서드는 자기 규칙만큼 토큰을 소비한다.
 *
 * <pre>
 * script    := statement (';' statement)* ';'? EOF
 * statement := insert | select
 * insert    := INSERT INTO ident ('(' identList ')')? VALUES '(' literal (',' literal)* ')'
 * select    := SELECT ('*' | identList) FROM ident (WHERE condition)?
 * condition := ident compareOp literal
 * literal   := NUMBER | STRING | NULL
 * </pre>
 *
 * 스키마(테이블·컬럼 존재, 타입)는 보지 않는다. 그건 Executor의 책임이다.
 */
public final class Parser {
    private final List<Token> tokens;
    private int current;

    private Parser(List<Token> tokens) {
        this.tokens = tokens;
    }

    public static List<Statement> parseAll(String sql) {
        return new Parser(Lexer.tokenize(sql)).script();
    }

    private List<Statement> script() {
        List<Statement> statements = new ArrayList<>();
        while (!check(TokenType.EOF)) {
            statements.add(statement());
            // 문장 뒤에는 ';' 또는 입력의 끝만 올 수 있다. 마지막 ';'은 생략해도 된다.
            if (!match(TokenType.SEMICOLON)) {
                expect(TokenType.EOF, "';' or end of input");
            }
        }
        return statements;
    }

    private Statement statement() {
        if (check(TokenType.INSERT)) {
            return insert();
        }
        if (check(TokenType.SELECT)) {
            return select();
        }
        throw error("INSERT or SELECT");
    }

    private InsertStatement insert() {
        expect(TokenType.INSERT, "INSERT");
        expect(TokenType.INTO, "INTO");
        String table = identifier("table name");

        List<String> columns = List.of();
        if (match(TokenType.LPAREN)) {
            columns = identList("column name");
            expect(TokenType.RPAREN, "')'");
        }

        expect(TokenType.VALUES, "VALUES");
        Token valuesStart = expect(TokenType.LPAREN, "'('");
        List<Literal> values = new ArrayList<>();
        do {
            values.add(literal());
        } while (match(TokenType.COMMA));
        expect(TokenType.RPAREN, "')'");

        // 스키마 없이도 문장 안에서 모순인 것은 여기서 잡는다. 컬럼 수와 값 수가 다르면 어느 값이 어느 컬럼인지 정할 수 없다.
        if (!columns.isEmpty() && columns.size() != values.size()) {
            throw new ParseException("Column count " + columns.size() + " does not match value count "
                    + values.size() + " at " + valuesStart.position());
        }
        return new InsertStatement(table, columns, values);
    }

    private SelectStatement select() {
        expect(TokenType.SELECT, "SELECT");
        List<String> columns = match(TokenType.STAR) ? List.of() : identList("column name or '*'");
        expect(TokenType.FROM, "FROM");
        String table = identifier("table name");

        Optional<Condition> where = Optional.empty();
        if (match(TokenType.WHERE)) {
            where = Optional.of(condition());
        }
        return new SelectStatement(table, columns, where);
    }

    private Condition condition() {
        String column = identifier("column name");
        Operator operator = switch (peek().type()) {
            case EQ -> Operator.EQ;
            case NEQ -> Operator.NEQ;
            case LT -> Operator.LT;
            case LTE -> Operator.LTE;
            case GT -> Operator.GT;
            case GTE -> Operator.GTE;
            default -> throw error("comparison operator (=, !=, <, <=, >, >=)");
        };
        advance();
        return new Condition(column, operator, literal());
    }

    private List<String> identList(String what) {
        List<String> names = new ArrayList<>();
        do {
            names.add(identifier(what));
        } while (match(TokenType.COMMA));
        return names;
    }

    private String identifier(String what) {
        return expect(TokenType.IDENT, what).text();
    }

    private Literal literal() {
        Token token = peek();
        switch (token.type()) {
            case NUMBER -> {
                advance();
                try {
                    return Literal.of(Long.parseLong(token.text()));
                } catch (NumberFormatException e) {
                    throw new ParseException("Number '" + token.text() + "' is out of range (64-bit integer) at "
                            + token.position());
                }
            }
            case STRING -> {
                advance();
                return Literal.of(token.text());
            }
            case IDENT -> {
                // NULL은 Lexer 키워드에 없으므로 값 자리에 온 식별자 "null"을 NULL 값으로 읽는다.
                if (token.text().equals("null")) {
                    advance();
                    return Literal.NULL;
                }
                throw error("value (number, 'string' or NULL)");
            }
            default -> throw error("value (number, 'string' or NULL)");
        }
    }

    // ---- 토큰 커서 ----

    private Token peek() {
        return tokens.get(current);
    }

    private boolean check(TokenType type) {
        return peek().type() == type;
    }

    private Token advance() {
        Token token = peek();
        // EOF에서는 멈춰 있어야 이후 peek()가 범위를 벗어나지 않는다.
        if (token.type() != TokenType.EOF) {
            current++;
        }
        return token;
    }

    private boolean match(TokenType type) {
        if (check(type)) {
            advance();
            return true;
        }
        return false;
    }

    private Token expect(TokenType type, String expected) {
        if (!check(type)) {
            throw error(expected);
        }
        return advance();
    }

    private ParseException error(String expected) {
        Token found = peek();
        String actual = found.type() == TokenType.EOF ? "end of input" : "'" + found.text() + "'";
        return new ParseException("Expected " + expected + " but found " + actual + " at " + found.position());
    }
}
