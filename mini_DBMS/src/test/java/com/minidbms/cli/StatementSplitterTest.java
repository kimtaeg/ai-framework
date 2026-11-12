package com.minidbms.cli;

import com.minidbms.cli.StatementSplitter.Piece;
import com.minidbms.cli.StatementSplitter.Split;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class StatementSplitterTest {
    @Test
    void 세미콜론으로_나누고_줄_번호를_기록한다() {
        Split split = StatementSplitter.split("SELECT 1;\n\n  INSERT x;\nSELECT 2");
        assertEquals(List.of(new Piece("SELECT 1", 1), new Piece("INSERT x", 3)), split.statements());
        assertEquals(new Piece("SELECT 2", 4), split.unfinished());
    }

    @Test
    void 문자열과_주석_안의_세미콜론은_경계가_아니다() {
        Split split = StatementSplitter.split("""
                -- 주석; 안의 세미콜론
                INSERT INTO t VALUES ('a;b', 'it''s;');
                SELECT 1 -- 끝 주석;
                ;""");
        assertEquals(List.of(
                new Piece("INSERT INTO t VALUES ('a;b', 'it''s;')", 2),
                new Piece("SELECT 1 -- 끝 주석;", 3)), split.statements());
        assertNull(split.unfinished());
    }

    @Test
    void 빈_문장과_주석만_있는_조각은_건너뛴다() {
        Split split = StatementSplitter.split(";; -- 주석만\n ;");
        assertEquals(List.of(), split.statements());
        assertNull(split.unfinished());
    }

    @Test
    void 닫히지_않은_문자열은_다음_줄로_이어진다() {
        Split split = StatementSplitter.split("INSERT INTO t VALUES ('a;\n");
        assertEquals(List.of(), split.statements());
        assertEquals("INSERT INTO t VALUES ('a;\n", split.remainder());
    }
}
