package com.minidbms.storage;

import com.minidbms.common.StorageException;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.OptionalLong;
import java.util.function.Consumer;

/**
 * .tbl 파일 하나. 한 줄이 레코드 하나다(UTF-8, '\n'으로 끝남).
 *
 * <p>쓰기는 파일을 열어 둔 채 메모리 버퍼(64KB)에 모은다. BufferedOutputStream 대신 버퍼를 직접 들고 있는 이유는
 * {@link #readAt}과 {@link #scan}이 아직 디스크에 없는 줄도 읽어야 하기 때문이다. 버퍼가 디스크(OS)로 내려가는 시점은 아래 셋뿐이다.
 * <ol>
 *   <li>새 줄이 버퍼의 남은 공간에 들어가지 않을 때</li>
 *   <li>{@link #flush()}를 호출했을 때. 엔진이 execute 호출 하나를 끝낼 때마다 부른다.</li>
 *   <li>{@link #close()}할 때</li>
 * </ol>
 *
 * <p><b>읽기 메서드(readAt, scan, scanWithOffsets, size)는 상태를 바꾸지 않는다.</b> 그래서 상위의 읽기 락 아래에서
 * 여러 스레드가 동시에 불러도 된다(FileChannel의 위치 지정 읽기는 스레드 안전하다). 쓰기 메서드(append, flush, close)는
 * 쓰기 락처럼 혼자 실행되는 구간에서만 불러야 한다.
 * flush는 OS 페이지 캐시까지만 보낸다(fsync 없음).
 *
 * <p>버퍼는 항상 통째로 내려가고 줄은 통째로 버퍼에 들어가므로, 한 줄이 디스크와 버퍼에 걸쳐 나뉘는 일은 없다.
 * 그래서 readAt은 offset이 디스크 쪽인지 버퍼 쪽인지만 보면 된다.
 *
 * <p>디스크 쓰기가 한 번 실패하면 이 파일은 더 이상 쓰지 않는다(이후 호출은 StorageException).
 * 일부만 써졌을 수 있는 상태에서 계속 쓰면 메모리의 offset과 실제 파일이 어긋나기 때문이다. 재시작하면 파일 기준으로 다시 맞춰진다.
 *
 * <p>스스로 락을 잡지는 않는다. 읽기끼리는 동시에 돌아도 되고, 쓰기와의 배타는 상위(Table의 ReentrantReadWriteLock)가 보장한다.
 */
public final class TableFile implements Closeable {
    static final int BUFFER_SIZE = 64 * 1024;
    private static final int READ_CHUNK = 4096;

    /** scan이 줄마다 그 줄의 시작 offset과 내용을 넘긴다. */
    @FunctionalInterface
    public interface LineConsumer {
        void accept(long offset, String line);
    }

    private final Path path;
    private final FileChannel channel;
    private final byte[] buffer = new byte[BUFFER_SIZE];
    private int buffered;
    // 디스크에 내려간 바이트 수. 버퍼의 첫 바이트는 파일의 이 위치에 쓰일 것이다.
    private long flushedSize;
    // 열 때 '\n' 없이 끝나 있던 마지막 줄의 시작 offset. 없으면 -1
    private final long unterminatedLineOffset;
    private boolean closed;
    private boolean broken;

