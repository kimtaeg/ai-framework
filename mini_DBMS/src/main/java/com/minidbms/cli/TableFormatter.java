package com.minidbms.cli;

import java.util.ArrayList;
import java.util.List;

/**
 * MySQL 클라이언트처럼 테두리 있는 표를 만든다.
 *
 * <pre>
 * +----+------+
 * | id | name |
 * +----+------+
 * |  1 | kim  |
 * +----+------+
 * </pre>
 *
 * 숫자는 오른쪽, 나머지는 왼쪽 정렬. 한글처럼 터미널에서 두 칸을 차지하는 글자는 폭 2로 계산한다.
 */
public final class TableFormatter {
    private TableFormatter() {
    }

    public static String format(List<String> columns, List<List<Object>> rows) {
        List<String[]> cells = new ArrayList<>(rows.size());
        int[] widths = new int[columns.size()];
        for (int c = 0; c < columns.size(); c++) {
            widths[c] = displayWidth(columns.get(c));
        }
        for (List<Object> row : rows) {
            String[] texts = new String[columns.size()];
            for (int c = 0; c < texts.length; c++) {
                texts[c] = cellText(row.get(c));
                widths[c] = Math.max(widths[c], displayWidth(texts[c]));
            }
            cells.add(texts);
        }

        String border = border(widths);
        StringBuilder out = new StringBuilder();
        out.append(border);
        appendRow(out, columns.toArray(String[]::new), widths, null);
        out.append(border);
        for (int r = 0; r < rows.size(); r++) {
            appendRow(out, cells.get(r), widths, rows.get(r));
        }
        if (!rows.isEmpty()) {
            out.append(border);
        }
        return out.toString();
    }

    private static String border(int[] widths) {
        StringBuilder line = new StringBuilder("+");
        for (int w : widths) {
            line.append("-".repeat(w + 2)).append('+');
        }
        return line.append('\n').toString();
    }

    /** @param values 원래 값(정렬 판단용). 헤더면 null */
    private static void appendRow(StringBuilder out, String[] texts, int[] widths, List<Object> values) {
        out.append('|');
        for (int c = 0; c < texts.length; c++) {
            String pad = " ".repeat(widths[c] - displayWidth(texts[c]));
            boolean rightAlign = values != null && values.get(c) instanceof Long;
            out.append(' ').append(rightAlign ? pad + texts[c] : texts[c] + pad).append(" |");
        }
        out.append('\n');
    }

    static String cellText(Object value) {
        if (value == null) {
            return "NULL";
        }
        // 값 안의 줄바꿈·탭이 그대로 찍히면 표가 깨지므로 보이는 문자로 바꾼다.
        return value.toString().replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    static int displayWidth(String s) {
        int width = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            width += isWide(cp) ? 2 : 1;
            i += Character.charCount(cp);
        }
        return width;
    }

    /** 동아시아 전각 문자와 이모지. 터미널이 두 칸으로 그린다. */
    private static boolean isWide(int cp) {
        return (cp >= 0x1100 && cp <= 0x115F)      // 한글 자모
                || (cp >= 0x2E80 && cp <= 0xA4CF)  // CJK 부수·한자·가나·한글 호환 자모
                || (cp >= 0xAC00 && cp <= 0xD7A3)  // 한글 음절
                || (cp >= 0xF900 && cp <= 0xFAFF)  // CJK 호환 한자
                || (cp >= 0xFE30 && cp <= 0xFE4F)
                || (cp >= 0xFF00 && cp <= 0xFF60)  // 전각 기호
                || (cp >= 0xFFE0 && cp <= 0xFFE6)
                || (cp >= 0x1F300 && cp <= 0x1FAFF) // 이모지
                || (cp >= 0x20000 && cp <= 0x3FFFD);
    }
}
