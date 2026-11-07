/**
 * 대용량 레코드 생성기 — 같은 씨앗(seed)이면 항상 같은 데이터 (테스트 재현 가능)
 *   SQL 문자열을 만들어 파싱하면 100만 건에서 너무 느리므로, 실행기의 INSERT 경로(AST)를 직접 쓴다.
 *   → 파싱만 건너뛰고 검사·id 부여·파일 기록·B+ 트리 등록은 SQL INSERT 와 똑같이 거친다.
 */
const FAMILY = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
const GIVEN = ['정글', '리액트', '레디스', '디비', '트리', '해시', '스레드', '커밋', '패치', '훅스'];
const CATS = ['키보드', '마우스', '모니터', '케이블', '스탠드'];

/** 작고 빠른 의사 난수 (mulberry32) */
export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** i 번째 사용자 (email 은 i 로 유일 → 선형 탐색 비교에 쓰기 좋다) */
export function userRow(i, rand) {
  return [
    { kind: 'string', value: FAMILY[i % 10] + GIVEN[Math.floor(rand() * 10)] },
    { kind: 'number', value: 18 + Math.floor(rand() * 50) },
    { kind: 'string', value: `user${i}@jungle.test` },
  ];
}

export function productRow(i, rand) {
  return [
    { kind: 'string', value: `${CATS[i % 5]} ${i}` },
    { kind: 'number', value: 1000 * (1 + Math.floor(rand() * 300)) },
    { kind: 'string', value: CATS[i % 5] },
  ];
}

/**
 * @param {import('./engine.js').Database} db
 * @param {string} table  users | products
 * @param {number} n
 */
export function seedRows(db, table, n, { batch = 10000, seed = 42 } = {}) {
  const rand = rng(seed);
  const t = db.table(table);
  const make = t.name === 'products' ? productRow : userRow;
  const start = t.nextId;
  let first = null, last = null;
  for (let done = 0; done < n; done += batch) {
    const rows = [];
    for (let k = 0; k < Math.min(batch, n - done); k++) rows.push(make(start + done + k, rand));
    const r = db.insert({ type: 'insert', table: t.name, columns: null, rows, pos: null });
    first ??= r.ids[0];
    last = r.ids.at(-1);
  }
  db.storage.flush();
  return { count: n, first, last };
}
