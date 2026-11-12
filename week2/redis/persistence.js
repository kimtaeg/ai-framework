/**
 * MiniRedis 디스크 저장 (Node 전용) — AOF (Append Only File)
 * ------------------------------------------------------------------
 *  쓰기 명령을 파일 끝에 한 줄씩 덧붙인다. 서버가 다시 켜지면 처음부터 다시 실행해서 상태를 복원한다.
 *
 *  fsync 정책 (얼마나 자주 "디스크에 확실히 쓰기" 를 할지 = 안전 vs 속도)
 *    always   : 명령마다 write + fsync. 가장 안전, 가장 느림
 *    everysec : 메모리 버퍼에 모았다가 1초마다 write + fsync. 서버가 죽으면 최대 1초 분량 손실 (Redis 기본값)
 *    no       : 버퍼가 64KB 차거나 종료할 때만 기록. 가장 빠르지만 손실이 클 수 있음
 *
 *  재작성 (rewrite)
 *    같은 키를 1만 번 SET 하면 AOF 에 1만 줄이 쌓인다. 지금 상태만 담은 파일을 새로 만들어 교체한다.
 *    임시 파일에 다 쓴 뒤 rename → 쓰는 도중 죽어도 원래 파일은 멀쩡하다 (rename 은 원자적)
 *    자동 재작성: 마지막 재작성 뒤로 파일이 그 크기의 100% (그리고 최소 1MB) 만큼 더 자라면 다시 재작성한다.
 *    (Redis 의 auto-aof-rewrite-percentage 100 / auto-aof-rewrite-min-size 와 같은 생각.
 *     서버를 켤 때만 재작성하면, 오래 켜 둔 서버의 AOF 는 끝없이 커지고 다음 시작이 그만큼 느려진다)
 *    나눠서 재작성: 키가 많으면 전체를 한 번에 쓰는 동안 서버가 멈춘다. (Redis 는 자식 프로세스를 fork 해서 따로 쓴다)
 *     여기서는 조금 쓰고 → 다른 요청을 처리하고 → 다시 조금 쓰기를 반복한다. 그 사이에 들어온 쓰기 명령은
 *     따로 모아 두었다가(재작성 버퍼) 새 파일 끝에 붙인다 → 새 파일 = 훑은 시점의 상태 + 그 뒤의 모든 변경.
 *
 *  복원: 파일을 1MB 씩 읽어 줄 단위로 다시 실행한다 (파일 전체를 문자열 하나로 올리지 않음 → 큰 AOF 도 읽을 수 있다)
 */
import { openSync, writeSync, fsyncSync, closeSync, readSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MiniRedis } from './miniredis.js';

const NO_POLICY_LIMIT = 64 * 1024;
const AUTO_REWRITE_MIN_SIZE = 1024 * 1024;
const READ_CHUNK = 1024 * 1024;
const INCREMENTAL_AT = 5000; // 키가 이보다 많으면 재작성을 나눠서 한다 (적으면 한 번에 써도 금방 끝난다)

/** 파일을 조금씩 읽어 한 줄씩 넘겨준다 (마지막 줄바꿈 뒤의 남은 내용도 한 줄로) */
export function* readLines(path, chunkSize = READ_CHUNK) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    const decoder = new StringDecoder('utf8'); // 덩어리 경계에서 잘린 한글 등 여러 바이트 문자를 이어 붙인다
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      yield* parts;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

