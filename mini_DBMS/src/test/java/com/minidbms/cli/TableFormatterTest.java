package com.minidbms.cli;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TableFormatterTest {
    private static List<Object> row(Object... values) {
        return Arrays.asList(values);
    }

    @Test
    void 테두리_있는_표를_만든다_숫자는_오른쪽_문자열은_왼쪽_정렬() {
        String table = TableFormatter.format(List.of("id", "name"),
                List.of(row(1L, "kim"), row(10L, "a")));
        assertEquals("""
                +----+------+
                | id | name |
                +----+------+
                |  1 | kim  |
                | 10 | a    |
                +----+------+
                """, table);
    }

    @Test
    void NULL은_NULL로_표시하고_폭에_반영한다() {
        assertEquals("""
                +----+------+
                | id | age  |
                +----+------+
                |  1 | NULL |
                +----+------+
                """, TableFormatter.format(List.of("id", "age"), List.of(row(1L, null))));
    }

    @Test
    void 한글은_두_칸으로_계산해서_세로선이_맞는다() {
        assertEquals("""
                +--------+
                | name   |
                +--------+
                | 김정글 |
                | ab     |
                +--------+
                """, TableFormatter.format(List.of("name"), List.of(row("김정글"), row("ab"))));
    }

    @Test
    void 결과가_없으면_헤더만_그린다() {
        assertEquals("""
                +----+
                | id |
                +----+
                """, TableFormatter.format(List.of("id"), List.of()));
    }

    @Test
    void 값_안의_줄바꿈과_탭은_보이는_문자로_바꾼다() {
        assertEquals("a\\nb\\tc", TableFormatter.cellText("a\nb\tc"));
    }

    @Test
    void 표시_폭_계산() {
        assertEquals(3, TableFormatter.displayWidth("abc"));
        assertEquals(4, TableFormatter.displayWidth("한글"));
        assertEquals(2, TableFormatter.displayWidth("😀"));
    }
}
