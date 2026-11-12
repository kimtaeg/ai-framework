package com.minidbms.engine;

import java.util.Collections;
import java.util.List;

/**
 * 문장 하나의 실행 결과.
 *
 * @param columns      SELECT가 돌려주는 컬럼 이름(스키마 표기). INSERT는 ["id"]
 * @param rows         SELECT 결과 행. 값은 Long, String, null(NULL). INSERT는 부여된 id 한 행 [[id]]
 * @param affectedRows INSERT는 삽입한 행 수, SELECT는 반환한 행 수
 */
public record QueryResult(Type type, List<String> columns, List<List<Object>> rows, long affectedRows, long elapsedMs) {
    public enum Type { INSERT, SELECT }

    public QueryResult {
        columns = List.copyOf(columns);
        // 행 안에 NULL(null)이 있으므로 null을 거부하는 List.copyOf 대신 읽기 전용 래퍼를 쓴다.
        rows = Collections.unmodifiableList(rows);
    }

    QueryResult withElapsedMs(long ms) {
        return new QueryResult(type, columns, rows, affectedRows, ms);
    }
}
