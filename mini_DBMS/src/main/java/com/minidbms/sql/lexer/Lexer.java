package com.minidbms.sql.lexer;

import com.minidbms.common.ParseException;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * SQL 문자열을 토큰 목록으로 쪼갠다. 첫 글자만 보면 토큰 종류가 정해지는 문법이라
 * 정규식 없이 커서 하나로 한 글자씩 읽는다.
 */
public final class Lexer {
    private static final Map<String, TokenType> KEYWORDS = Map.of(
            "INSERT", TokenType.INSERT,
            "INTO", TokenType.INTO,
            "VALUES", TokenType.VALUES,
            "SELECT", TokenType.SELECT,
            "FROM", TokenType.FROM,
            "WHERE", TokenType.WHERE,
            "AND", TokenType.AND,
            "BETWEEN", TokenType.BETWEEN,
            "EXPLAIN", TokenType.EXPLAIN,
            "LIMIT", TokenType.LIMIT);

    private final String sql;
    private int pos;

    public Lexer(String sql) {
        this.sql = sql;
    }

    /** 키워드(대소문자 무시)면 true. 키워드는 식별자로 쓸 수 없으므로 스키마 검증에 쓴다. */
    public static boolean isKeyword(String word) {
        return KEYWORDS.containsKey(word.toUpperCase(Locale.ROOT));
    }

    public static List<Token> tokenize(String sql) {
        return new Lexer(sql).tokenize();
    }

    public List<Token> tokenize() {
        List<Token> tokens = new ArrayList<>();
        while (true) {
            skipWhitespaceAndComments();
            if (pos >= sql.length()) {
                // 파서가 "끝"을 일반 토큰처럼 비교할 수 있도록 EOF를 항상 붙인다.
                tokens.add(new Token(TokenType.EOF, "", pos));
                return tokens;
            }
            tokens.add(nextToken());
        }
    }

    private void skipWhitespaceAndComments() {
        while (pos < sql.length()) {
            char c = sql.charAt(pos);
            if (Character.isWhitespace(c)) {
                pos++;
            } else if (c == '-' && peek(1) == '-') {
                // -- 주석: 줄바꿈 직전까지 건너뛴다. 줄바꿈 자체는 다음 반복에서 공백으로 처리된다.
                while (pos < sql.length() && sql.charAt(pos) != '\n') {
                    pos++;
                }
            } else {
                return;
            }
        }
    }

    private Token nextToken() {
        int start = pos;
        char c = sql.charAt(pos);

        if (isIdentStart(c)) {
            return identOrKeyword(start);
        }
        // '-' 다음이 숫자일 때만 음수다. "--"는 이미 주석으로 처리됐으므로 여기 오지 않는다.
        if (isDigit(c) || (c == '-' && isDigit(peek(1)))) {
            return number(start);
        }
        if (c == '\'') {
            return string(start);
        }
        return symbol(start, c);
    }

    private Token identOrKeyword(int start) {
        while (pos < sql.length() && isIdentPart(sql.charAt(pos))) {
            pos++;
        }
        String word = sql.substring(start, pos);
        TokenType keyword = KEYWORDS.get(word.toUpperCase(Locale.ROOT));
        if (keyword != null) {
            return new Token(keyword, keyword.name(), start);
        }
        return new Token(TokenType.IDENT, word.toLowerCase(Locale.ROOT), start);
    }

    private Token number(int start) {
        pos++; // 첫 글자(숫자 또는 '-')
        while (pos < sql.length() && isDigit(sql.charAt(pos))) {
            pos++;
        }
        // "12abc"를 NUMBER(12) + IDENT(abc)로 나누면 파서에서 엉뚱한 오류가 나므로 여기서 막는다.
        if (pos < sql.length() && isIdentPart(sql.charAt(pos))) {
            throw error(start, "잘못된 숫자 '" + sql.substring(start, pos + 1) + "'");
        }
        return new Token(TokenType.NUMBER, sql.substring(start, pos), start);
    }

    private Token string(int start) {
        StringBuilder value = new StringBuilder();
        pos++; // 여는 따옴표
        while (pos < sql.length()) {
            char c = sql.charAt(pos);
            if (c == '\'') {
                // 따옴표가 두 개 연달아 오면 값 안의 작은따옴표 하나, 하나면 문자열의 끝이다.
                if (peek(1) == '\'') {
                    value.append('\'');
                    pos += 2;
                    continue;
                }
                pos++;
                return new Token(TokenType.STRING, value.toString(), start);
            }
            value.append(c);
            pos++;
        }
        throw error(start, "문자열이 닫히지 않았습니다 (작은따옴표 ' 가 필요합니다)");
    }

    private Token symbol(int start, char c) {
        TokenType type = switch (c) {
            case ',' -> TokenType.COMMA;
            case '(' -> TokenType.LPAREN;
            case ')' -> TokenType.RPAREN;
            case '*' -> TokenType.STAR;
            case ';' -> TokenType.SEMICOLON;
            case '=' -> TokenType.EQ;
            // 두 글자 연산자는 다음 글자를 미리 봐서(peek) 가장 긴 쪽을 고른다.
            case '<' -> peek(1) == '=' ? TokenType.LTE : peek(1) == '>' ? TokenType.NEQ : TokenType.LT;
            case '>' -> peek(1) == '=' ? TokenType.GTE : TokenType.GT;
            case '!' -> {
                if (peek(1) != '=') {
                    throw error(start, "'!' 다음에는 '='가 와야 합니다 (!=)");
                }
                yield TokenType.NEQ;
            }
            default -> throw error(start, "알 수 없는 문자 '" + c + "'");
        };
        int length = switch (type) {
            case LTE, GTE, NEQ -> 2;
            default -> 1;
        };
        pos += length;
        return new Token(type, sql.substring(start, pos), start);
    }

    /** 범위를 벗어나면 '\0'을 돌려줘서 호출부의 경계 검사를 줄인다. */
    private char peek(int offset) {
        int i = pos + offset;
        return i < sql.length() ? sql.charAt(i) : '\0';
    }

    private ParseException error(int at, String message) {
        return new ParseException(message + " (위치 " + at + ")\n" + sql + "\n" + " ".repeat(at) + "^");
    }

    private static boolean isIdentStart(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    }

    private static boolean isIdentPart(char c) {
        return isIdentStart(c) || isDigit(c);
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }
}
