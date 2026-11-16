/**
 * 2주차 miniDBMS — 답 없이 끝난 쓰기(시간 초과)는 파일에 행을 남기지 않는다
 *   예전에는 "실패" 라고 응답한 INSERT 의 행 일부가 파일에 남아 조회에 나왔다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbService } from '../week2/dbms/service.js';

// 한글 행 12,000개 = 파일에 1MB 넘게 쓴다 → 요청이 끝나기 전에 일부가 파일에 기록된다
const BIG = 'INSERT INTO users (name, age, email) VALUES ' + Array.from({ length: 12000 }, (_, i) => `('${'가나다라마바사아자차'.repeat(3)}', ${i % 50}, 'u${i}@x')`).join(',');

for (const groupCommit of [true, false]) {
  test(`시간 초과로 실패한 INSERT 는 한 행도 남지 않는다 (groupCommit ${groupCommit})`, async () => {
    let timedOut = 0;
    for (const timeoutMs of [10, 20, 30, 40, 60, 80]) {
      const dir = mkdtempSync(join(tmpdir(), 'minidb-undo-'));
      const svc = createDbService({ dir, workers: 2, timeoutMs, groupCommit, maxRows: 1_000_000 });
      try {
        await svc.ready();
        await svc.query("INSERT INTO users (name, age, email) VALUES ('first', 1, 'f@x')").catch(() => {});
        const before = (await rows(svc)).length;
        let ok = true;
        await svc.query(BIG).catch(() => { ok = false; });
        if (!ok) timedOut++;
        // 성공했으면 전부, 실패했으면 하나도 없어야 한다 (모든 워커에서)
        for (let k = 0; k < 4; k++) assert.equal((await rows(svc)).length, ok ? before + 12000 : before, `timeout ${timeoutMs}ms`);
        // 그 뒤의 쓰기는 id 가 이어진다
        const next = await svc.query("INSERT INTO users (name, age, email) VALUES ('after', 2, 'a@x')").catch(() => null);
        if (next) assert.deepEqual(next.results[0].ids, [(ok ? before + 12000 : before) + 1]);
      } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.ok(timedOut > 0, '시간 초과가 한 번도 나지 않았다 (테스트가 아무것도 확인하지 못함)');
  });
}

/** 조회도 짧은 제한 시간에 걸릴 수 있으니 될 때까지 */
async function rows(svc) {
  for (let i = 0; ; i++) {
    try {
      return (await svc.query('SELECT id FROM users')).results[0].rows;
    } catch (e) {
      if (i > 50) throw e;
    }
  }
}
