package com.minidbms.storage;

import com.minidbms.common.StorageException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TableFileTest {
    @TempDir
    Path dir;

    private static List<String> scanAll(TableFile file) {
        List<String> lines = new ArrayList<>();
        file.scan(lines::add);
        return lines;
    }

    @Test
    void 파일이_없으면_빈_파일로_만든다() throws IOException {
        Path path = dir.resolve("t.tbl");
        try (TableFile file = new TableFile(path)) {
            assertTrue(Files.exists(path));
            assertEquals(0, Files.size(path));
            assertEquals(List.of(), scanAll(file));
        }
    }

    @Test
    void append한_줄을_순서대로_scan한다() {
        try (TableFile file = new TableFile(dir.resolve("t.tbl"))) {
            file.append("1|kim");
            file.append("2|lee");
            assertEquals(List.of("1|kim", "2|lee"), scanAll(file));

            // scan 이후에 쓴 것도 다음 scan에 나온다.
            file.append("3|park");
            assertEquals(List.of("1|kim", "2|lee", "3|park"), scanAll(file));
        }
    }

    @Test
    void offset은_실제_줄이_시작하는_바이트_위치다() throws IOException {
        Path path = dir.resolve("t.tbl");
        // 한글(3바이트)·이모지(4바이트)를 섞어 문자 수와 바이트 수가 다르게 만든다.
        List<String> lines = List.of("1|abc", "2|김정글", "3|😀|x", "4|");
        long[] offsets = new long[lines.size()];
        try (TableFile file = new TableFile(path)) {
            for (int i = 0; i < lines.size(); i++) {
                offsets[i] = file.append(lines.get(i));
            }
        }

        byte[] bytes = Files.readAllBytes(path);
        assertEquals(0, offsets[0]);
        for (int i = 0; i < lines.size(); i++) {
            byte[] expected = (lines.get(i) + "\n").getBytes(StandardCharsets.UTF_8);
            byte[] actual = Arrays.copyOfRange(bytes, (int) offsets[i], (int) offsets[i] + expected.length);
            assertEquals(lines.get(i) + "\n", new String(actual, StandardCharsets.UTF_8));
        }
        assertEquals(offsets[1] - offsets[0], "1|abc\n".getBytes(StandardCharsets.UTF_8).length);
        assertEquals(bytes.length, offsets[3] + "4|\n".length());
    }

    @Test
    void 다시_열면_기존_내용_뒤에서_offset이_이어진다() throws IOException {
        Path path = dir.resolve("t.tbl");
        try (TableFile file = new TableFile(path)) {
            file.append("1|가");
        }
        long sizeAfterFirst = Files.size(path);

        try (TableFile file = new TableFile(path)) {
            assertEquals(sizeAfterFirst, file.size());
            assertEquals(sizeAfterFirst, file.append("2|b"));
            assertEquals(List.of("1|가", "2|b"), scanAll(file));
        }
    }

    @Test
    void 쓰기는_flush_전까지_버퍼에_머문다() throws IOException {
        Path path = dir.resolve("t.tbl");
        try (TableFile file = new TableFile(path)) {
            file.append("1|a");
            assertEquals(0, Files.size(path), "매 append마다 디스크에 쓰지 않는다");
            assertEquals(4, file.size(), "논리적 크기에는 버퍼가 포함된다");

            file.flush();
            assertEquals(4, Files.size(path));
        }
    }

    @Test
    void close하면_남은_버퍼를_내려쓰고_이후_쓰기는_거부한다() throws IOException {
        Path path = dir.resolve("t.tbl");
        TableFile file = new TableFile(path);
        file.append("1|a");
        file.close();
        file.close(); // 두 번 닫아도 안전

        assertEquals("1|a\n", Files.readString(path));
        assertThrows(StorageException.class, () -> file.append("2|b"));
    }

    @Test
    void 줄바꿈이_든_줄은_거부한다() {
        try (TableFile file = new TableFile(dir.resolve("t.tbl"))) {
            assertThrows(StorageException.class, () -> file.append("1|a\nb"));
            assertThrows(StorageException.class, () -> file.append("1|a\rb"));
            assertEquals(0, file.size());
        }
    }

    @Test
    void 코덱으로_인코딩한_레코드가_파일을_거쳐_왕복된다() {
        Schema schema = new Schema("t", List.of(new Column("id", ColumnType.INT), new Column("memo", ColumnType.STRING)));
        Object[] record = {1L, "줄\n바꿈 | 파이프 \\ 역슬래시"};
        try (TableFile file = new TableFile(dir.resolve("t.tbl"))) {
            file.append(RecordCodec.encode(record));
            file.append(RecordCodec.encode(new Object[]{2L, null}));

            List<Object[]> decoded = new ArrayList<>();
            file.scan(line -> decoded.add(RecordCodec.decode(line, schema)));
            assertEquals(2, decoded.size());
            assertEquals(Arrays.asList(record), Arrays.asList(decoded.get(0)));
            assertEquals(Arrays.asList(2L, null), Arrays.asList(decoded.get(1)));
        }
    }

    @Test
    void 줄바꿈_없이_끝난_파일을_열면_줄바꿈을_먼저_넣고_이어_쓴다() throws IOException {
        Path path = dir.resolve("t.tbl");
        Files.writeString(path, "1|가");
        long sizeWithoutNewline = Files.size(path);

        try (TableFile file = new TableFile(path)) {
            assertEquals(sizeWithoutNewline + 1, file.size());
            assertEquals(sizeWithoutNewline + 1, file.append("2|b"));
            assertEquals(List.of("1|가", "2|b"), scanAll(file));
        }
        assertEquals("1|가\n2|b\n", Files.readString(path));
    }

    @Test
    void 줄바꿈으로_끝난_파일은_건드리지_않는다() throws IOException {
        Path path = dir.resolve("t.tbl");
        Files.writeString(path, "1|a\n");
        try (TableFile file = new TableFile(path)) {
            assertEquals(4, file.size());
        }
        assertEquals("1|a\n", Files.readString(path));
    }
}
