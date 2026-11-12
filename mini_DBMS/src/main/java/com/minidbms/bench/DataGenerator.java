package com.minidbms.bench;

import com.minidbms.common.DbException;
import com.minidbms.engine.DatabaseEngine;
import com.minidbms.storage.Schema;
import com.minidbms.storage.SchemaLoader;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

/**
 * 대용량 테스트 데이터 생성기.
 *
 * <pre>
 * java -jar mini-dbms.jar generate --table users --count 1000000 [--seed 42] [--data ./data]
 *                                  [--batch 1000] [--reset] [--out users.sql]
 * </pre>
 *
 * 데이터는 Phase 1 SQL 처리기를 그대로 거친다: INSERT SQL 문자열을 만들어 DatabaseEngine.execute로 실행한다.
 * --out을 주면 실행하지 않고 같은 SQL을 파일로만 쓴다(run 모드로 실행 가능).
 */
public final class DataGenerator {
    static final int PROGRESS_EVERY = 100_000;
    static final String DEFAULT_SCHEMA = "id:INT,name:STRING,age:INT,email:STRING";
    static final List<String> REQUIRED_COLUMNS = List.of("name", "age", "email");

    static final String USAGE = """
            사용법:
              java -jar mini-dbms.jar generate --table users --count 1000000 [--seed 42] [--data ./data]
                                               [--batch 1000] [--reset] [--out file.sql]
              --batch  execute 한 번에 넘기는 INSERT 문장 수 (기본 1000)
              --reset  기존 .tbl 데이터를 지우고 시작
              --out    실행하지 않고 SQL 파일로만 내보내기""";

    record Options(String table, long count, long seed, Path dataDir, int batchSize, boolean reset, Path sqlOut) {
        static Options parse(String[] args) {
            String table = null;
            Long count = null;
            long seed = 42;
            Path dataDir = Path.of("data");
            int batch = 1000;
            boolean reset = false;
            Path out = null;
            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                switch (arg) {
                    case "--table" -> table = value(args, ++i, arg);
                    case "--count" -> count = positiveLong(value(args, ++i, arg), arg);
                    case "--seed" -> seed = parseLong(value(args, ++i, arg), arg);
                    case "--data" -> dataDir = Path.of(value(args, ++i, arg));
                    case "--batch" -> batch = (int) Math.min(Integer.MAX_VALUE, positiveLong(value(args, ++i, arg), arg));
                    case "--reset" -> reset = true;
                    case "--out" -> out = Path.of(value(args, ++i, arg));
                    default -> throw new IllegalArgumentException("알 수 없는 인자 '" + arg + "'");
                }
            }
            if (table == null) {
                throw new IllegalArgumentException("--table이 필요합니다");
            }
            if (count == null) {
                throw new IllegalArgumentException("--count가 필요합니다");
            }
            return new Options(table.toLowerCase(Locale.ROOT), count, seed, dataDir, batch, reset, out);
        }

        private static String value(String[] args, int i, String option) {
            if (i >= args.length) {
                throw new IllegalArgumentException(option + " 다음에 값이 필요합니다");
            }
            return args[i];
        }

        private static long parseLong(String raw, String option) {
            try {
                return Long.parseLong(raw);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException(option + " 값은 정수여야 합니다: '" + raw + "'");
            }
        }

