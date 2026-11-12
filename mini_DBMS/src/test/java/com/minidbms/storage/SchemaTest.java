package com.minidbms.storage;

import com.minidbms.common.ColumnNotFoundException;
import com.minidbms.common.StorageException;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SchemaTest {
    private final Schema schema = new Schema("users",
            List.of(new Column("id", ColumnType.INT), new Column("Name", ColumnType.STRING)));

    @Test
    void 이름으로_인덱스를_찾을_때_대소문자를_무시한다() {
        assertEquals(0, schema.indexOf("ID"));
        assertEquals(1, schema.indexOf("name"));
        assertTrue(schema.hasColumn("NAME"));
        assertFalse(schema.hasColumn("age"));
    }

    @Test
    void 없는_컬럼이면_ColumnNotFoundException() {
        ColumnNotFoundException e = assertThrows(ColumnNotFoundException.class, () -> schema.indexOf("age"));
        assertTrue(e.getMessage().contains("age") && e.getMessage().contains("id, Name"), e.getMessage());
    }

    @Test
    void 중복_컬럼이나_빈_컬럼_목록은_거부한다() {
        assertThrows(StorageException.class, () -> new Schema("t",
                List.of(new Column("a", ColumnType.INT), new Column("A", ColumnType.STRING))));
        assertThrows(StorageException.class, () -> new Schema("t", List.of()));
    }

    @Test
    void 컬럼_목록은_외부에서_바꿀_수_없다() {
        List<Column> source = new ArrayList<>(List.of(new Column("id", ColumnType.INT)));
        Schema s = new Schema("t", source);
        source.add(new Column("x", ColumnType.INT));

        assertEquals(1, s.size());
        assertThrows(UnsupportedOperationException.class, () -> s.columns().add(new Column("y", ColumnType.INT)));
    }

    @Test
    void 타입_파싱은_대소문자와_공백을_무시한다() {
        assertEquals(ColumnType.INT, ColumnType.parse(" int "));
        assertEquals(ColumnType.STRING, ColumnType.parse("String"));
        assertThrows(StorageException.class, () -> ColumnType.parse("BOOL"));
    }
}
