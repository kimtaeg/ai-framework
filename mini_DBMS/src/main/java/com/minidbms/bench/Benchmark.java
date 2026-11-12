package com.minidbms.bench;

import com.minidbms.common.DbException;
import com.minidbms.engine.AccessPath;
import com.minidbms.engine.DatabaseEngine;
import com.minidbms.engine.QueryResult;
import com.minidbms.index.BPlusTree;
import com.minidbms.storage.Table;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Random;

/**
 * 인덱스 조회 vs 선형 탐색 벤치마크.
 *
 * <pre>
 * java -jar mini-dbms.jar bench --table users [--queries 1000] [--scan-queries 5] [--warmup 100]
 *                               [--data ./data] [--out bench-result.md] [--seed 42]
 * </pre>
 *
 * 측정 항목(모두 DatabaseEngine.execute로 SQL을 실행해 잰다):
 * <ul>
 *   <li>A. WHERE id = ? — 인덱스 (INDEX_LOOKUP)</li>
 *   <li>B. WHERE id = ? — 인덱스 강제 OFF (FULL_SCAN)</li>
 *   <li>C. WHERE email = ? — 인덱스 없는 컬럼 (FULL_SCAN)</li>
 * </ul>
 * 대상 행은 파일의 앞(처음 1%), 중간(가운데 1%), 끝(마지막 1%)에서 나눠 고른다.
 *
 * <p>스캔 항목(B, C)은 쿼리 한 번이 파일 전체를 읽으므로(100만 건에서 1초 이상) --queries 대신
 * --scan-queries 횟수만 잰다. 1000번씩 재면 몇 시간이 걸린다.
 */
public final class Benchmark {
    static final String USAGE = """
            사용법:
              java -jar mini-dbms.jar bench --table users [--queries 1000] [--scan-queries 5] [--warmup 100]
                                            [--data ./data] [--out bench-result.md] [--seed 42]
              --queries       인덱스 조회(A)의 위치별 측정 횟수 (기본 1000)
              --scan-queries  전체 스캔(B, C)의 위치별 측정 횟수 (기본 5)
              --warmup        인덱스 조회의 위치별 워밍업 횟수 (기본 500, 스캔은 위치별 1회)""";

    enum Position {
        FRONT("앞"), MIDDLE("중간"), END("끝");

        final String label;

        Position(String label) {
            this.label = label;
        }
    }

    enum Item {
        A("A. id = ? (인덱스)", AccessPath.INDEX_LOOKUP, true),
        B("B. id = ? (인덱스 OFF)", AccessPath.FULL_SCAN, false),
        C("C. email = ? (선형 탐색)", AccessPath.FULL_SCAN, true);

        final String label;
        final AccessPath expectedPath;
        final boolean indexEnabled;

        Item(String label, AccessPath expectedPath, boolean indexEnabled) {
            this.label = label;
            this.expectedPath = expectedPath;
            this.indexEnabled = indexEnabled;
        }

        boolean isScan() {
            return expectedPath == AccessPath.FULL_SCAN;
        }
    }

    record Options(String table, int queries, int scanQueries, int warmup, Path dataDir, Path out, long seed) {
        static Options parse(String[] args) {
            String table = null;
            int queries = 1000;
            int scanQueries = 5;
            int warmup = 500;
            Path dataDir = Path.of("data");
            Path out = Path.of("bench-result.md");
            long seed = 42;
            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                switch (arg) {
                    case "--table" -> table = value(args, ++i, arg);
                    case "--queries" -> queries = intValue(value(args, ++i, arg), arg, 1);
                    case "--scan-queries" -> scanQueries = intValue(value(args, ++i, arg), arg, 1);
                    case "--warmup" -> warmup = intValue(value(args, ++i, arg), arg, 0);
                    case "--data" -> dataDir = Path.of(value(args, ++i, arg));
                    case "--out" -> out = Path.of(value(args, ++i, arg));
                    case "--seed" -> seed = intValue(value(args, ++i, arg), arg, Integer.MIN_VALUE);
                    default -> throw new IllegalArgumentException("알 수 없는 인자 '" + arg + "'");
                }
            }
            if (table == null) {
                throw new IllegalArgumentException("--table이 필요합니다");
            }
            return new Options(table.toLowerCase(Locale.ROOT), queries, scanQueries, warmup, dataDir, out, seed);
        }