export class AofFile {
  /**
   * @param {string} path
   * @param {{ fsync?: 'always'|'everysec'|'no' }} [opts]
   */
  constructor(path, opts = {}) {
    this.path = path;
    this.policy = opts.fsync ?? 'everysec';
    if (!['always', 'everysec', 'no'].includes(this.policy)) throw new Error(`알 수 없는 fsync 정책: ${this.policy}`);
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'a');
    this.buffer = '';
    this.timer = null;
    this.writes = 0;
    this.syncs = 0;
    this.rewrites = 0;
    this.baseSize = this.size(); // 마지막 재작성(또는 열었을 때) 직후의 파일 크기
    this.grown = 0;              // 그 뒤로 덧붙인 바이트 수
    this.rewriting = null;       // 나눠서 재작성하는 중이면 { fd, tmp, cursor, next, tail, bytes, immediate }
    if (this.policy === 'everysec') {
      this.timer = setInterval(() => this.flush(), 1000);
      this.timer.unref?.();
    }
  }

  append(args) {
    const line = JSON.stringify(args) + '\n';
    this.writes++;
    this.grown += Buffer.byteLength(line);
    if (this.rewriting) this.rewriting.tail += line; // 재작성 중에 들어온 명령은 새 파일 끝에도 붙여야 한다
    if (this.policy === 'always') {
      writeSync(this.fd, line);
      fsyncSync(this.fd);
      this.syncs++;
      return;
    }
    this.buffer += line;
    if (this.policy === 'no' && this.buffer.length >= NO_POLICY_LIMIT) this.flush(false);
  }

  /** 버퍼를 파일에 쓰고(write) 디스크에 확정(fsync) */
  flush(sync = true) {
    if (this.fd === null || !this.buffer) return;
    writeSync(this.fd, this.buffer);
    this.buffer = '';
    if (sync) {
      fsyncSync(this.fd);
      this.syncs++;
    }
  }

  /**
   * 나눠서 재작성 시작. next(cursor) → { cursor, text } 를 cursor 가 0 이 될 때까지 부르며 임시 파일에 쓴다.
   * 한 조각을 쓰고 나면 이벤트 루프에 차례를 넘긴다 → 그 사이에 다른 요청이 처리된다.
   */
  startRewrite(next) {
    if (this.rewriting || this.fd === null) return false;
    this.flush();
    const tmp = `${this.path}.tmp`;
    this.rewriting = { fd: openSync(tmp, 'w'), tmp, cursor: 0, next, tail: '', bytes: 0, immediate: null };
    this.#rewriteLater();
    return true;
  }

  #rewriteLater() {
    const r = this.rewriting;
    r.immediate = setImmediate(() => {
      if (this.rewriting !== r) return;
      if (this.#rewriteStep()) this.#rewriteLater();
    });
  }

  /** 한 조각 쓰기. 더 남았으면 true */
  #rewriteStep() {
    const r = this.rewriting;
    const piece = r.next(r.cursor);
    if (piece.text) {
      writeSync(r.fd, piece.text);
      r.bytes += Buffer.byteLength(piece.text);
    }
    r.cursor = piece.cursor;
    if (r.cursor !== 0) return true;
    // 다 훑었다: 그동안 들어온 명령을 붙이고, 디스크에 확정한 뒤 원래 파일과 바꾼다
    if (r.tail) writeSync(r.fd, r.tail);
    fsyncSync(r.fd);
    closeSync(r.fd);
    this.flush();
    closeSync(this.fd);
    renameSync(r.tmp, this.path);
    this.fd = openSync(this.path, 'a');
    this.rewrites++;
    this.baseSize = r.bytes;
    this.grown = Buffer.byteLength(r.tail);
    this.rewriting = null;
    return false;
  }

  /** 진행 중인 나눠 쓰기를 지금 끝까지 마친다 (종료할 때 · 테스트) */
  finishRewrite() {
    if (!this.rewriting) return;
    clearImmediate(this.rewriting.immediate);
    while (this.#rewriteStep());
  }

  /** 지금 상태만 담은 내용으로 파일을 원자적으로 교체 */
  rewrite(content) {
    if (this.rewriting) this.#abandonRewrite(); // 통째로 다시 쓰므로 진행 중이던 조각 쓰기는 버린다
    this.flush();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, content);
    const fd = openSync(tmp, 'r+');
    fsyncSync(fd);
    closeSync(fd);
    closeSync(this.fd);
    renameSync(tmp, this.path);
    this.fd = openSync(this.path, 'a');
    this.rewrites++;
    this.baseSize = Buffer.byteLength(content);
    this.grown = 0;
  }

  /** 마지막 재작성 뒤로 충분히 자랐는지 (자동 재작성 기준) */
  shouldRewrite(minSize = AUTO_REWRITE_MIN_SIZE, percentage = 100) {
    if (this.rewriting) return false; // 이미 재작성하는 중
    return this.grown >= minSize && this.grown >= (this.baseSize * percentage) / 100;
  }

  size() {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  #abandonRewrite() {
    const r = this.rewriting;
    if (!r) return;
    clearImmediate(r.immediate);
    closeSync(r.fd);
    this.rewriting = null;
  }

  close() {
    if (this.fd === null) return;
    this.finishRewrite();
    clearInterval(this.timer);
    this.flush();
    closeSync(this.fd);
    this.fd = null;
  }

  /** 서버가 갑자기 죽은 상황 흉내: 버퍼를 버리고 닫는다 (테스트용) */
  crash() {
    this.#abandonRewrite(); // 임시 파일은 남지만 원래 파일은 그대로다 (다음 재작성이 덮어쓴다)
    clearInterval(this.timer);
    this.buffer = '';
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * AOF 파일에서 복원한 MiniRedis + 그 파일에 계속 기록하는 연결
 * @param {object} [opts]  MiniRedis / AofFile 옵션 +
 *   autoRewriteMinSize (기본 1MB), autoRewritePercentage (기본 100, 0 이면 자동 재작성 끔)
 * @returns {{ redis: MiniRedis, aof: AofFile, restored: object }}
 */
export function openPersistentRedis(path, opts = {}) {
  const redis = new MiniRedis(opts);
  const had = existsSync(path) && statSync(path).size > 0;
  const restored = redis.loadAof(had ? readLines(path) : '');
  const aof = new AofFile(path, opts);
  // 복원 직후 압축: 잘린 줄·만료된 키·덮어쓴 기록을 정리 (아직 요청을 받기 전이라 한 번에 써도 된다)
  if (had) aof.rewrite(redis.rewriteAof());
  const minSize = opts.autoRewriteMinSize ?? AUTO_REWRITE_MIN_SIZE;
  const percentage = opts.autoRewritePercentage ?? 100;
  redis.onWrite = (args) => {
    aof.append(args);
    // 명령 도중에 재작성해도 안전하다: AOF 의 모든 줄은 "결과 상태" 를 다시 만드는 멱등 명령이고,
    // 저장소를 먼저 바꾼 뒤에 기록하므로, 지금 상태를 통째로 쓴 파일 뒤에 남은 줄이 이어져도 결과가 같다
    if (percentage > 0 && aof.shouldRewrite(minSize, percentage)) {
      // 키가 많으면 나눠서 (서버가 멈추지 않게), 적으면 한 번에
      if (redis.data.size > (opts.incrementalRewriteAt ?? INCREMENTAL_AT)) aof.startRewrite((cursor) => redis.rewriteChunk(cursor));
      else aof.rewrite(redis.rewriteAof());
    }
  };
  return { redis, aof, restored };
}
