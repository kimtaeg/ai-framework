package com.minidbms.sql.lexer;

/**
 * @param text     키워드는 대문자, IDENT는 소문자, STRING은 따옴표를 벗기고 '' 를 풀어낸 값, NUMBER는 부호를 포함한 숫자 그대로
 * @param position 토큰이 시작하는 원문 위치(0부터 센 문자 오프셋). 파서가 오류 위치를 알릴 때 쓴다.
 */
public record Token(TokenType type, String text, int position) {
    @Override
    public String toString() {
        return type + "('" + text + "')@" + position;
    }
}
