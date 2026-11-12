package com.minidbms.storage;

import com.minidbms.common.StorageException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RecordCodecTest {
    private final Schema schema = new Schema("t", List.of(
            new Column("id", ColumnType.INT), new Column("name", ColumnType.STRING), new Column("memo", ColumnType.STRING)));

    private Object[] roundTrip(Object... values) {
        return RecordCodec.decode(RecordCodec.encode(values), schema);
    }

    @Test
    void 기본_인코딩_형식() {
        assertEquals("1|kim|hello", RecordCodec.encode(new Object[]{1L, "kim", "hello"}));
        assertEquals("-7|\\N|", RecordCodec.encode(new Object[]{-7L, null, ""}));
    }

    @Test
    void 특수문자를_이스케이프한다() {
        assertEquals("1|a\\|b|c\\\\d\\ne\\rf", RecordCodec.encode(new Object[]{1L, "a|b", "c\\d\ne\rf"}));
    }

    @ParameterizedTest
    @ValueSource(strings = {"a|b", "back\\slash", "line\nbreak", "cr\r\nlf", "\\N", "\\", "|", "||\\|", "", "끝\\"})
    void 특수문자_문자열이_왕복된다(String s) {
        assertArrayEquals(new Object[]{1L, s, s}, roundTrip(1L, s, s));
    }

    @Test
    void NULL과_빈_문자열과_문자열_N은_구별된다() {
        assertArrayEquals(new Object[]{2L, null, ""}, roundTrip(2L, null, ""));
        assertArrayEquals(new Object[]{2L, "\\N", null}, roundTrip(2L, "\\N", null));
        assertArrayEquals(new Object[]{null, null, null}, roundTrip(null, null, null));
    }

    @Test
    void 한글과_이모지가_왕복된다() {
        assertArrayEquals(new Object[]{3L, "김정글", "안녕 | 세상\n😀"}, roundTrip(3L, "김정글", "안녕 | 세상\n😀"));
    }

    @Test
    void 정수_경계값이_왕복된다() {
        assertArrayEquals(new Object[]{Long.MIN_VALUE, "a", "b"}, roundTrip(Long.MIN_VALUE, "a", "b"));
        assertArrayEquals(new Object[]{Long.MAX_VALUE, "a", "b"}, roundTrip(Long.MAX_VALUE, "a", "b"));
    }

    @Test
    void 지원하지_않는_값_타입은_거부한다() {
        assertThrows(StorageException.class, () -> RecordCodec.encode(new Object[]{1.5}));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "1|a",          // 필드 수 부족
            "1|a|b|c",      // 필드 수 초과
            "x|a|b",        // INT 자리에 문자
            "1|a\\|b",      // \| 때문에 실제 필드는 2개
            "1|a|b\\",      // 이스케이프로 끝남
            "1|a\\tb|c",    // 알 수 없는 이스케이프
            "1|a\\N|c",     // \N이 필드 일부
            "1|\\Nx|c",     // \N 뒤에 문자
    })
    void 깨진_줄은_StorageException(String line) {
        assertThrows(StorageException.class, () -> RecordCodec.decode(line, schema));
    }
}
