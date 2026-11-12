package com.minidbms.storage;

import com.minidbms.common.TableNotFoundException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TableTest {
    @TempDir
    Path dataDir;

    @Test
    void 스키마를_읽고_정규화된_이름으로_tbl_파일을_연다() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING");

        try (Table table = Table.open(dataDir, "USERS")) {
            assertEquals("users", table.name());
            assertEquals(2, table.schema().size());
            assertEquals(dataDir.resolve("users.tbl"), table.file().path());
            assertTrue(Files.exists(dataDir.resolve("users.tbl")));
        }
    }

    @Test
    void 없는_테이블이면_tbl_파일을_만들지_않는다() {
        assertThrows(TableNotFoundException.class, () -> Table.open(dataDir, "ghost"));
        assertFalse(Files.exists(dataDir.resolve("ghost.tbl")));
    }
}
