package com.minidbms.server;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ServeCommandTest {
    @Test
    void 기본값과_옵션을_해석한다() {
        assertEquals(new ServerConfig(8080, 8, 8, 1000, Path.of("data")), ServeCommand.parse(new String[0]));
        assertEquals(new ServerConfig(9000, 4, 16, 50, Path.of("/tmp/d"), 500, 3, 250), ServeCommand.parse(new String[]{
                "--port", "9000", "--threads", "4", "--max-threads", "16", "--queue", "50", "--data", "/tmp/d",
                "--max-rows", "500", "--grace", "3", "--query-timeout", "250"}));
        assertEquals(0, ServeCommand.parse(new String[]{"--query-timeout", "0"}).queryTimeoutMillis(), "0이면 끔");
        assertEquals(5_000, ServeCommand.parse(new String[0]).queryTimeoutMillis());
    }

    @Test
    void 잘못된_옵션은_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--threads", "0"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--threads", "8", "--max-threads", "4"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--port", "70000"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--queue"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--what"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--max-rows", "0"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--grace", "-1"}));
        assertThrows(IllegalArgumentException.class, () -> ServeCommand.parse(new String[]{"--query-timeout", "-1"}));
    }

    @Test
    void 사용법_오류와_없는_데이터_디렉터리는_종료코드_2() {
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        PrintStream errStream = new PrintStream(err, true, StandardCharsets.UTF_8);
        PrintStream out = new PrintStream(new ByteArrayOutputStream());
        assertEquals(2, ServeCommand.run(new String[]{"--bogus"}, out, errStream));
        assertEquals(2, ServeCommand.run(new String[]{"--data", "/nonexistent/mini-dbms"}, out, errStream));
        assertTrue(err.toString(StandardCharsets.UTF_8).contains("사용법"));
    }
}
