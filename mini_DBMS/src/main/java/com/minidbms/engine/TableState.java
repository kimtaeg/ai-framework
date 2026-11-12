package com.minidbms.engine;

import com.minidbms.common.StorageException;
import com.minidbms.storage.ColumnType;
import com.minidbms.storage.RecordCodec;
import com.minidbms.storage.Schema;
import com.minidbms.storage.Table;

import java.io.Closeable;
import java.nio.file.Path;

/**
 * 엔진이 캐시하는 테이블 한 개. Table에 엔진만 아는 상태(다음 id)를 덧붙인다.
 */
final class TableState implements Closeable {
    static final String ID_COLUMN = "id";

    private final Table table;
    private final int idIndex;
    private long nextId;

    private TableState(Table table, int idIndex, long nextId) {
        this.table = table;
        this.idIndex = idIndex;
        this.nextId = nextId;
    }

    static TableState open(Path dataDir, String name) {
        Table table = Table.open(dataDir, name);
        try {
            Schema schema = table.schema();
            if (!schema.hasColumn(ID_COLUMN) || schema.column(schema.indexOf(ID_COLUMN)).type() != ColumnType.INT) {
                throw new StorageException("테이블 '" + schema.tableName() + "'의 스키마에 'id:INT' 컬럼이 필요합니다: "
                        + table.file().path());
            }
            int idIndex = schema.indexOf(ID_COLUMN);
            // 열 때 한 번만 전체를 훑어 최대 id를 구하고, 이후로는 메모리에서 1씩 올린다.
            // 매 INSERT마다 스캔하면 INSERT가 O(N)이 된다.
            long[] maxId = {0};
            table.file().scan(line -> {
                Object id = RecordCodec.decode(line, schema)[idIndex];
                if (id instanceof Long n && n > maxId[0]) {
                    maxId[0] = n;
                }
            });
            return new TableState(table, idIndex, maxId[0] + 1);
        } catch (RuntimeException e) {
            table.close();
            throw e;
        }
    }

    Table table() {
        return table;
    }

    Schema schema() {
        return table.schema();
    }

    int idIndex() {
        return idIndex;
    }

    long nextId() {
        return nextId++;
    }

    @Override
    public void close() {
        table.close();
    }
}
