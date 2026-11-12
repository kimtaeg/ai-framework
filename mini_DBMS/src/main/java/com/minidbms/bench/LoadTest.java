package com.minidbms.bench;

import com.minidbms.server.ApiServer;
import com.minidbms.server.ServerConfig;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * API 서버 부하 테스트: 동시 클라이언트 수별 TPS와 지연 시간.
 *
 * <pre>
 * java -jar mini-dbms.jar loadtest [--url http://localhost:8080] [--data ./data] [--table users]
 *                                  [--clients 1,4,16,64] [--duration 5] [--warmup 2]
 *                                  [--workload lookup|insert|mixed] [--server-threads 8] [--out loadtest-result.md]
 * </pre>
 *
 * --url이 없으면 --data 폴더로 서버를 같은 프로세스에 띄워서 잰다(네트워크는 localhost 루프백).
 * 클라이언트 하나는 응답을 받은 뒤 다음 요청을 보내는 닫힌 루프(closed loop)다. 그래서 TPS ≈ 클라이언트 수 / 평균 지연이고,
 * 클라이언트가 워커 수보다 많아지면 TPS는 더 늘지 않고 지연(큐 대기)만 늘어난다.
 */
public final class LoadTest {
    static final String USAGE = """
            사용법:
              java -jar mini-dbms.jar loadtest [--url http://localhost:8080] [--data ./data] [--table users]
                                               [--clients 1,4,16,64] [--duration 5] [--warmup 2]
                                               [--workload lookup|insert|mixed] [--server-threads 8] [--out file.md]
              --url        이미 떠 있는 서버. 없으면 --data로 서버를 이 프로세스에 띄운다
              --workload   lookup: WHERE id = 무작위 (기본) · insert: INSERT · mixed: lookup 80% + insert 20%
              --duration   클라이언트 수마다 잴 시간(초)""";

    enum Workload { LOOKUP, INSERT, MIXED }

    record Options(String url, Path dataDir, String table, int[] clients, int durationSeconds, int warmupSeconds,
                   Workload workload, int serverThreads, Path out) {
        static Options parse(String[] args) {
            String url = null;
            Path dataDir = Path.of("data");
            String table = "users";
            int[] clients = {1, 4, 16, 64};
            int duration = 5;
            int warmup = 2;
            Workload workload = Workload.LOOKUP;
            int serverThreads = 8;
            Path out = null;
            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                // 모든 옵션이 값을 하나씩 받는다.
                String value = i + 1 < args.length ? args[i + 1] : null;
                switch (arg) {
                    case "--url" -> url = require(value, arg);
                    case "--data" -> dataDir = Path.of(require(value, arg));
                    case "--table" -> table = require(value, arg);
                    case "--clients" -> clients = parseClients(require(value, arg));
                    case "--duration" -> duration = positive(require(value, arg), arg);
                    case "--warmup" -> warmup = nonNegative(require(value, arg), arg);
                    case "--workload" -> workload = parseWorkload(require(value, arg));
                    case "--server-threads" -> serverThreads = positive(require(value, arg), arg);
                    case "--out" -> out = Path.of(require(value, arg));
                    default -> throw new IllegalArgumentException("알 수 없는 인자 '" + arg + "'");
                }
                i++;
            }
            return new Options(url, dataDir, table.toLowerCase(Locale.ROOT), clients, duration, warmup, workload, serverThreads, out);
        }

        private static String require(String value, String option) {
            if (value == null) {
                throw new IllegalArgumentException(option + " 다음에 값이 필요합니다");
            }
            return value;
        }

        private static int[] parseClients(String raw) {
            try {
                int[] clients = Arrays.stream(raw.split(",")).map(String::trim).mapToInt(Integer::parseInt).toArray();
                if (clients.length == 0 || Arrays.stream(clients).anyMatch(c -> c < 1)) {
                    throw new IllegalArgumentException("--clients는 1 이상의 정수 목록이어야 합니다: " + raw);
                }
                return clients;
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("--clients는 쉼표로 구분한 정수여야 합니다: " + raw);
            }
        }

        private static Workload parseWorkload(String raw) {
            try {
                return Workload.valueOf(raw.toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("--workload는 lookup, insert, mixed 중 하나여야 합니다: " + raw);
            }
        }

        private static int positive(String raw, String option) {
            int value = nonNegative(raw, option);
            if (value < 1) {
                throw new IllegalArgumentException(option + " 값은 1 이상이어야 합니다: " + value);
            }
            return value;
        }

        private static int nonNegative(String raw, String option) {
            try {
                int value = Integer.parseInt(raw);
                if (value < 0) {
                    throw new IllegalArgumentException(option + " 값은 0 이상이어야 합니다: " + value);
                }
                return value;
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException(option + " 값은 정수여야 합니다: '" + raw + "'");
            }
        }
    }

    /** 클라이언트 수 하나의 결과. 지연은 ms */
    record Level(int clients, long requests, long errors, long busy, double seconds, Benchmark.Summary latency) {
        double tps() {
            return requests / seconds;
        }
    }

    private LoadTest() {
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
        ApiServer embedded = null;
        try {
            String baseUrl = options.url();
            if (baseUrl == null) {
                if (!Files.isDirectory(options.dataDir())) {
                    err.println("ERROR: 데이터 디렉터리가 없습니다: " + options.dataDir().toAbsolutePath());
                    return 2;
                }
                embedded = new ApiServer(new ServerConfig(0, options.serverThreads(), options.serverThreads(), 10_000,
                        options.dataDir()), new PrintStream(OutputStream.nullOutputStream()));
                embedded.start();
                baseUrl = "http://localhost:" + embedded.port();
            }
            Runner runner = new Runner(baseUrl.replaceAll("/+$", ""), options);
            runner.prepare(out);

            if (options.warmupSeconds() > 0) {
                out.printf(Locale.ROOT, "워밍업 %d초 (클라이언트 4)%n", options.warmupSeconds());
                runner.runLevel(4, options.warmupSeconds());
            }
            List<Level> levels = new ArrayList<>();
            for (int clients : options.clients()) {
                Level level = runner.runLevel(clients, options.durationSeconds());
                levels.add(level);
                out.printf(Locale.ROOT, "  클라이언트 %3d: %,10.0f TPS, p50 %s ms, p99 %s ms%n",
                        clients, level.tps(), fmt(level.latency().p50()), fmt(level.latency().p99()));
            }
            String report = report(options, baseUrl, embedded != null, runner.maxId, levels);
            out.println();
            out.print(report);
            if (options.out() != null) {
                Files.writeString(options.out(), report, StandardCharsets.UTF_8);
                out.println("\n결과 저장: " + options.out().toAbsolutePath());
            }
            return 0;
        } catch (IOException | RuntimeException e) {
            err.println("ERROR: " + e.getMessage());
            return 1;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return 1;
        } finally {
            if (embedded != null) {
                embedded.stop(0);
            }
        }
    }

    /** HTTP 호출과 측정 */
    static final class Runner {
        private final String baseUrl;
        private final Options options;
        private final HttpClient client;
        long maxId;

        Runner(String baseUrl, Options options) {
            this.baseUrl = baseUrl;
            this.options = options;
            // 클라이언트 스레드가 직접 send(동기)하므로 HttpClient의 내부 executor는 응답 처리에만 쓰인다.
            this.client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                    .connectTimeout(Duration.ofSeconds(5)).build();
        }

        /** lookup이 필요하면 존재하는 최대 id를 찾는다. */
        void prepare(PrintStream out) throws IOException, InterruptedException {
            int health = send(HttpRequest.newBuilder(URI.create(baseUrl + "/health")).GET().build());
            if (health != 200) {
                throw new IllegalStateException("서버 /health가 " + health + "입니다: " + baseUrl);
            }
            if (options.workload() != Workload.INSERT) {
                maxId = findMaxId();
                if (maxId == 0) {
                    throw new IllegalStateException("테이블 '" + options.table() + "'이(가) 비어 있어 lookup을 잴 수 없습니다. "
                            + "generate로 데이터를 만들거나 --workload insert를 쓰세요");
                }
                out.printf(Locale.ROOT, "대상: %s, 테이블 %s (id 1..%,d), 부하 %s%n", baseUrl, options.table(), maxId,
                        options.workload().name().toLowerCase(Locale.ROOT));
            } else {
                out.printf(Locale.ROOT, "대상: %s, 테이블 %s, 부하 insert%n", baseUrl, options.table());
            }
        }

        /**
         * id가 1부터 빈틈없이 이어져 있다고 보고(generate로 만든 데이터) 존재하는 가장 큰 id를 찾는다.
         * 1, 2, 4, 8, ...로 넘치는 지점을 찾은 뒤 이진 탐색한다. 요청 수는 O(log n)이다.
         */
        long findMaxId() throws IOException, InterruptedException {
            if (!exists(1)) {
                return 0;
            }
            long low = 1;
            long high = 2;
            while (exists(high)) {
                low = high;
                high *= 2;
            }
            while (high - low > 1) {   // 불변식: low는 있음, high는 없음
                long mid = low + (high - low) / 2;
                if (exists(mid)) {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            return low;
        }

        private boolean exists(long id) throws IOException, InterruptedException {
            HttpResponse<String> response = client.send(query("SELECT id FROM " + options.table() + " WHERE id = " + id),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IllegalStateException("조회 실패 " + response.statusCode() + ": " + response.body());
            }
            return !response.body().contains("\"rows\":[]");
        }

        Level runLevel(int clients, int seconds) throws InterruptedException {
            long[][] latencies = new long[clients][];
            int[] counts = new int[clients];
            AtomicLong errors = new AtomicLong();
            AtomicLong busy = new AtomicLong();
            CountDownLatch gate = new CountDownLatch(1);
            CountDownLatch done = new CountDownLatch(clients);
            long[] window = new long[2];

            List<Thread> threads = new ArrayList<>();
            for (int c = 0; c < clients; c++) {
                int me = c;
                Thread thread = new Thread(() -> {
                    long[] mine = new long[1024];
                    int n = 0;
                    try {
                        gate.await();
                        long deadline = window[1];
                        while (System.nanoTime() < deadline) {
                            HttpRequest request = nextRequest();
                            long start = System.nanoTime();
                            int status;
                            try {
                                status = send(request);
                            } catch (IOException e) {
                                status = -1;
                            }
                            long elapsed = System.nanoTime() - start;
                            if (status == 503) {
                                busy.incrementAndGet();
                            } else if (status != 200) {
                                errors.incrementAndGet();
                            }
                            if (n == mine.length) {
                                mine = Arrays.copyOf(mine, n * 2);
                            }
                            mine[n++] = elapsed;
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        latencies[me] = mine;
                        counts[me] = n;
                        done.countDown();
                    }
                }, "load-client-" + c);
                threads.add(thread);
                thread.start();
            }
            window[0] = System.nanoTime();
            window[1] = window[0] + seconds * 1_000_000_000L;
            gate.countDown();
            done.await();
            double elapsed = (System.nanoTime() - window[0]) / 1e9;

            int total = Arrays.stream(counts).sum();
            long[] all = new long[total];
            int at = 0;
            for (int c = 0; c < clients; c++) {
                System.arraycopy(latencies[c], 0, all, at, counts[c]);
                at += counts[c];
            }
            Benchmark.Summary summary = total == 0 ? new Benchmark.Summary(0, 0, 0, 0, 0, 0) : Benchmark.Summary.of(all);
            return new Level(clients, total, errors.get(), busy.get(), elapsed, summary);
        }

        private HttpRequest nextRequest() {
            ThreadLocalRandom random = ThreadLocalRandom.current();
            boolean insert = switch (options.workload()) {
                case INSERT -> true;
                case LOOKUP -> false;
                case MIXED -> random.nextInt(100) < 20;
            };
            if (insert) {
                long n = random.nextLong(1_000_000_000L);
                return query("INSERT INTO " + options.table() + " (name, age, email) VALUES ('load', "
                        + (1 + random.nextInt(100)) + ", 'load" + n + "@test.com')");
            }
            return query("SELECT * FROM " + options.table() + " WHERE id = " + (1 + random.nextLong(maxId)));
        }

        private HttpRequest query(String sql) {
            // SQL에 큰따옴표·역슬래시가 없으므로 JSON 이스케이프 없이 그대로 넣는다.
            return HttpRequest.newBuilder(URI.create(baseUrl + "/query"))
                    .header("Content-Type", "application/json")
                    .timeout(Duration.ofSeconds(30))
                    .POST(HttpRequest.BodyPublishers.ofString("{\"sql\":\"" + sql + "\"}", StandardCharsets.UTF_8))
                    .build();
        }

        private int send(HttpRequest request) throws IOException, InterruptedException {
            return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
        }
    }

    static String report(Options options, String url, boolean embedded, long maxId, List<Level> levels) {
        StringBuilder md = new StringBuilder();
        md.append("# Mini DBMS API 부하 테스트\n\n");
        md.append(String.format(Locale.ROOT, "- 대상: %s%s · 부하: %s · 테이블 `%s`%s%n", url,
                embedded ? " (같은 프로세스에 띄운 서버, 워커 " + options.serverThreads() + ")" : "",
                options.workload().name().toLowerCase(Locale.ROOT), options.table(),
                maxId > 0 ? String.format(Locale.ROOT, " (id 1..%,d)", maxId) : ""));
        md.append(String.format(Locale.ROOT, "- 클라이언트 수마다 %d초 측정 (워밍업 %d초). 클라이언트는 응답을 받은 뒤 다음 요청을 보낸다%n",
                options.durationSeconds(), options.warmupSeconds()));
        md.append(String.format(Locale.ROOT, "- Java %s · %s %s · CPU %d개%n%n", System.getProperty("java.version"),
                System.getProperty("os.name"), System.getProperty("os.arch"), Runtime.getRuntime().availableProcessors()));
        md.append("| 클라이언트 | 요청 수 | TPS | 평균 (ms) | p50 (ms) | p99 (ms) | 최대 (ms) | 503 | 기타 오류 |\n");
        md.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n");
        for (Level level : levels) {
            Benchmark.Summary s = level.latency();
            md.append(String.format(Locale.ROOT, "| %d | %,d | %,.0f | %s | %s | %s | %s | %,d | %,d |%n",
                    level.clients(), level.requests(), level.tps(), fmt(s.mean()), fmt(s.p50()), fmt(s.p99()), fmt(s.max()),
                    level.busy(), level.errors()));
        }
        return md.toString();
    }

    static String fmt(double ms) {
        return Benchmark.Report.fmt(ms);
    }
}