        private static long positiveLong(String raw, String option) {
            long value = parseLong(raw, option);
            if (value <= 0) {
                throw new IllegalArgumentException(option + " 값은 1 이상이어야 합니다: " + value);
            }
            return value;
        }
    }

    /** @param elapsedNanos 생성+실행 전체 시간 */
    record Stats(long rows, long elapsedNanos) {
        double seconds() {
            return elapsedNanos / 1e9;
        }

        double rowsPerSecond() {
            return rows / Math.max(seconds(), 1e-9);
        }
    }

    private DataGenerator() {
    }

    /** @return 종료 코드 (0 성공, 1 실행 오류, 2 사용법 오류) */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        Options options;
        try {
            options = Options.parse(args);
        } catch (IllegalArgumentException e) {
            err.println("ERROR: " + e.getMessage());
            err.println(USAGE);
            return 2;
        }
        try {
            Stats stats = options.sqlOut() != null ? export(options, out) : generate(options, out);
            out.printf(Locale.ROOT, "완료: %,d rows, %.2f s, %,.0f rows/s%n",
                    stats.rows(), stats.seconds(), stats.rowsPerSecond());
            if (options.sqlOut() != null) {
                out.println("실행: java -jar mini-dbms.jar run " + options.sqlOut() + " --data " + options.dataDir());
            }
            return 0;
        } catch (DbException | IOException e) {
            err.println("ERROR: " + e.getMessage());
            return 1;
        }
    }

    /** INSERT SQL을 만들어 batchSize 문장씩 엔진에 넘긴다. */
    static Stats generate(Options options, PrintStream out) throws IOException {
        prepareTable(options);
        UserRowGenerator rows = new UserRowGenerator(options.table(), options.seed());
        // 배치 하나 분량의 SQL을 담을 버퍼를 재사용한다. 문장 하나가 ~70자라 1000문장이면 ~70KB다.
        StringBuilder sql = new StringBuilder(options.batchSize() * 80);
        long start = System.nanoTime();
        try (DatabaseEngine engine = new DatabaseEngine(options.dataDir())) {
            long n = 0;
            while (n < options.count()) {
                sql.setLength(0);
                long batchEnd = Math.min(options.count(), n + options.batchSize());
                long batchStart = n;
                while (n < batchEnd) {
                    rows.appendInsert(sql, ++n);
                }
                engine.execute(sql.toString());
                reportProgress(out, batchStart, n, options.count(), start);
            }
        }
        return new Stats(options.count(), System.nanoTime() - start);
    }

    /** 실행하지 않고 같은 SQL을 한 줄에 한 문장씩 파일로 쓴다. */
    static Stats export(Options options, PrintStream out) throws IOException {
        // 안내하는 run 명령이 바로 돌도록 데이터 디렉터리와 스키마는 준비해 둔다(.tbl은 건드리지 않는다).
        prepareSchema(options);
        UserRowGenerator rows = new UserRowGenerator(options.table(), options.seed());
        StringBuilder line = new StringBuilder(128);
        long start = System.nanoTime();
        try (BufferedWriter writer = Files.newBufferedWriter(options.sqlOut(), StandardCharsets.UTF_8)) {
            writer.write("-- generated: --table " + options.table() + " --count " + options.count()
                    + " --seed " + options.seed() + "\n");
            for (long n = 1; n <= options.count(); n++) {
                line.setLength(0);
                rows.appendInsert(line, n);
                writer.append(line).append('\n');
                reportProgress(out, n - 1, n, options.count(), start);
            }
        }
        return new Stats(options.count(), System.nanoTime() - start);
    }

    /** 진행 건수가 before에서 after로 늘면서 PROGRESS_EVERY의 배수를 넘었으면 한 줄 출력한다. */
    private static void reportProgress(PrintStream out, long before, long after, long total, long startNanos) {
        if (after / PROGRESS_EVERY > before / PROGRESS_EVERY) {
            out.printf(Locale.ROOT, "  %,d / %,d (%.0f%%) %.1f s%n",
                    after, total, 100.0 * after / total, (System.nanoTime() - startNanos) / 1e9);
        }
    }

    /** email이 행 번호로 고유하려면 테이블이 비어 있어야 하므로, 데이터가 있으면 --reset을 요구한다. */
    private static void prepareTable(Options options) throws IOException {
        prepareSchema(options);
        Path data = options.dataDir().resolve(options.table() + ".tbl");
        if (options.reset()) {
            Files.deleteIfExists(data);
        } else if (Files.exists(data) && Files.size(data) > 0) {
            throw new DbException("테이블 '" + options.table() + "'에 이미 데이터가 있습니다 (" + data
                    + "). 지우고 다시 만들려면 --reset을 주세요");
        }
    }

    /** 스키마가 없으면 기본 스키마로 만들고, 있으면 name·age·email 컬럼이 있는지 본다. */
    private static void prepareSchema(Options options) throws IOException {
        Files.createDirectories(options.dataDir());
        SchemaLoader loader = new SchemaLoader(options.dataDir());
        Path schemaPath = loader.schemaPath(options.table());
        if (!Files.exists(schemaPath)) {
            Files.writeString(schemaPath, DEFAULT_SCHEMA + "\n", StandardCharsets.UTF_8);
        }
        Schema schema = loader.load(options.table());
        for (String column : REQUIRED_COLUMNS) {
            if (!schema.hasColumn(column)) {
                throw new DbException("테이블 '" + options.table() + "'에 '" + column + "' 컬럼이 없습니다. 생성기는 "
                        + DEFAULT_SCHEMA + " 형태의 스키마가 필요합니다: " + schemaPath);
            }
        }
    }
}
