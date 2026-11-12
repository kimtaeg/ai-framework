package com.minidbms.storage;

import com.minidbms.common.ColumnNotFoundException;
import com.minidbms.common.StorageException;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 테이블의 컬럼 정의. 생성 후 바뀌지 않으므로 여러 스레드가 락 없이 읽어도 안전하다.
 */
public final class Schema {
    private final String tableName;
    private final List<Column> columns;
    // SQL 식별자는 대소문자를 구분하지 않으므로 소문자 키로 인덱스를 찾는다.
    private final Map<String, Integer> indexByName;

    public Schema(String tableName, List<Column> columns) {
        if (columns.isEmpty()) {
            throw new StorageException("테이블 '" + tableName + "'에 컬럼이 하나도 없습니다");
        }
        this.tableName = tableName;
        this.columns = List.copyOf(columns);
        Map<String, Integer> map = new HashMap<>();
        for (int i = 0; i < this.columns.size(); i++) {
            String key = normalize(this.columns.get(i).name());
            if (map.putIfAbsent(key, i) != null) {
                throw new StorageException("테이블 '" + tableName + "'에 컬럼 '"
                        + this.columns.get(i).name() + "'이(가) 중복 정의되어 있습니다");
            }
        }
        this.indexByName = Map.copyOf(map);
    }

    public String tableName() {
        return tableName;
    }

    public List<Column> columns() {
        return columns;
    }

    public int size() {
        return columns.size();
    }

    public Column column(int index) {
        return columns.get(index);
    }

    public boolean hasColumn(String name) {
        return indexByName.containsKey(normalize(name));
    }

    public int indexOf(String name) {
        Integer index = indexByName.get(normalize(name));
        if (index == null) {
            throw new ColumnNotFoundException("테이블 '" + tableName + "'에 컬럼 '" + name
                    + "'이(가) 없습니다 (컬럼: " + columnNames() + ")");
        }
        return index;
    }

    private String columnNames() {
        return String.join(", ", columns.stream().map(Column::name).toList());
    }

    private static String normalize(String name) {
        return name.trim().toLowerCase(Locale.ROOT);
    }
}
