package com.minidbms.storage;

import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * data/{table}.schema 파일(한 줄: "id:INT,name:STRING")을 Schema로 읽는다.
 * 데이터 디렉터리를 생성자로 받아서 테스트가 임시 폴더를 쓸 수 있게 한다.
 */
public final class SchemaLoader {
    static final String EXTENSION = ".schema";

    // 테이블 이름이 그대로 파일 이름이 되므로 "../x" 같은 경로 조작을 막는다.
    private static final Pattern TABLE_NAME = Pattern.compile("[a-z_][a-z0-9_]*");

    private final Path dataDir;

    public SchemaLoader(Path dataDir) {
        this.dataDir = Objects.requireNonNull(dataDir, "dataDir");
    }

    public Path schemaPath(String tableName) {
        // 테이블 이름은 대소문자를 구분하지 않으므로 파일 이름을 소문자로 통일한다.
        // 대소문자를 구분하는 파일 시스템(Linux)에서도 USERS와 users가 같은 파일을 가리키게 된다.
        return dataDir.resolve(normalizeTableName(tableName) + EXTENSION);
    }

    public Schema load(String tableName) {
        String table = normalizeTableName(tableName);
        Path path = schemaPath(table);
        String content;
        try {
            content = Files.readString(path, StandardCharsets.UTF_8);
        } catch (NoSuchFileException e) {
            throw new TableNotFoundException("테이블 '" + table + "'이(가) 없습니다 (스키마 파일 없음: " + path + ")");
        } catch (IOException e) {
            throw new StorageException("스키마 파일을 읽을 수 없습니다: " + path, e);
        }
        return parse(table, content, path);
    }

    private static Schema parse(String table, String content, Path path) {
        // 편집기가 붙이는 BOM과 마지막 줄바꿈은 형식 오류로 보지 않는다.
        String line = content.replace("﻿", "").strip();
        if (line.isEmpty()) {
            throw new StorageException("스키마 파일이 비어 있습니다: " + path);
        }
        if (line.contains("\n") || line.contains("\r")) {
            throw new StorageException("스키마 파일은 한 줄이어야 합니다: " + path);
        }

        List<Column> columns = new ArrayList<>();
        for (String entry : line.split(",", -1)) {
            columns.add(parseColumn(entry, path));
        }
        try {
            return new Schema(table, columns);
        } catch (StorageException e) {
            throw new StorageException(e.getMessage() + ": " + path, e);
        }
    }

    private static Column parseColumn(String entry, Path path) {
        String[] parts = entry.split(":", -1);
        if (parts.length != 2) {
            throw new StorageException("컬럼 정의 '" + entry.trim() + "'은(는) '이름:타입' 형식이어야 합니다: " + path);
        }
        String name = parts[0].trim();
        if (name.isEmpty()) {
            throw new StorageException("컬럼 정의 '" + entry.trim() + "'에 이름이 없습니다: " + path);
        }
        try {
            return new Column(name, ColumnType.parse(parts[1]));
        } catch (StorageException e) {
            throw new StorageException("컬럼 '" + name + "': " + e.getMessage() + ": " + path, e);
        }
    }

    private static String normalizeTableName(String tableName) {
        Objects.requireNonNull(tableName, "tableName");
        String table = tableName.trim().toLowerCase(Locale.ROOT);
        if (!TABLE_NAME.matcher(table).matches()) {
            throw new TableNotFoundException("잘못된 테이블 이름 '" + tableName
                    + "' (영문자·숫자·밑줄만 쓸 수 있고 숫자로 시작할 수 없습니다)");
        }
        return table;
    }
}
