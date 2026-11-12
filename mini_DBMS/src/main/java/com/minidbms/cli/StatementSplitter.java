package com.minidbms.cli;

import java.util.ArrayList;
import java.util.List;

/**
 * SQL 텍스트를 문장 단위로 자른다. 문자열('a;b')과 주석(-- a;b) 안의 세미콜론은 경계로 보지 않는다.
 *
 * <p>엔진은 여러 문장을 한꺼번에 파싱해서 문법 오류 하나에 전체가 멈춘다. CLI는 "한 문장이 실패해도 다음 문장을 계속"
 * 해야 하므로 토큰화 전에 먼저 문장을 나눠서 하나씩 엔진에 넘긴다. Lexer를 쓰지 않는 이유는, 알 수 없는 문자가 있는
 * 문장도 일단 잘라낸 다음 그 문장만 실패시켜야 하기 때문이다.
 */
final class StatementSplitter {
    /** @param line 문장의 첫 글자가 있는 줄 번호(1부터) */
    record Piece(String sql, int line) {
    }

    /**
     * @param statements 세미콜론으로 끝난 문장들
     * @param unfinished 마지막 세미콜론 뒤에 남은 문장(주석·공백뿐이면 null)
     * @param remainder  마지막 세미콜론 뒤의 원문 그대로. REPL이 다음 줄과 이어 붙일 때 쓴다.
     */
    record Split(List<Piece> statements, Piece unfinished, String remainder) {
    }

    private StatementSplitter() {
    }

    static Split split(String text) {
        List<Piece> statements = new ArrayList<>();
        int start = -1;        // 현재 문장의 첫 의미 있는 글자 위치. -1이면 아직 공백·주석만 나왔다.
        int startLine = 0;
        int segmentStart = 0;  // 마지막 세미콜론 다음 위치
        int line = 1;
        boolean inString = false;

        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                line++;
            }
            if (inString) {
                if (c == '\'') {
                    if (i + 1 < text.length() && text.charAt(i + 1) == '\'') {
                        i++; // '' 는 문자열 안의 따옴표이므로 문자열이 끝난 게 아니다.
                    } else {
                        inString = false;
                    }
                }
                continue;
            }
            if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                // 주석은 줄바꿈 직전까지 건너뛴다. 줄바꿈은 다음 반복에서 줄 번호로 센다.
                while (i + 1 < text.length() && text.charAt(i + 1) != '\n') {
                    i++;
                }
                continue;
            }
            if (c == ';') {
                if (start >= 0) {
                    statements.add(new Piece(text.substring(start, i).strip(), startLine));
                }
                start = -1;
                segmentStart = i + 1;
                continue;
            }
            if (!Character.isWhitespace(c) && start < 0) {
                start = i;
                startLine = line;
            }
            if (c == '\'') {
                inString = true;
            }
        }

        Piece unfinished = start >= 0 ? new Piece(text.substring(start).strip(), startLine) : null;
        return new Split(statements, unfinished, text.substring(segmentStart));
    }
}
