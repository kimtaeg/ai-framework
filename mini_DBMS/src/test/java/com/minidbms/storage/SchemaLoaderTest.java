package com.minidbms.storage;

import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SchemaLoaderTest {
    @TempDir
    Path dataDir;

    SchemaLoader loader;

    @BeforeEach
    void setUp() {
        loader = new SchemaLoader(dataDir);
    }

    private void writeSchema(String table, String content) throws IOException {
        Files.writeString(dataDir.resolve(table + ".schema"), content, StandardCharsets.UTF_8);
    }

    @Test
    void 정상_스키마를_로딩한다() throws IOException {
        writeSchema("users", "id:INT,name:STRING\n");

        Schema schema = loader.load("users");

        assertEquals("users", schema.tableName());
        assertEquals(List.of(new Column("id", ColumnType.INT), new Column("name", ColumnType.STRING)),
                schema.columns());
        assertEquals(1, schema.indexOf("name"));
    }

    @Test
    void 스키마_파일이_없으면_TableNotFoundException() {
        TableNotFoundException e = assertThrows(TableNotFoundException.class, () -> loader.load("ghost"));
        assertTrue(e.getMessage().contains("ghost"), e.getMessage());
    }

    @Test
    void 알_수_없는_타입이면_StorageException() throws IOException {
        writeSchema("users", "id:INT,score:FLOAT");

        StorageException e = assertThrows(StorageException.class, () -> loader.load("users"));
        assertTrue(e.getMessage().contains("FLOAT"), e.getMessage());
        assertTrue(e.getMessage().contains("score"), e.getMessage());
    }

    @Test
    void 공백과_타입_대소문자를_허용한다() throws IOException {
        writeSchema("users", "  id : int ,  Name:String  \r\n");

        Schema schema = loader.load("users");

        assertEquals(List.of(new Column("id", ColumnType.INT), new Column("Name", ColumnType.STRING)),
                schema.columns());
    }

    @Test
    void 테이블_이름은_대소문자를_구분하지_않는다() throws IOException {
        writeSchema("users", "id:INT");

        assertEquals("users", loader.load("USERS").tableName());
        assertEquals(dataDir.resolve("users.schema"), loader.schemaPath(" Users "));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "   \n", "id:INT,", "id", "id:INT:X", ":INT", "id:INT,ID:STRING", "id:INT\nname:STRING"})
    void 형식이_잘못되면_StorageException(String content) throws IOException {
        writeSchema("users", content);

        StorageException e = assertThrows(StorageException.class, () -> loader.load("users"));
        assertTrue(e.getMessage().contains("users.schema"), "메시지에 파일 경로가 있어야 한다: " + e.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {"../etc", "a/b", "1users", "", "   "})
    void 파일_경로로_쓸_수_없는_테이블_이름은_거부한다(String name) {
        assertThrows(TableNotFoundException.class, () -> loader.load(name));
    }
}
