/**
 * 2주차 miniDBMS — 데이터 폴더 락 (.lock): 한 폴더에 쓰는 프로그램은 하나만
 *   API 서버가 켜져 있는 동안 CLI 나 다른 서버가 같은 폴더에 쓰지 못하게 한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockDataDir } from '../mini_DBMS/storage-file.js';
import { createDbService } from '../mini_DBMS/service.js';
import { runCli } from '../mini_DBMS/cli.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const CLI = fileURLToPath(new URL('../mini_DBMS/cli.js', import.meta.url));
const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--data', dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('데이터 폴더 락', () => {
  test('잡고 풀기: 같은 프로세스는 다시 잡을 수 있고, 풀면 파일이 없어진다', () => {
    const dir = tmp('minidb-lock');
    try {
      const a = lockDataDir(dir, '테스트');
      assert.equal(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid, process.pid);
      const b = lockDataDir(dir, '테스트 2'); // 같은 프로세스
      a();
      a(); // 두 번 풀어도 안전
      assert.equal(existsSync(join(dir, '.lock')), false);
      b();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('죽은 프로그램이 남긴 락 · 깨진 락 파일은 치우고 잡는다', () => {
    const dir = tmp('minidb-stale');
    try {
      // 이미 끝난 프로세스의 pid
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
      writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: Number(dead), who: '죽은 서버' }));
      const release = lockDataDir(dir, '테스트');
      assert.equal(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid, process.pid);
      release();
      writeFileSync(join(dir, '.lock'), '{"pid": 12'); // 쓰다 만 파일
      lockDataDir(dir, '테스트')();
      assert.equal(existsSync(join(dir, '.lock')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('서버가 켜져 있으면 다른 프로세스의 CLI 는 조회만 되고, 쓰기는 거절된다', async () => {
    const dir = tmp('minidb-lock-cli');
    const svc = createDbService({ dir, workers: 2 });
    try {
      await svc.ready();
      await svc.query("INSERT INTO users (name, age, email) VALUES ('server', 1, 's@x')");
      // 조회는 된다
      const sel = cli(dir, 'exec', 'SELECT id, name FROM users', '--json');
      assert.equal(sel.code, 0, sel.err);
      assert.deepEqual(JSON.parse(sel.out)[0].rows, [[1, 'server']]);
      assert.equal(cli(dir, 'info').code, 0);
      // 쓰기는 안 된다
      const ins = cli(dir, 'exec', "INSERT INTO users (name, age, email) VALUES ('cli', 2, 'c@x')");
      assert.equal(ins.code, 1);
      assert.match(ins.err, /다른 프로그램이 쓰고 있습니다: API 서버/);
      const seed = cli(dir, 'seed', 'users', '10');
      assert.equal(seed.code, 1);
      assert.match(seed.err, /다른 프로그램이 쓰고 있습니다/);
      // 서버의 데이터는 그대로이고, 다음 id 도 이어진다
      assert.deepEqual((await svc.query("INSERT INTO users (name, age, email) VALUES ('server2', 3, 's2@x')")).results[0].ids, [2]);
      assert.deepEqual((await svc.query('SELECT id FROM users')).results[0].rows, [[1], [2]]);
    } finally {
      await svc.close();
    }
    try {
      // 서버를 끄면 CLI 가 쓸 수 있고, 끝나면 락이 남지 않는다
      assert.equal(existsSync(join(dir, '.lock')), false);
      const ins = cli(dir, 'exec', "INSERT INTO users (name, age, email) VALUES ('cli', 2, 'c@x')", '--json');
      assert.equal(ins.code, 0, ins.err);
      assert.deepEqual(JSON.parse(ins.out)[0].ids, [3]);
      assert.equal(existsSync(join(dir, '.lock')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('다른 프로세스가 쓰고 있는 폴더로는 서버를 시작할 수 없다', async () => {
    const dir = tmp('minidb-lock-two');
    // 락을 잡고 기다리는 다른 프로세스
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { lockDataDir } from ${JSON.stringify(new URL('../mini_DBMS/storage-file.js', import.meta.url).href)};
      lockDataDir(${JSON.stringify(dir)}, '먼저 켠 서버');
      process.stdout.write('locked');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => {
        holder.stdout.once('data', resolve);
        holder.once('exit', () => reject(new Error('락을 잡는 프로세스가 끝나 버렸다')));
      });
      assert.throws(() => createDbService({ dir, workers: 1 }), (e) => e.code === 'DATA_DIR_LOCKED' && /먼저 켠 서버/.test(e.message));
      // 같은 프로세스 안의 CLI(runCli)도 쓰기는 거절
      const errs = [];
      assert.equal(runCli(['exec', "INSERT INTO users (name, age, email) VALUES ('x', 1, 'x')", '--data', dir], { out: () => {}, err: (s) => errs.push(s) }), 1);
      assert.match(errs.join('\n'), /다른 프로그램이 쓰고 있습니다/);
    } finally {
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
    }
    try {
      // 그 프로세스가 죽으면(락 파일은 남는다) 다음 서버가 치우고 시작한다
      assert.equal(existsSync(join(dir, '.lock')), true);
      const svc = createDbService({ dir, workers: 1 });
      await svc.ready();
      assert.deepEqual((await svc.query("INSERT INTO users (name, age, email) VALUES ('ok', 1, 'ok@x')")).results[0].ids, [1]);
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