        private static String value(String[] args, int i, String option) {
            if (i >= args.length) {
                throw new IllegalArgumentException(option + " 다음에 값이 필요합니다");
            }
            return args[i];
        }

        private static int intValue(String raw, String option, int min) {
            int value;
            try {
                value = Integer.parseInt(raw);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException(option + " 값은 정수여야 합니다: '" + raw + "'");
            }
            if (value < min) {
                throw new IllegalArgumentException(option + " 값은 " + min + " 이상이어야 합니다: " + value);
            }
            return value;
        }
    }

    /** 대상 행 하나: id와 email */
    record Target(long id, String email) {
    }

    /** 측정값 요약(밀리초). 백분위는 nearest-rank 방식이다. */
    record Summary(int count, double mean, double p50, double p99, double min, double max) {
        static Summary of(long[] nanos) {
            long[] sorted = nanos.clone();
            Arrays.sort(sorted);
            double sum = 0;
            for (long n : sorted) {
                sum += n;
            }
            return new Summary(sorted.length, ms(sum / sorted.length), ms(percentile(sorted, 50)),
                    ms(percentile(sorted, 99)), ms(sorted[0]), ms(sorted[sorted.length - 1]));
        }

        static long percentile(long[] sorted, int p) {
            int rank = (int) Math.ceil(p / 100.0 * sorted.length);
            return sorted[Math.max(0, rank - 1)];
        }

        private static double ms(double nanos) {
            return nanos / 1e6;
        }
    }

    record Row(Item item, Position position, Summary summary) {
    }

    /** 테이블을 처음 열 때(파일 스캔 + 인덱스 재구성) 정보 */
    record LoadInfo(double loadMs, long fileBytes, BPlusTree.Stats index) {
    }

    record Result(Options options, LoadInfo load, List<Row> rows) {
    }

    private Benchmark() {
    }

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
            Result result = measure(options, out);
            String report = Report.markdown(result);
            out.println();
            out.print(report);
            Files.writeString(options.out(), report, StandardCharsets.UTF_8);
            out.println();
            out.println("결과 저장: " + options.out().toAbsolutePath());
            return 0;
        } catch (DbException | IOException e) {
            err.println("ERROR: " + e.getMessage());
            return 1;
        }
    }

    static Result measure(Options options, PrintStream out) {
        LoadInfo load;
        List<List<Target>> targets;
        // 1) 테이블을 직접 열어 재구성 시간과 트리 모양을 재고, 위치별 대상 행을 고른다.
        long start = System.nanoTime();
        try (Table table = Table.open(options.dataDir(), options.table())) {
            double loadMs = (System.nanoTime() - start) / 1e6;
            if (!table.schema().hasColumn("email")) {
                throw new DbException("테이블 '" + table.name() + "'에 email 컬럼이 없습니다. generate로 만든 테이블을 쓰세요");
            }
            load = new LoadInfo(loadMs, table.fileSize(), table.idIndexStats());
            if (load.index().keys() == 0) {
                throw new DbException("테이블 '" + table.name() + "'이(가) 비어 있습니다. 먼저 generate로 데이터를 만드세요");
            }
            targets = pickTargets(table, options);
        }
        out.printf(Locale.ROOT, "테이블 로딩(스캔 + 인덱스 재구성): %,.1f ms, %,d rows, 트리 높이 %d, 노드 %,d개%n",
                load.loadMs(), load.index().keys(), load.index().height(), load.index().nodes());

        // 2) 엔진으로 SQL을 실행하며 잰다. 첫 execute가 테이블을 여는 비용은 워밍업 전에 치르게 한다.
        List<Row> rows = new ArrayList<>();
        try (DatabaseEngine engine = new DatabaseEngine(options.dataDir())) {
            engine.execute("SELECT id FROM " + options.table() + " WHERE id = " + targets.get(0).get(0).id());
            for (Item item : Item.values()) {
                engine.setIndexEnabled(item.indexEnabled);
                // 세 위치를 모두 워밍업한 뒤에 잰다. 위치마다 따로 워밍업하면 처음 재는 위치만 JIT가 덜 된 상태로 측정된다.
                for (Position position : Position.values()) {
                    int warmup = item.isScan() ? 1 : options.warmup();
                    run(engine, options, item, targets.get(position.ordinal()), warmup);
                }
                for (Position position : Position.values()) {
                    int count = item.isScan() ? options.scanQueries() : options.queries();
                    Summary summary = Summary.of(run(engine, options, item, targets.get(position.ordinal()), count));
                    rows.add(new Row(item, position, summary));
                    out.printf(Locale.ROOT, "  %-24s %-4s 평균 %10.4f ms (%d회)%n",
                            item.label, position.label, summary.mean(), summary.count());
                }
            }
            engine.setIndexEnabled(true);
        }
        return new Result(options, load, rows);
    }

    /** 쿼리를 count번 실행하고 각 실행 시간(ns)을 돌려준다. */
    private static long[] run(DatabaseEngine engine, Options options, Item item, List<Target> pool, int count) {
        long[] nanos = new long[count];
        for (int i = 0; i < count; i++) {
            Target target = pool.get(i % pool.size());
            String sql = item == Item.C
                    ? "SELECT * FROM " + options.table() + " WHERE email = '" + target.email().replace("'", "''") + "'"
                    : "SELECT * FROM " + options.table() + " WHERE id = " + target.id();
            long start = System.nanoTime();
            QueryResult result = engine.execute(sql).get(0);
            long elapsed = System.nanoTime() - start;
            verify(item, result, target, sql);
            nanos[i] = elapsed;
        }
        return nanos;
    }

    /** 잘못 잰 숫자를 내지 않도록, 의도한 경로로 의도한 행을 찾았는지 매번 확인한다. */
    private static void verify(Item item, QueryResult result, Target target, String sql) {
        if (result.accessPath() != item.expectedPath) {
            throw new DbException("실행 경로가 예상(" + item.expectedPath + ")과 다릅니다: " + result.accessPath() + " — " + sql);
        }
        if (result.rows().isEmpty() || !Long.valueOf(target.id()).equals(result.rows().get(0).get(0))) {
            throw new DbException("대상 행(id=" + target.id() + ")을 찾지 못했습니다: " + sql);
        }
    }

    /**
     * 파일 순서 기준으로 앞(처음 1%)·중간(가운데 1%)·끝(마지막 1%) 구간에서 대상을 무작위로 고른다.
     * 선형 탐색은 파일 순서대로 읽으므로 "위치"는 id가 아니라 파일 안의 순서로 정한다.
     */
    private static List<List<Target>> pickTargets(Table table, Options options) {
        long rows = table.idIndexStats().keys();
        if (rows > Integer.MAX_VALUE) {
            throw new DbException("벤치마크는 " + Integer.MAX_VALUE + "행 이하만 지원합니다");
        }
        long[] idsInFileOrder = new long[(int) rows];
        int idColumn = table.idColumn();
        int[] next = {0};
        table.scan(record -> idsInFileOrder[next[0]++] = (Long) record[idColumn]);

        int n = idsInFileOrder.length;
        int window = Math.max(1, n / 100);
        int poolSize = Math.min(window, 200);
        int emailColumn = table.schema().indexOf("email");
        Random random = new Random(options.seed());
        List<List<Target>> result = new ArrayList<>();
        for (Position position : Position.values()) {
            int from = switch (position) {
                case FRONT -> 0;
                case MIDDLE -> Math.max(0, n / 2 - window / 2);
                case END -> n - window;
            };
            List<Target> pool = new ArrayList<>(poolSize);
            for (int i = 0; i < poolSize; i++) {
                long id = idsInFileOrder[from + random.nextInt(window)];
                Object email = table.findById(id).orElseThrow()[emailColumn];
                if (!(email instanceof String s)) {
                    throw new DbException("id " + id + "의 email이 NULL입니다. email이 모두 채워진 테이블이 필요합니다");
                }
                pool.add(new Target(id, s));
            }
            result.add(pool);
        }
        return result;
    }

    /** bench-result.md 본문 */
    static final class Report {
        private Report() {
        }

        static String markdown(Result result) {
            Options o = result.options();
            LoadInfo load = result.load();
            BPlusTree.Stats index = load.index();
            StringBuilder md = new StringBuilder();
            md.append("# Mini DBMS 벤치마크\n\n");
            md.append(String.format(Locale.ROOT, "- 실행: %s · Java %s · %s %s%n",
                    LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")),
                    System.getProperty("java.version"), System.getProperty("os.name"), System.getProperty("os.arch")));
            md.append(String.format(Locale.ROOT, "- 테이블: `%s` · %,d rows · 데이터 파일 %.1f MB%n",
                    o.table(), index.keys(), load.fileBytes() / 1024.0 / 1024.0));
            md.append(String.format(Locale.ROOT, "- 측정 횟수(위치별): 인덱스 %,d회(워밍업 %,d) · 전체 스캔 %d회(워밍업 1). 항목마다 세 위치의 워밍업을 먼저 끝낸 뒤 잰다%n",
                    o.queries(), o.warmup(), o.scanQueries()));
            md.append("- 시간은 `DatabaseEngine.execute(sql)` 호출 전체(파싱 포함), 단위 ms\n\n");

            md.append("## 인덱스\n\n");
            md.append("| 항목 | 값 |\n|---|---|\n");
            md.append(String.format(Locale.ROOT, "| 재구성 시간 (테이블 로딩: 파일 스캔 + 디코딩 + 트리 삽입) | %,.1f ms |%n", load.loadMs()));
            md.append(String.format(Locale.ROOT, "| 키 수 | %,d |%n", index.keys()));
            md.append(String.format(Locale.ROOT, "| order | %d |%n", index.order()));
            md.append(String.format(Locale.ROOT, "| 트리 높이 | %d |%n", index.height()));
            md.append(String.format(Locale.ROOT, "| 노드 수 | %,d (내부 %,d · 리프 %,d) |%n%n",
                    index.nodes(), index.internalNodes(), index.leafNodes()));

            md.append("## 조회 시간\n\n");
            md.append("| 항목 | 위치 | 횟수 | 평균 | p50 | p99 | 최소 | 최대 |\n");
            md.append("|---|---|---:|---:|---:|---:|---:|---:|\n");
            for (Row row : result.rows()) {
                Summary s = row.summary();
                md.append(String.format(Locale.ROOT, "| %s | %s | %,d | %s | %s | %s | %s | %s |%n",
                        row.item().label, row.position().label, s.count(),
                        fmt(s.mean()), fmt(s.p50()), fmt(s.p99()), fmt(s.min()), fmt(s.max())));
            }
            md.append('\n');
            md.append("## 해석\n\n").append(interpretation(result)).append('\n');
            return md.toString();
        }

        static String interpretation(Result result) {
            double a = average(result, Item.A);
            double b = average(result, Item.B);
            double c = average(result, Item.C);
            BPlusTree.Stats index = result.load().index();
            return String.format(Locale.ROOT,
                    "인덱스 조회(A)는 평균 %s ms로, 높이 %d인 B+ 트리를 루트에서 리프까지 %d개 노드만 이진 탐색하며 내려간 뒤 "
                            + "그 offset의 한 줄만 읽으므로 O(log n)이고 대상이 파일의 앞·중간·끝 어디에 있든 시간이 거의 같다. "
                            + "인덱스를 끈 id 조회(B, 평균 %s ms)와 email 조회(C, 평균 %s ms)는 %,d행을 모두 읽고 디코딩해 비교하는 "
                            + "O(n) 전체 스캔이라 A보다 약 %,.0f배 / %,.0f배 느리다. "
                            + "선형 탐색인데도 앞·중간·끝의 차이가 작은 것은 엔진이 email이나 id의 유일성을 모르기 때문에 "
                            + "첫 일치 행을 찾은 뒤에도 파일 끝까지 읽기 때문이며, 그래서 스캔 비용은 대상 위치가 아니라 테이블 크기 n에 비례한다. "
                            + "행 수가 10배가 되면 A는 트리 높이가 많아야 한 단계 늘어나는 정도지만 B·C는 그대로 10배가 된다.",
                    fmt(a), index.height(), index.height(), fmt(b), fmt(c), index.keys(), b / a, c / a);
        }

        private static double average(Result result, Item item) {
            return result.rows().stream().filter(r -> r.item() == item).mapToDouble(r -> r.summary().mean()).average().orElse(0);
        }

        static String fmt(double ms) {
            if (ms >= 100) {
                return String.format(Locale.ROOT, "%,.1f", ms);
            }
            return ms >= 1 ? String.format(Locale.ROOT, "%.2f", ms) : String.format(Locale.ROOT, "%.4f", ms);
        }
    }
}
