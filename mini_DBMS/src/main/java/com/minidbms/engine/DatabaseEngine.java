package com.minidbms.engine;

import com.minidbms.sql.parser.Parser;
import com.minidbms.sql.parser.ast.InsertStatement;
import com.minidbms.sql.parser.ast.Statement;
import com.minidbms.storage.Table;

import java.io.Closeable;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SQL 실행의 유일한 진입점. CLI·API 서버·벤치마크 모두 execute(sql)만 부른다.
 *
 * <p><b>스레드 안전하다.</b> 여러 스레드가 execute를 동시에 불러도 된다.
 * <ul>
 *   <li>테이블 캐시: ConcurrentHashMap.computeIfAbsent로 테이블마다 한 번만 연다.</li>
 *   <li>테이블 안: Table의 ReentrantReadWriteLock (INSERT는 쓰기, SELECT는 읽기).</li>
 *   <li>Lexer·Parser·Executor·Planner는 호출마다 새로 만들거나 필드가 없어 공유 상태가 없다.</li>
 * </ul>
 * 원자성은 문장 하나 단위다. execute에 넘긴 여러 문장이 한꺼번에 보이지는 않는다(트랜잭션 없음).
 * close는 다른 execute가 모두 끝난 뒤에 불러야 한다.
 */
public final class DatabaseEngine implements Closeable {
    private final Path dataDir;
    private final Executor executor = new Executor();
    // 테이블은 처음 쓰일 때 열어서 캐시한다. 파일 핸들과 id 인덱스를 문장마다 다시 만들지 않으려고.
    private final ConcurrentHashMap<String, Table> tables = new ConcurrentHashMap<>();
    // 벤치마크에서 같은 데이터로 인덱스 경로와 FULL_SCAN을 비교하려고 끌 수 있게 한다. 다른 스레드에 바로 보이도록 volatile.
    private volatile boolean indexEnabled = true;

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
     *
     * <p>flush는 문장마다가 아니라 이 호출이 끝날 때(성공이든 실패든) 쓴 테이블마다 한 번 한다.
     * 호출자 입장의 보장은 같다: execute가 반환되면 그 안의 INSERT는 모두 파일(OS)에 내려가 있다.
     */
    public List<QueryResult> execute(String sql) {
        List<Statement> statements = Parser.parseAll(sql);
        List<QueryResult> results = new ArrayList<>(statements.size());
        LinkedHashSet<Table> written = new LinkedHashSet<>();
        try {
            for (Statement statement : statements) {
                Table table = table(statement.table());
                if (statement instanceof InsertStatement) {
                    written.add(table);
                }
                long start = System.nanoTime();
                QueryResult result = executor.execute(statement, table, indexEnabled);
                results.add(result.withElapsedMs((System.nanoTime() - start) / 1_000_000.0));
            }
        } catch (RuntimeException e) {
            flushAll(written, e);
            throw e;
        }
        flushAll(written, null);
        return results;
    }

    /** failure가 있으면 flush 오류를 거기에 덧붙여서 원래 오류가 가려지지 않게 한다. */
    private static void flushAll(Iterable<Table> tables, RuntimeException failure) {
        RuntimeException flushError = null;
        for (Table table : tables) {
            try {
                table.flush();
            } catch (RuntimeException e) {
                if (failure != null) {
                    failure.addSuppressed(e);
                } else if (flushError == null) {
                    flushError = e;
                } else {
                    flushError.addSuppressed(e);
                }
            }
        }
        if (flushError != null) {
            throw flushError;
        }
    }

    private Table table(String name) {
        // computeIfAbsent는 같은 키에 대해 함수를 한 번만 실행하고, 그동안 같은 키를 요청한 스레드는 기다린다.
        // get 후 put으로 하면 두 스레드가 같은 파일을 두 번 열어 각자 다른 인덱스·nextId를 갖게 된다(id 중복).
        // 처음 열 때 .tbl을 한 번 훑어 id 인덱스를 재구성한다(Table.open).
        // 로딩이 실패하면(테이블 없음 등) 예외가 전파되고 캐시에 남지 않으므로, 나중에 스키마 파일을 만들면 다시 시도된다.
        return tables.computeIfAbsent(name, key -> Table.open(dataDir, key));
    }

    @Override
    public void close() {
        for (Table table : tables.values()) {
            table.close();
        }
        tables.clear();
    }
}
