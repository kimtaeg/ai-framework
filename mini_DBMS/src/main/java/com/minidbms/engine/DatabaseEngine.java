package com.minidbms.engine;

import com.minidbms.sql.parser.Parser;
import com.minidbms.sql.parser.ast.Statement;
import com.minidbms.storage.Table;

import java.io.Closeable;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * SQL 실행의 유일한 진입점. CLI·API 서버·벤치마크 모두 execute(sql)만 부른다.
 *
 * <p>아직 스레드 안전하지 않다(테이블 락은 이후 단계).
 */
public final class DatabaseEngine implements Closeable {
    private final Path dataDir;
    private final Executor executor = new Executor();
    // 테이블은 처음 쓰일 때 열어서 캐시한다. 파일 핸들과 id 인덱스를 문장마다 다시 만들지 않으려고.
    private final Map<String, Table> tables = new HashMap<>();
    // 벤치마크에서 같은 데이터로 인덱스 경로와 FULL_SCAN을 비교하려고 끌 수 있게 한다.
    private boolean indexEnabled = true;

    public DatabaseEngine(Path dataDir) {
        this.dataDir = Objects.requireNonNull(dataDir, "dataDir");
    }

    /** false면 Planner가 항상 FULL_SCAN을 고른다. INSERT의 인덱스 등록은 계속한다(다시 켜면 바로 쓸 수 있게). */
    public void setIndexEnabled(boolean enabled) {
        this.indexEnabled = enabled;
    }

    public boolean isIndexEnabled() {
        return indexEnabled;
    }

    /**
     * 세미콜론으로 구분된 문장들을 순서대로 실행한다.
     *
     * <p>전체를 먼저 파싱하므로 문법 오류가 하나라도 있으면 아무것도 실행되지 않는다.
     * 실행 중 오류가 나면 그 앞 문장들의 결과는 이미 파일에 반영된 상태로 예외가 전파된다(트랜잭션 없음).
     */
    public List<QueryResult> execute(String sql) {
        List<Statement> statements = Parser.parseAll(sql);
        List<QueryResult> results = new ArrayList<>(statements.size());
        for (Statement statement : statements) {
            long start = System.nanoTime();
            QueryResult result = executor.execute(statement, table(statement.table()), indexEnabled);
            results.add(result.withElapsedMs((System.nanoTime() - start) / 1_000_000.0));
        }
        return results;
    }

    private Table table(String name) {
        Table table = tables.get(name);
        if (table == null) {
            // 처음 열 때 .tbl을 한 번 훑어 id 인덱스를 재구성한다(Table.open).
            // 로딩이 실패하면(테이블 없음 등) 캐시에 넣지 않으므로, 나중에 스키마 파일을 만들면 다시 시도된다.
            table = Table.open(dataDir, name);
            tables.put(name, table);
        }
        return table;
    }

    @Override
    public void close() {
        for (Table table : tables.values()) {
            table.close();
        }
        tables.clear();
    }
}
