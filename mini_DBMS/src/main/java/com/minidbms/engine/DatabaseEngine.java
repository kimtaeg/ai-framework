package com.minidbms.engine;

import com.minidbms.sql.parser.Parser;
import com.minidbms.sql.parser.ast.Statement;

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
    // 테이블은 처음 쓰일 때 열어서 캐시한다. 파일 핸들과 다음 id를 문장마다 다시 만들지 않으려고.
    private final Map<String, TableState> tables = new HashMap<>();

    public DatabaseEngine(Path dataDir) {
        this.dataDir = Objects.requireNonNull(dataDir, "dataDir");
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
            QueryResult result = executor.execute(statement, table(statement.table()));
            results.add(result.withElapsedMs((System.nanoTime() - start) / 1_000_000));
        }
        return results;
    }

    private TableState table(String name) {
        TableState state = tables.get(name);
        if (state == null) {
            // 로딩이 실패하면(테이블 없음 등) 캐시에 넣지 않으므로, 나중에 스키마 파일을 만들면 다시 시도된다.
            state = TableState.open(dataDir, name);
            tables.put(name, state);
        }
        return state;
    }

    @Override
    public void close() {
        for (TableState state : tables.values()) {
            state.close();
        }
        tables.clear();
    }
}
