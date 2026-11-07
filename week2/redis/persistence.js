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
 */
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MiniRedis } from './miniredis.js';

const NO_POLICY_LIMIT = 64 * 1024;

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
    if (this.policy === 'everysec') {
      this.timer = setInterval(() => this.flush(), 1000);
      this.timer.unref?.();
    }
  }

  append(args) {
    const line = JSON.stringify(args) + '\n';
    this.writes++;
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

  /** 지금 상태만 담은 내용으로 파일을 원자적으로 교체 */
  rewrite(content) {
    this.flush();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, content);
    const fd = openSync(tmp, 'r+');
    fsyncSync(fd);
    closeSync(fd);
    closeSync(this.fd);
    renameSync(tmp, this.path);
    this.fd = openSync(this.path, 'a');
  }

  size() {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  close() {
    if (this.fd === null) return;
    clearInterval(this.timer);
    this.flush();
    closeSync(this.fd);
    this.fd = null;
  }

  /** 서버가 갑자기 죽은 상황 흉내: 버퍼를 버리고 닫는다 (테스트용) */
  crash() {
    clearInterval(this.timer);
    this.buffer = '';
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * AOF 파일에서 복원한 MiniRedis + 그 파일에 계속 기록하는 연결
 * @returns {{ redis: MiniRedis, aof: AofFile, restored: object }}
 */
export function openPersistentRedis(path, opts = {}) {
  const redis = new MiniRedis(opts);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const restored = redis.loadAof(text);
  const aof = new AofFile(path, opts);
  // 복원 직후 압축: 잘린 줄·만료된 키·덮어쓴 기록을 정리
  if (text) aof.rewrite(redis.rewriteAof());
  redis.onWrite = (args) => aof.append(args);
  return { redis, aof, restored };
}
