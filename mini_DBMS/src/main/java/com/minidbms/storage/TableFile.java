package com.minidbms.storage;

import com.minidbms.common.StorageException;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.function.Consumer;

/**
 * .tbl 파일 하나. 한 줄이 레코드 하나다(UTF-8, '\n'으로 끝남).
 *
 * <p>쓰기 스트림은 열어 둔 채로 버퍼에 모은다. 버퍼 내용이 디스크(OS)로 내려가는 시점은 아래 넷뿐이다.
 * <ol>
 *   <li>버퍼(64KB)가 가득 찼을 때 (BufferedOutputStream이 자동으로)</li>
 *   <li>{@link #flush()}를 호출했을 때. 엔진이 문장 하나를 끝낼 때마다 부른다.</li>
 *   <li>{@link #scan}을 시작할 때. 방금 append한 레코드가 조회에서 빠지지 않게 하려고.</li>
 *   <li>{@link #close()}할 때</li>
 * </ol>
 * flush는 OS 페이지 캐시까지만 보낸다. 전원이 나가도 남는 것(fsync)까지는 보장하지 않는다.
 *
 * <p>스레드 안전하지 않다. 동시 접근은 상위(테이블 락)에서 막는다.
 */
public final class TableFile implements Closeable {
    static final int BUFFER_SIZE = 64 * 1024;

    private final Path path;
    private final OutputStream out;
    // 디스크에 내려간 바이트 + 버퍼에 쌓인 바이트. 다음 줄이 시작할 offset이다.
    private long endOffset;
    private boolean closed;

    public TableFile(Path path) {
        this.path = path;
        try {
            // CREATE + APPEND: 파일이 없으면 빈 파일로 만들고, 있으면 기존 내용 뒤에 이어 쓴다.
            this.out = new BufferedOutputStream(Files.newOutputStream(path,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE), BUFFER_SIZE);
            this.endOffset = Files.size(path);
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 열 수 없습니다: " + path, e);
        }
    }

    public Path path() {
        return path;
    }

    /** 다음에 append될 줄이 시작할 byte offset (= 버퍼를 포함한 논리적 파일 크기) */
    public long size() {
        return endOffset;
    }

    /**
     * 줄 하나를 파일 끝에 쓴다. 줄바꿈은 여기서 붙인다.
     *
     * @return 그 줄이 시작된 byte offset. 문자 수가 아니라 UTF-8 바이트 기준이다.
     */
    public long append(String line) {
        ensureOpen();
        if (line.indexOf('\n') >= 0 || line.indexOf('\r') >= 0) {
            throw new StorageException("레코드 한 줄에 줄바꿈 문자가 들어 있습니다 (RecordCodec으로 인코딩해야 합니다): " + path);
        }
        byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
        long offset = endOffset;
        try {
            out.write(bytes);
        } catch (IOException e) {
            throw new StorageException("테이블 파일에 쓸 수 없습니다: " + path, e);
        }
        endOffset += bytes.length;
        return offset;
    }

    public void flush() {
        ensureOpen();
        try {
            out.flush();
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 디스크에 반영할 수 없습니다: " + path, e);
        }
    }

    /** 파일의 처음부터 끝까지 한 줄씩 넘긴다(줄바꿈 제외). */
    public void scan(Consumer<String> consumer) {
        flush();
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                consumer.accept(line);
            }
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 읽을 수 없습니다: " + path, e);
        }
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        try {
            out.close(); // BufferedOutputStream.close()가 남은 버퍼를 먼저 flush한다.
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 닫는 중 오류가 났습니다: " + path, e);
        }
    }

    private void ensureOpen() {
        if (closed) {
            throw new StorageException("이미 닫힌 테이블 파일입니다: " + path);
        }
    }
}
