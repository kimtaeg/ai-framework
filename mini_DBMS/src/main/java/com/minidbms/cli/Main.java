package com.minidbms.cli;

import com.minidbms.bench.Benchmark;
import com.minidbms.bench.DataGenerator;
import com.minidbms.bench.LoadTest;
import com.minidbms.server.ServeCommand;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * <pre>
 * java -jar mini-dbms.jar run &lt;file.sql&gt; [--data ./data]
 * java -jar mini-dbms.jar repl [--data ./data]
 * </pre>
 * 종료 코드: 0 성공, 1 실패한 문장이 있음, 2 사용법·파일 오류
 */
public final class Main {
    static final int OK = 0;
    static final int STATEMENT_ERROR = 1;
    static final int USAGE_ERROR = 2;

    static final String USAGE = """
            사용법:
              java -jar mini-dbms.jar run <file.sql> [--data ./data]
              java -jar mini-dbms.jar repl [--data ./data]
              java -jar mini-dbms.jar generate --table users --count 1000000 [--seed 42] [--data ./data]
              java -jar mini-dbms.jar bench --table users [--queries 1000] [--data ./data]
              java -jar mini-dbms.jar serve [--port 8080] [--threads 8] [--queue 1000] [--data ./data]
              java -jar mini-dbms.jar loadtest [--url http://localhost:8080] [--clients 1,4,16,64] [--duration 5]""";

    private Main() {
    }

    public static void main(String[] args) {
        int code = run(args, System.in, System.out, System.err);
        if (code != OK) {
            System.exit(code);
        }
    }

    /** System.exit 없이 종료 코드만 돌려줘서 테스트에서 그대로 부를 수 있게 한다. */
    static int run(String[] args, InputStream in, PrintStream out, PrintStream err) {
        if (args.length > 0 && args[0].equals("generate")) {
            // 생성기는 옵션이 많아서 인자 해석을 bench 패키지에 맡긴다.
            return DataGenerator.run(Arrays.copyOfRange(args, 1, args.length), out, err);
        }
        if (args.length > 0 && args[0].equals("bench")) {
            return Benchmark.run(Arrays.copyOfRange(args, 1, args.length), out, err);
        }
        if (args.length > 0 && args[0].equals("loadtest")) {
            return LoadTest.run(Arrays.copyOfRange(args, 1, args.length), out, err);
        }
        if (args.length > 0 && args[0].equals("serve")) {
            return ServeCommand.run(Arrays.copyOfRange(args, 1, args.length), out, err);
        }
        Arguments parsed;
        try {
            parsed = Arguments.parse(args);
        } catch (IllegalArgumentException e) {
            err.println("ERROR: " + e.getMessage());
            err.println(USAGE);
            return USAGE_ERROR;
        }
        if (!Files.isDirectory(parsed.dataDir())) {
            err.println("ERROR: 데이터 디렉터리가 없습니다: " + parsed.dataDir().toAbsolutePath());
            return USAGE_ERROR;
        }

        String script = null;
        if (parsed.mode().equals("run")) {
            try {
                script = Files.readString(parsed.file(), StandardCharsets.UTF_8);
                // 메모장 등이 UTF-8 파일 앞에 붙이는 BOM은 SQL이 아니라 파일 인코딩 표식이므로 읽는 쪽에서 버린다.
                if (script.startsWith("\uFEFF")) {
                    script = script.substring(1);
                }
            } catch (NoSuchFileException e) {
                err.println("ERROR: SQL 파일이 없습니다: " + parsed.file().toAbsolutePath());
                return USAGE_ERROR;
            } catch (IOException e) {
                err.println("ERROR: SQL 파일을 읽을 수 없습니다: " + parsed.file() + " (" + e.getMessage() + ")");
                return USAGE_ERROR;
            }
        }

        Cli cli = new Cli(parsed.dataDir(), out);
        // 정상 종료는 finally에서, Ctrl+C·kill은 종료 훅에서 close한다. 어느 쪽이든 버퍼가 파일로 내려간다.
        Thread shutdownHook = new Thread(cli::close, "mini-dbms-shutdown");
        Runtime.getRuntime().addShutdownHook(shutdownHook);
        try {
            if (script != null) {
                cli.runScript(script);
            } else {
                cli.repl(new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)));
            }
        } catch (IOException e) {
            err.println("ERROR: 입력을 읽을 수 없습니다: " + e.getMessage());
        } finally {
            cli.close();
            removeHook(shutdownHook);
        }
        return cli.errorCount() == 0 ? OK : STATEMENT_ERROR;
    }

    private static void removeHook(Thread hook) {
        try {
            Runtime.getRuntime().removeShutdownHook(hook);
        } catch (IllegalStateException e) {
            // 이미 JVM이 종료 중이면 훅이 돌고 있으므로 그대로 둔다.
        }
    }

    record Arguments(String mode, Path file, Path dataDir) {
        static Arguments parse(String[] args) {
            if (args.length == 0) {
                throw new IllegalArgumentException("명령(run 또는 repl)이 필요합니다");
            }
            String mode = args[0];
            if (!mode.equals("run") && !mode.equals("repl")) {
                throw new IllegalArgumentException("알 수 없는 명령 '" + mode + "'");
            }
            Path file = null;
            Path dataDir = Path.of("data");
            for (int i = 1; i < args.length; i++) {
                String arg = args[i];
                if (arg.equals("--data")) {
                    if (i + 1 >= args.length) {
                        throw new IllegalArgumentException("--data 다음에 디렉터리 경로가 필요합니다");
                    }
                    dataDir = Path.of(args[++i]);
                } else if (arg.startsWith("--")) {
                    throw new IllegalArgumentException("알 수 없는 옵션 '" + arg + "'");
                } else if (mode.equals("run") && file == null) {
                    file = Path.of(arg);
                } else {
                    throw new IllegalArgumentException("불필요한 인자 '" + arg + "'");
                }
            }
            if (mode.equals("run") && file == null) {
                throw new IllegalArgumentException("run 명령에는 SQL 파일 경로가 필요합니다");
            }
            return new Arguments(mode, file, dataDir);
        }
    }
}
