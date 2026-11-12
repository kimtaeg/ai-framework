package com.minidbms.storage;

import com.minidbms.common.StorageException;

import java.util.ArrayList;
import java.util.List;

/**
 * 레코드(Object[]) ↔ .tbl 파일의 한 줄.
 *
 * <pre>
 * 구분자 |      이스케이프  \\ → \   \| → |   \n → 줄바꿈   \r → CR
 * NULL은 필드 전체가 \N 일 때만. 문자열 "\N"은 \\N 으로 쓰이므로 NULL과 겹치지 않는다.
 * </pre>
 *
 * 줄바꿈뿐 아니라 CR도 이스케이프한다. 원본 CR이 남으면 줄 단위로 읽을 때 레코드가 둘로 쪼개질 수 있기 때문이다.
 */
public final class RecordCodec {
    static final char DELIMITER = '|';
    static final char ESCAPE = '\\';
    static final String NULL_FIELD = "\\N";

    private RecordCodec() {
    }

    /** values의 원소는 Long, String, null만 허용한다. */
    public static String encode(Object[] values) {
        StringBuilder line = new StringBuilder();
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                line.append(DELIMITER);
            }
            Object value = values[i];
            if (value == null) {
                line.append(NULL_FIELD);
            } else if (value instanceof Long n) {
                line.append(n);
            } else if (value instanceof String s) {
                appendEscaped(line, s);
            } else {
                throw new StorageException("저장할 수 없는 값 타입: " + value.getClass().getSimpleName()
                        + " (Long, String, null만 가능)");
            }
        }
        return line.toString();
    }

    private static void appendEscaped(StringBuilder out, String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case ESCAPE -> out.append("\\\\");
                case DELIMITER -> out.append("\\|");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                default -> out.append(c);
            }
        }
    }

    /** 스키마 타입에 맞춰 INT는 Long, STRING은 String으로 되돌린다. */
    public static Object[] decode(String line, Schema schema) {
        List<String> fields = split(line);
        if (fields.size() != schema.size()) {
            throw new StorageException("테이블 '" + schema.tableName() + "' 레코드의 필드 수가 " + fields.size()
                    + "개입니다 (스키마는 " + schema.size() + "개): " + line);
        }
        Object[] values = new Object[fields.size()];
        for (int i = 0; i < values.length; i++) {
            values[i] = toValue(fields.get(i), schema.column(i), line);
        }
        return values;
    }

    /**
     * 이스케이프를 풀면서 필드를 나눈다. 이스케이프를 먼저 풀면 \| 가 구분자와 구별되지 않으므로 한 번의 순회에서 같이 처리한다.
     * NULL 필드는 null 원소로 돌려준다.
     */
    static List<String> split(String line) {
        List<String> fields = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean isNull = false;
        int i = 0;
        while (i <= line.length()) {
            if (i == line.length() || line.charAt(i) == DELIMITER) {
                fields.add(isNull ? null : field.toString());
                field.setLength(0);
                isNull = false;
                i++;
                continue;
            }
            char c = line.charAt(i);
            if (c != ESCAPE) {
                if (isNull) {
                    throw corrupted(line, i, "\\N 뒤에 다른 문자가 올 수 없습니다");
                }
                field.append(c);
                i++;
                continue;
            }
            if (i + 1 >= line.length()) {
                throw corrupted(line, i, "줄이 이스케이프 문자 '\\'로 끝났습니다");
            }
            char next = line.charAt(i + 1);
            if (next == 'N') {
                // \N은 필드 전체일 때만 NULL이다. "a\N" 같은 조합은 인코더가 만들지 않는 깨진 데이터다.
                if (field.length() > 0 || isNull) {
                    throw corrupted(line, i, "\\N은 필드 전체로만 쓸 수 있습니다");
                }
                isNull = true;
            } else {
                if (isNull) {
                    throw corrupted(line, i, "\\N 뒤에 다른 문자가 올 수 없습니다");
                }
                field.append(switch (next) {
                    case '\\' -> '\\';
                    case '|' -> '|';
                    case 'n' -> '\n';
                    case 'r' -> '\r';
                    default -> throw corrupted(line, i, "알 수 없는 이스케이프 '\\" + next + "'");
                });
            }
            i += 2;
        }
        return fields;
    }

    private static Object toValue(String field, Column column, String line) {
        if (field == null) {
            return null;
        }
        if (column.type() == ColumnType.STRING) {
            return field;
        }
        try {
            return Long.parseLong(field);
        } catch (NumberFormatException e) {
            throw new StorageException("INT 컬럼 '" + column.name() + "'에 숫자가 아닌 값 '" + field
                    + "'이(가) 저장되어 있습니다: " + line);
        }
    }

    private static StorageException corrupted(String line, int at, String reason) {
        return new StorageException("레코드 형식이 깨졌습니다 (위치 " + at + "): " + reason + ": " + line);
    }
}