    public TableFile(Path path) {
        this.path = path;
        try {
            // READ + WRITE: 같은 채널로 위치를 지정해 읽고 쓴다. (APPEND는 READ와 같이 쓸 수 없다)
            this.channel = FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE);
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 열 수 없습니다: " + path, e);
        }
        try {
            this.flushedSize = channel.size();
            this.unterminatedLineOffset = terminateLastLine();
        } catch (IOException e) {
            closeQuietly();
            throw new StorageException("테이블 파일을 열 수 없습니다: " + path, e);
        }
    }

    /**
     * 기존 파일이 '\n'으로 끝나지 않으면(손으로 편집했거나 쓰다가 중단됨) 줄바꿈을 먼저 넣는다.
     * 그러지 않으면 다음 append가 마지막 레코드 뒤에 그대로 붙어 두 레코드가 모두 깨진다.
     * 그 줄을 쓸지 말지는 상위(Table)가 정하도록 시작 offset을 돌려준다.
     *
     * @return '\n' 없이 끝나던 줄의 시작 offset, 없으면 -1
     */
    private long terminateLastLine() throws IOException {
        if (flushedSize == 0 || readByte(flushedSize - 1) == '\n') {
            return -1;
        }
        long lineStart = lastLineStart(flushedSize);
        writeFully(ByteBuffer.wrap(new byte[]{'\n'}), flushedSize);
        flushedSize++;
        return lineStart;
    }

    /** end 직전의 '\n' 다음 위치(= 마지막 줄의 시작). 뒤에서부터 청크 단위로 찾는다. */
    private long lastLineStart(long end) throws IOException {
        long pos = end;
        ByteBuffer chunk = ByteBuffer.allocate(READ_CHUNK);
        while (pos > 0) {
            int length = (int) Math.min(READ_CHUNK, pos);
            chunk.clear().limit(length);
            readFully(chunk, pos - length);
            for (int i = length - 1; i >= 0; i--) {
                if (chunk.get(i) == '\n') {
                    return pos - length + i + 1;
                }
            }
            pos -= length;
        }
        return 0;
    }

    public Path path() {
        return path;
    }

    /** 다음에 append될 줄이 시작할 byte offset (= 버퍼를 포함한 논리적 파일 크기) */
    public long size() {
        return flushedSize + buffered;
    }

    /** 열 때 줄바꿈 없이 끝나 있던 마지막 줄의 시작 offset */
    public OptionalLong unterminatedLineOffset() {
        return unterminatedLineOffset < 0 ? OptionalLong.empty() : OptionalLong.of(unterminatedLineOffset);
    }

    /**
     * 줄 하나를 파일 끝에 쓴다. 줄바꿈은 여기서 붙인다.
     *
     * @return 그 줄이 시작된 byte offset. 문자 수가 아니라 UTF-8 바이트 기준이다.
     */
    public long append(String line) {
        ensureWritable();
        if (line.indexOf('\n') >= 0 || line.indexOf('\r') >= 0) {
            throw new StorageException("레코드 한 줄에 줄바꿈 문자가 들어 있습니다 (RecordCodec으로 인코딩해야 합니다): " + path);
        }
        byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
        long offset = size();
        if (bytes.length > BUFFER_SIZE - buffered) {
            flushBuffer();
        }
        if (bytes.length > BUFFER_SIZE) {
            // 버퍼보다 큰 줄은 버퍼를 거치지 않고 바로 쓴다. 버퍼는 방금 비웠으므로 순서가 지켜진다.
            writeOrBreak(ByteBuffer.wrap(bytes), flushedSize);
            flushedSize += bytes.length;
        } else {
            System.arraycopy(bytes, 0, buffer, buffered, bytes.length);
            buffered += bytes.length;
        }
        return offset;
    }

    public void flush() {
        ensureWritable();
        flushBuffer();
    }

    private void flushBuffer() {
        if (buffered == 0) {
            return;
        }
        writeOrBreak(ByteBuffer.wrap(buffer, 0, buffered), flushedSize);
        flushedSize += buffered;
        buffered = 0;
    }

    /**
     * offset에서 시작하는 줄 하나를 읽는다(줄바꿈 제외). 아직 flush되지 않은 줄은 버퍼에서 읽는다.
     *
     * @param offset append가 돌려준 줄 시작 위치
     */
    public String readAt(long offset) {
        ensureOpen();
        if (offset < 0 || offset >= size()) {
            throw new StorageException("offset " + offset + "이(가) 파일 범위(0~" + (size() - 1) + ")를 벗어났습니다: " + path);
        }
        try {
            // 줄의 시작이 아닌 곳을 가리키면 엉뚱한 레코드 조각을 돌려주게 되므로 막는다.
            if (offset > 0 && byteAt(offset - 1) != '\n') {
                throw new StorageException("offset " + offset + "은(는) 줄의 시작이 아닙니다: " + path);
            }
            return offset >= flushedSize ? readFromBuffer((int) (offset - flushedSize)) : readFromDisk(offset);
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 읽을 수 없습니다: " + path + " (offset " + offset + ")", e);
        }
    }

    private String readFromBuffer(int start) {
        for (int i = start; i < buffered; i++) {
            if (buffer[i] == '\n') {
                return new String(buffer, start, i - start, StandardCharsets.UTF_8);
            }
        }
        throw new IllegalStateException("버퍼의 마지막 줄에 줄바꿈이 없습니다"); // append가 항상 '\n'을 붙이므로 불가능
    }

    private String readFromDisk(long offset) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        ByteBuffer chunk = ByteBuffer.allocate(READ_CHUNK);
        long pos = offset;
        while (pos < flushedSize) {
            chunk.clear().limit((int) Math.min(READ_CHUNK, flushedSize - pos));
            readFully(chunk, pos);
            for (int i = 0; i < chunk.limit(); i++) {
                if (chunk.get(i) == '\n') {
                    line.write(chunk.array(), 0, i);
                    return line.toString(StandardCharsets.UTF_8);
                }
            }
            line.write(chunk.array(), 0, chunk.limit());
            pos += chunk.limit();
        }
        throw new StorageException("offset " + offset + "의 줄이 줄바꿈 없이 끝났습니다: " + path);
    }

    private int byteAt(long pos) throws IOException {
        return pos >= flushedSize ? buffer[(int) (pos - flushedSize)] : readByte(pos);
    }

    /** 파일의 처음부터 끝까지 한 줄씩 넘긴다(줄바꿈 제외). */
    public void scan(Consumer<String> consumer) {
        scanWithOffsets((offset, line) -> consumer.accept(line));
    }

    /**
     * 파일의 처음부터 끝까지 한 줄씩, 그 줄의 시작 offset과 함께 넘긴다.
     *
     * <p>flush하지 않는다: 디스크에 있는 부분을 읽은 뒤 버퍼에 있는 줄을 메모리에서 이어 읽는다.
     * 예전에는 시작할 때 flush했는데, 읽기 락 아래에서 두 스캔이 동시에 flush하면 같은 버퍼가 두 번 쓰여 레코드가 중복된다.
     */
    public void scanWithOffsets(LineConsumer consumer) {
        ensureOpen();
        // 시작 시점의 경계를 고정해서 이 범위만 읽는다. 스캔하는 동안 쓰기가 없다는 것은 상위 락이 보장한다.
        long end = flushedSize;
        int bufferedEnd = buffered;
        // 채널은 위치 지정 읽기·쓰기에 쓰고 있으므로, 순차 읽기는 별도 스트림으로 한다.
        try (InputStream in = new BufferedInputStream(Files.newInputStream(path), BUFFER_SIZE)) {
            ByteArrayOutputStream line = new ByteArrayOutputStream(256);
            long offset = 0;
            long lineStart = 0;
            int b;
            while (offset < end && (b = in.read()) != -1) {
                offset++;
                if (b == '\n') {
                    consumer.accept(lineStart, line.toString(StandardCharsets.UTF_8));
                    line.reset();
                    lineStart = offset;
                } else {
                    line.write(b);
                }
            }
            if (line.size() > 0) {
                // 다른 프로세스가 파일을 건드리지 않는 한 생기지 않는다(열 때 마지막 줄을 '\n'으로 닫아 두므로).
                consumer.accept(lineStart, line.toString(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            throw new StorageException("테이블 파일을 읽을 수 없습니다: " + path, e);
        }
        // 버퍼의 줄들. 버퍼는 항상 줄 단위로 채워지므로 마지막 바이트는 '\n'이다.
        int lineStart = 0;
        for (int i = 0; i < bufferedEnd; i++) {
            if (buffer[i] == '\n') {
                consumer.accept(end + lineStart, new String(buffer, lineStart, i - lineStart, StandardCharsets.UTF_8));
                lineStart = i + 1;
            }
        }
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        try {
            if (!broken) {
                flushBuffer();
            }
        } finally {
            closed = true;
            closeQuietly();
        }
    }

    // ---- 저수준 I/O ----

    private void writeOrBreak(ByteBuffer bytes, long position) {
        try {
            writeFully(bytes, position);
        } catch (IOException e) {
            broken = true;
            throw new StorageException("테이블 파일에 쓸 수 없습니다: " + path + " (이후 쓰기는 거부됩니다. 재시작하세요)", e);
        }
    }

    private void writeFully(ByteBuffer bytes, long position) throws IOException {
        long pos = position;
        while (bytes.hasRemaining()) {
            pos += channel.write(bytes, pos);
        }
    }

    private void readFully(ByteBuffer target, long position) throws IOException {
        long pos = position;
        while (target.hasRemaining()) {
            int n = channel.read(target, pos);
            if (n < 0) {
                throw new IOException("예상보다 파일이 짧습니다 (위치 " + pos + ")");
            }
            pos += n;
        }
    }

    private int readByte(long position) throws IOException {
        ByteBuffer one = ByteBuffer.allocate(1);
        readFully(one, position);
        return one.get(0);
    }

    private void ensureOpen() {
        if (closed) {
            throw new StorageException("이미 닫힌 테이블 파일입니다: " + path);
        }
    }

    private void ensureWritable() {
        ensureOpen();
        if (broken) {
            throw new StorageException("이전 쓰기 실패로 쓸 수 없는 테이블 파일입니다. 재시작하세요: " + path);
        }
    }

    private void closeQuietly() {
        try {
            channel.close();
        } catch (IOException ignored) {
            // 닫기 실패는 더 할 수 있는 게 없다. 데이터는 이미 flush를 시도했다.
        }
    }
}
