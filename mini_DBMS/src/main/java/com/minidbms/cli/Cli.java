package com.minidbms.cli;

import com.minidbms.common.DbException;
import com.minidbms.engine.DatabaseEngine;
import com.minidbms.engine.QueryResult;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.Locale;

/**
 * run/repl 모드의 실행부. 문장을 하나씩 엔진에 넘기고 결과나 오류를 출력한다.
 */
final class Cli implements Closeable {
    static final String PROMPT = "mini-dbms> ";
    static final String CONTINUE_PROMPT = "        -> ";

    private final DatabaseEngine engine;
    private final PrintStream out;
    // 종료 훅(Ctrl+C)이 문장 실행 도중에 파일을 닫지 않도록 실행과 close를 같은 락으로 묶는다.
    private final Object lock = new Object();
    private boolean closed;
    private int errorCount;

    Cli(Path dataDir, PrintStream out) {
        this.engine = new DatabaseEngine(dataDir);
        this.out = out;
    }

    int errorCount() {
        return errorCount;
    }

    /** 스크립트 전체를 실행한다. 마지막 문장은 세미콜론이 없어도 실행한다. */
    void runScript(String text) {
        StatementSplitter.Split split = StatementSplitter.split(text);
        for (StatementSplitter.Piece piece : split.statements()) {
            execute(piece, true);
        }
        if (split.unfinished() != null) {
            execute(split.unfinished(), true);
        }
    }

    /** 세미콜론이 나올 때까지 줄을 모았다가 완성된 문장만 실행한다. 빈 버퍼에서 .exit 또는 EOF면 끝난다. */
    void repl(BufferedReader in) throws IOException {
        String buffer = "";
        out.print(PROMPT);
        out.flush();
        String line;
        while ((line = in.readLine()) != null) {
            if (buffer.isBlank() && line.strip().equalsIgnoreCase(".exit")) {
                break;
            }
            StatementSplitter.Split split = StatementSplitter.split(buffer + line + "\n");
            for (StatementSplitter.Piece piece : split.statements()) {
                execute(piece, false);
            }
            // 세미콜론 뒤에 공백·주석만 남았으면 버리고, 아직 끝나지 않은 문장이면 다음 줄과 이어 붙인다.
            buffer = split.unfinished() == null ? "" : split.remainder();
            out.print(buffer.isEmpty() ? PROMPT : CONTINUE_PROMPT);
            out.flush();
        }
        out.println("Bye");
    }

    private void execute(StatementSplitter.Piece piece, boolean showLine) {
        synchronized (lock) {
            if (closed) {
                return;
            }
            try {
                for (QueryResult result : engine.execute(piece.sql())) {
                    print(result);
                }
            } catch (DbException e) {
                errorCount++;
                out.println("ERROR: " + (showLine ? "[line " + piece.line() + "] " : "") + e.getMessage());
            }
        }
    }

    private void print(QueryResult result) {
        if (result.type() == QueryResult.Type.INSERT) {
            out.println(rowCount(result.affectedRows()) + " inserted (id=" + result.rows().get(0).get(0) + ")");
            return;
        }
        out.print(TableFormatter.format(result.columns(), result.rows()));
        if (result.type() == QueryResult.Type.SELECT) {
            out.println(rowCount(result.affectedRows()) + " (" + result.accessPath().label() + ", "
                    + formatMs(result.elapsedMs()) + " ms)" + (result.truncated() ? " — 최대 행 수에서 잘림" : ""));
        }
    }

    /** 1ms 미만도 0으로 뭉개지지 않게 소수로 보여준다. 로케일에 따라 소수점이 ','가 되지 않게 ROOT로 고정한다. */
    static String formatMs(double ms) {
        if (ms >= 100) {
            return String.format(Locale.ROOT, "%.0f", ms);
        }
        return ms >= 1 ? String.format(Locale.ROOT, "%.1f", ms) : String.format(Locale.ROOT, "%.3f", ms);
    }

    static String rowCount(long n) {
        return n + (n == 1 ? " row" : " rows");
    }

    /** 열린 테이블 파일의 버퍼를 모두 내려쓰고 닫는다. 여러 번 불러도 안전하다. */
    @Override
    public void close() {
        synchronized (lock) {
            if (closed) {
                return;
            }
            closed = true;
            engine.close();
            out.flush();
        }
    }
}
