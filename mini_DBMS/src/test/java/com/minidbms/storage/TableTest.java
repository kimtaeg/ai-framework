package com.minidbms.storage;

import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TableTest {
    @TempDir
    Path dataDir;

    @BeforeEach
    void setUp() throws IOException {
        Files.writeString(dataDir.resolve("users.schema"), "id:INT,name:STRING");
    }

    private static List<Object> values(Optional<Object[]> record) {
        return Arrays.asList(record.orElseThrow());
    }

    private static Object[] user(String name) {
        return new Object[]{null, name};
    }

    // ---- 열기 ----

    @Test
    void 스키마를_읽고_정규화된_이름으로_tbl_파일을_연다() {
        try (Table table = Table.open(dataDir, "USERS")) {
            assertEquals("users", table.name());
            assertEquals(2, table.schema().size());
            assertEquals(dataDir.resolve("users.tbl"), table.file().path());
            assertTrue(Files.exists(dataDir.resolve("users.tbl")));
            assertEquals(1, table.nextId());
        }
    }

    @Test
    void 없는_테이블이면_tbl_파일을_만들지_않는다() {
        assertThrows(TableNotFoundException.class, () -> Table.open(dataDir, "ghost"));
        assertFalse(Files.exists(dataDir.resolve("ghost.tbl")));
    }

    // ---- INSERT + id 조회 ----

    @Test
    void INSERT하면_id를_부여하고_인덱스로_조회된다() {
        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(1, table.insert(user("kim")));
            assertEquals(2, table.insert(user("이순신")));

            assertEquals(List.of(1L, "kim"), values(table.findById(1)));
            assertEquals(List.of(2L, "이순신"), values(table.findById(2)), "flush 전 버퍼에 있는 레코드");
            assertEquals(2, table.idIndex().size());
            assertEquals(3, table.nextId());
        }
    }

    @Test
    void 없는_id는_empty() {
        try (Table table = Table.open(dataDir, "users")) {
            table.insert(user("kim"));
            assertEquals(Optional.empty(), table.findById(0));
            assertEquals(Optional.empty(), table.findById(2));
            assertEquals(Optional.empty(), table.findById(-1));
        }
    }

    @Test
    void 인덱스의_offset은_그_id_레코드가_시작하는_바이트_위치다() throws IOException {
        try (Table table = Table.open(dataDir, "users")) {
            for (String name : List.of("a", "가나다", "😀|파이프", "")) {
                table.insert(user(name));
            }
        }
        byte[] bytes = Files.readAllBytes(dataDir.resolve("users.tbl"));

        try (Table table = Table.open(dataDir, "users")) {
            for (long id = 1; id <= 4; id++) {
                long offset = table.idIndex().search(id).orElseThrow();
                assertTrue(offset == 0 || bytes[(int) offset - 1] == '\n', "줄 시작이어야 한다: offset " + offset);
                int end = (int) offset;
                while (bytes[end] != '\n') {
                    end++;
                }
                String line = new String(bytes, (int) offset, end - (int) offset, StandardCharsets.UTF_8);
                assertEquals(id, RecordCodec.decode(line, table.schema())[0]);
            }
        }
    }

    // ---- 재시작 ----

    @Test
    void 재시작하면_파일을_스캔해_인덱스와_nextId를_재구성한다() {
        List<Long> offsets = new ArrayList<>();
        try (Table table = Table.open(dataDir, "users")) {
            for (int i = 1; i <= 1000; i++) {
                table.insert(user("user" + i));
                offsets.add(table.idIndex().search((long) i).orElseThrow());
            }
        }

        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(1000, table.idIndex().size());
            assertEquals(1001, table.nextId());
            for (int i = 1; i <= 1000; i++) {
                assertEquals(offsets.get(i - 1), table.idIndex().search((long) i).orElseThrow());
            }
            assertEquals(List.of(500L, "user500"), values(table.findById(500)));
            assertEquals(1001, table.insert(user("new")));
        }
    }

    @Test
    void 재구성은_파일의_최대_id를_기준으로_한다() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "5|a\n2|b\n9|c\n");
        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(10, table.nextId());
            assertEquals(List.of(9L, "c"), values(table.findById(9)));
            assertEquals(Optional.empty(), table.findById(3));
        }
    }

    @Test
    void 파일에_같은_id가_두_번_있으면_StorageException() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "1|a\n1|b\n");
        StorageException e = assertThrows(StorageException.class, () -> Table.open(dataDir, "users"));
        assertTrue(e.getMessage().contains("id 1"), e.getMessage());
    }

    @Test
    void id가_NULL인_레코드는_StorageException() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "\\N|a\n");
        assertThrows(StorageException.class, () -> Table.open(dataDir, "users"));
    }

    // ---- 깨진 마지막 줄 ----

    @Test
    void 줄바꿈_없이_끝난_마지막_줄은_이번_로딩에서_인덱스와_스캔에서_빠진다() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "1|a\n2|half");
        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(Optional.empty(), table.findById(2));
            List<Object> scannedIds = new ArrayList<>();
            table.scan(r -> scannedIds.add(r[0]));
            assertEquals(List.of(1L), scannedIds);
            // 무시한 줄의 id는 피한다. 재시작하면 그 줄이 살아나므로 겹치면 안 된다.
            assertEquals(3, table.insert(user("b")));
        }
        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(List.of(2L, "half"), values(table.findById(2)));
            assertEquals(3, table.idIndex().size());
        }
    }

    @Test
    void 무시한_마지막_줄이_해석되지_않아도_로딩은_성공한다() throws IOException {
        Files.writeString(dataDir.resolve("users.tbl"), "1|a\ngarbage-without-fields");
        try (Table table = Table.open(dataDir, "users")) {
            assertEquals(2, table.nextId());
        }
        // 다음 재시작에는 일반 줄로 읽히므로, 깨진 내용이면 그때 실패한다 (선택한 정책).
        assertThrows(StorageException.class, () -> Table.open(dataDir, "users"));
    }

    // ---- 쓰기 실패 ----

    @Test
    void 파일_쓰기가_실패하면_인덱스에_등록하지_않고_id도_소모하지_않는다() {
        Table table = Table.open(dataDir, "users");
        table.insert(user("kim"));
        table.file().close(); // 이후 append가 StorageException을 던지게 만든다.

        assertThrows(StorageException.class, () -> table.insert(user("lee")));
        assertEquals(1, table.idIndex().size());
        assertEquals(Optional.empty(), table.idIndex().search(2L));
        assertEquals(2, table.nextId());
        table.close();
    }

    @Test
    void 인코딩할_수_없는_값이면_인덱스에_등록하지_않는다() {
        try (Table table = Table.open(dataDir, "users")) {
            assertThrows(StorageException.class, () -> table.insert(new Object[]{null, 1.5}));
            assertEquals(0, table.idIndex().size());
            assertEquals(1, table.nextId());
        }
    }
}
