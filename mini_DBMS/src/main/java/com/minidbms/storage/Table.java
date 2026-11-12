package com.minidbms.storage;

import java.io.Closeable;
import java.nio.file.Path;
import java.util.Objects;

/**
 * 테이블 하나의 이름·스키마·데이터 파일을 묶는다. 파일 핸들을 쥐고 있으므로 다 쓰면 close한다.
 */
public final class Table implements Closeable {
    static final String DATA_EXTENSION = ".tbl";

    private final String name;
    private final Schema schema;
    private final TableFile file;

    public Table(String name, Schema schema, TableFile file) {
        this.name = Objects.requireNonNull(name, "name");
        this.schema = Objects.requireNonNull(schema, "schema");
        this.file = Objects.requireNonNull(file, "file");
    }

    /**
     * data/{table}.schema를 읽고 data/{table}.tbl을 연다(없으면 빈 파일 생성).
     * 스키마를 먼저 읽기 때문에 없는 테이블이면 .tbl 파일을 만들지 않고 TableNotFoundException이 난다.
     */
    public static Table open(Path dataDir, String tableName) {
        Schema schema = new SchemaLoader(dataDir).load(tableName);
        // 정규화된 이름(소문자)을 써야 .schema와 .tbl 파일 이름이 항상 짝이 맞는다.
        String name = schema.tableName();
        return new Table(name, schema, new TableFile(dataDir.resolve(name + DATA_EXTENSION)));
    }

    public String name() {
        return name;
    }

    public Schema schema() {
        return schema;
    }

    public TableFile file() {
        return file;
    }

    @Override
    public void close() {
        file.close();
    }
}
