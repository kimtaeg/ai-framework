package com.minidbms.storage;

import com.minidbms.common.DuplicateKeyException;
import com.minidbms.common.StorageException;
import com.minidbms.index.BPlusTree;

import java.io.Closeable;
import java.nio.file.Path;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.function.Consumer;

/**
 * 테이블 하나의 스키마·데이터 파일·id 인덱스를 묶는다.
 *
 * <p>id 인덱스(id → .tbl 안의 byte offset)는 메모리에만 있다. 열 때 파일을 한 번 훑어 다시 만든다.
 * 파일에는 레코드만 append되므로, 파일 내용이 곧 인덱스의 원본이다.
 */
public final class Table implements Closeable {
    public static final String ID_COLUMN = "id";
    static final String DATA_EXTENSION = ".tbl";
    static final int INDEX_ORDER = 128;

    private static final System.Logger LOG = System.getLogger(Table.class.getName());

    private final String name;
    private final Schema schema;
    private final TableFile file;
    private final int idColumn;
    private final BPlusTree<Long, Long> idIndex = new BPlusTree<>(INDEX_ORDER);
    private long nextId = 1;
    // 이번 로딩에서 무시하는 줄(열 때 줄바꿈 없이 끝나 있던 마지막 줄)의 offset. 없으면 -1
    private long ignoredOffset = -1;

    private Table(String name, Schema schema, TableFile file) {
        this.name = name;
        this.schema = schema;
        this.file = file;
        if (!schema.hasColumn(ID_COLUMN) || schema.column(schema.indexOf(ID_COLUMN)).type() != ColumnType.INT) {
            throw new StorageException("테이블 '" + name + "'의 스키마에 'id:INT' 컬럼이 필요합니다: " + file.path());
        }
        this.idColumn = schema.indexOf(ID_COLUMN);
    }

    /**
     * data/{table}.schema를 읽고 data/{table}.tbl을 연 뒤(없으면 빈 파일 생성) id 인덱스를 재구성한다.
     * 스키마를 먼저 읽기 때문에 없는 테이블이면 .tbl 파일을 만들지 않고 TableNotFoundException이 난다.
     */
    public static Table open(Path dataDir, String tableName) {
        Schema schema = new SchemaLoader(dataDir).load(tableName);
        // 정규화된 이름(소문자)을 써야 .schema와 .tbl 파일 이름이 항상 짝이 맞는다.
        String name = schema.tableName();
        TableFile file = new TableFile(dataDir.resolve(name + DATA_EXTENSION));
        try {
            Table table = new Table(name, schema, file);
            table.rebuildIndex();
            return table;
        } catch (RuntimeException e) {
            file.close();
            throw e;
        }
    }

    private void rebuildIndex() {
        OptionalLong unterminated = file.unterminatedLineOffset();
        if (unterminated.isPresent()) {
            ignoredOffset = unterminated.getAsLong();
            LOG.log(System.Logger.Level.WARNING, "테이블 ''{0}''의 마지막 줄(offset {1})이 줄바꿈 없이 끝나 있어 "
                    + "이번 로딩에서는 무시합니다. 줄바꿈을 붙여 두었으므로 다음 재시작부터는 일반 레코드로 읽힙니다: {2}",
                    name, ignoredOffset, file.path());
        }

        long[] maxId = {0};
        file.scanWithOffsets((offset, line) -> {
            if (offset == ignoredOffset) {
                // 인덱스·조회에서는 빼지만 id는 피한다. 다음 재시작에 이 줄이 살아날 때 id가 겹치지 않게 하려고.
                ignoredId(line).ifPresent(id -> maxId[0] = Math.max(maxId[0], id));
                return;
            }
            long id = idOf(RecordCodec.decode(line, schema), offset);
            try {
                idIndex.insert(id, offset);
            } catch (DuplicateKeyException e) {
                throw new StorageException("테이블 '" + name + "'에 id " + id + "인 레코드가 여러 개 있습니다 (offset "
                        + idIndex.search(id).orElseThrow() + ", " + offset + "): " + file.path());
            }
            maxId[0] = Math.max(maxId[0], id);
        });
        nextId = maxId[0] + 1;
    }

    private OptionalLong ignoredId(String line) {
        try {
            Object id = RecordCodec.decode(line, schema)[idColumn];
            return id instanceof Long n ? OptionalLong.of(n) : OptionalLong.empty();
        } catch (StorageException e) {
            return OptionalLong.empty();
        }
    }

    private long idOf(Object[] record, long offset) {
        if (!(record[idColumn] instanceof Long id)) {
            throw new StorageException("테이블 '" + name + "'의 offset " + offset + " 레코드에 id가 없습니다: " + file.path());
        }
        return id;
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

    /** id 컬럼의 스키마 위치 */
    public int idColumn() {
        return idColumn;
    }

    BPlusTree<Long, Long> idIndex() {
        return idIndex;
    }

    /** 다음 INSERT가 받을 id */
    public long nextId() {
        return nextId;
    }

    /**
     * id를 부여해 레코드를 파일에 쓰고 인덱스에 등록한다. flush는 호출자가 문장 단위로 한다.
     *
     * <p>순서가 중요하다: 파일 쓰기가 성공해서 offset을 받은 뒤에만 인덱스에 넣고 nextId를 올린다.
     * 쓰기가 실패하면 인덱스는 그대로이고 id도 소모되지 않는다.
     *
     * @param record id 자리는 비워 둔(무시되는) 스키마 순서의 값 배열. 이 메서드가 id를 채운다.
     * @return 부여한 id
     */
    public long insert(Object[] record) {
        long id = nextId;
        record[idColumn] = id;
        long offset = file.append(RecordCodec.encode(record));
        idIndex.insert(id, offset);
        nextId++;
        return id;
    }

    /** id 인덱스로 레코드 하나를 찾아 그 offset의 줄만 읽는다. */
    public Optional<Object[]> findById(long id) {
        return idIndex.search(id).map(offset -> RecordCodec.decode(file.readAt(offset), schema));
    }

    /** 전체 레코드를 파일 순서대로 넘긴다. 이번 로딩에서 무시하기로 한 줄은 빠진다. */
    public void scan(Consumer<Object[]> consumer) {
        file.scanWithOffsets((offset, line) -> {
            if (offset != ignoredOffset) {
                consumer.accept(RecordCodec.decode(line, schema));
            }
        });
    }

    public void flush() {
        file.flush();
    }

    @Override
    public void close() {
        file.close();
    }
}
