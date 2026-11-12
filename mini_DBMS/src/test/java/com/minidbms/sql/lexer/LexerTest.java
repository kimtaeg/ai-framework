package com.minidbms.sql.lexer;

import com.minidbms.common.ParseException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.List;

import static com.minidbms.sql.lexer.TokenType.*;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LexerTest {
    private static List<TokenType> types(String sql) {
        return Lexer.tokenize(sql).stream().map(Token::type).toList();
    }

    private static Token first(String sql) {
        return Lexer.tokenize(sql).get(0);
    }

    @Test
    void 키워드는_대소문자를_무시한다() {
        assertEquals(List.of(INSERT, INTO, VALUES, SELECT, FROM, WHERE, AND, BETWEEN, EXPLAIN, EOF),
                types("insert Into VALUES select FROM where And between Explain"));
        assertEquals("SELECT", first("select").text());
    }

    @Test
    void 식별자는_소문자로_정규화한다() {
        Token t = first("User_Name2");
        assertEquals(IDENT, t.type());
        assertEquals("user_name2", t.text());
    }

    @Test
    void 키워드를_포함한_식별자는_식별자다() {
        assertEquals(List.of(IDENT, IDENT, EOF), types("selected into_x"));
    }

    @Test
    void 기호를_인식한다() {
        assertEquals(List.of(COMMA, LPAREN, RPAREN, STAR, SEMICOLON, EQ, NEQ, NEQ, LT, LTE, GT, GTE, EOF),
                types(", ( ) * ; = != <> < <= > >="));
    }

    @Test
    void 붙어있는_연산자도_가장_긴_것을_고른다() {
        assertEquals(List.of(IDENT, GTE, NUMBER, EOF), types("id>=10"));
        assertEquals(List.of(IDENT, LT, NUMBER, EOF), types("id<-3"));
    }

    @Test
    void 정수와_음수를_인식한다() {
        List<Token> tokens = Lexer.tokenize("42 -5 0");
        assertEquals(new Token(NUMBER, "42", 0), tokens.get(0));
        assertEquals(new Token(NUMBER, "-5", 3), tokens.get(1));
        assertEquals(new Token(NUMBER, "0", 6), tokens.get(2));
    }

    @Test
    void 문자열은_따옴표를_벗기고_두_따옴표를_하나로_바꾼다() {
        assertEquals(new Token(STRING, "it's", 0), first("'it''s'"));
        assertEquals("", first("''").text());
        assertEquals("'", first("''''").text());
        assertEquals("a, b -- c", first("'a, b -- c'").text());
    }

    @Test
    void 주석은_줄_끝까지_무시한다() {
        assertEquals(List.of(SELECT, STAR, FROM, IDENT, EOF),
                types("-- 첫 줄 주석\nSELECT * -- 끝 주석\nFROM users -- 마지막 줄"));
    }

    @Test
    void 토큰에_원문_위치를_기록한다() {
        List<Token> tokens = Lexer.tokenize("SELECT name FROM t;");
        assertEquals(List.of(0, 7, 12, 17, 18, 19), tokens.stream().map(Token::position).toList());
    }

    @Test
    void 전체_문장을_토큰화한다() {
        assertEquals(List.of(INSERT, INTO, IDENT, VALUES, LPAREN, STRING, COMMA, NUMBER, RPAREN, SEMICOLON, EOF),
                types("INSERT INTO users VALUES ('kim', -1);"));
    }

    @Test
    void 빈_입력은_EOF만_돌려준다() {
        assertEquals(List.of(new Token(EOF, "", 3)), Lexer.tokenize("   "));
    }

    @Test
    void 닫히지_않은_문자열은_시작_위치를_알려준다() {
        ParseException e = assertThrows(ParseException.class, () -> Lexer.tokenize("SELECT 'abc"));
        assertTrue(e.getMessage().contains("닫히지 않았습니다"), e.getMessage());
        assertTrue(e.getMessage().contains("위치 7"), e.getMessage());
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "SELECT # FROM t | 7",
            "id ! 3          | 3",
            "x - 1           | 2",
            "12abc           | 0",
            "id = 3.5        | 6",
    })
    void 잘못된_문자는_위치를_포함한_ParseException(String sql, int position) {
        ParseException e = assertThrows(ParseException.class, () -> Lexer.tokenize(sql));
        assertTrue(e.getMessage().contains("위치 " + position), e.getMessage());
    }
}
