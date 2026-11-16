/**
 * 코드 점검에서 찾은 문제의 회귀 테스트
 *   1) id = ? 와 다른 id 조건이 함께 있을 때의 조회 결과
 *   2) 비공개 경로(server/, week2/data/)가 대소문자를 바꿔도 열리지 않는지
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../week2/dbms/engine.js';
import { FileStorage } from '../week2/dbms/storage-file.js';
import { createApp, createWeek2 } from '../server.js';

test('id = ? 에 다른 id 조건이 붙으면 그 조건도 검사한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minidb-idconds-'));
  const storage = new FileStorage(dir);
  try {
    const db = new Database(storage);
    db.execute("INSERT INTO users (name, age, email) VALUES ('a', 1, 'a@x'), ('b', 2, 'b@x'), ('c', 3, 'c@x'), ('d', 4, 'd@x'), ('e', 5, 'e@x'), ('f', 6, 'f@x')");
    const ids = (sql) => db.execute(sql)[0].rows.map((r) => r[0]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 3 AND id > 5'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 3 AND id <= 2'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id BETWEEN 2 AND 3 AND id = 6'), []);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 3 AND id >= 3'), [3]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id = 4'), [4]);
    assert.deepEqual(ids('SELECT id FROM users WHERE id > 2 AND id < 5'), [3, 4]);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('비공개 경로는 대소문자를 바꿔도 열리지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-private-'));
  const app = createApp({ week2: createWeek2(dir) });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    for (const p of ['/server/chat.js', '/Server/chat.js', '/SERVER/testlab.js', '/week2/data/x', '/Week2/Data/x', '/WEEK2/DATA/db/schema.json', '/Node_Modules/x', '/.ENV']) {
      const res = await fetch(base + p);
      await res.arrayBuffer();
      assert.equal(res.status, 403, p);
    }
    const ok = await fetch(base + '/package.json');
    await ok.arrayBuffer();
    assert.equal(ok.status, 200);
  } finally {
    await app.week2.close();
    app.closeAllConnections?.();
    await new Promise((r) => app.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
