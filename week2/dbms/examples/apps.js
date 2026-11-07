/**
 * 미니 DBMS 예제 — SQL 처리기와 B+ 트리 인덱스로 실제 서비스 기능 4가지
 *  1. 회원 가입         입력값으로 INSERT 만들기 (따옴표 이스케이프, SQL 오류 위치)
 *  2. 게시판 목록 캐시  SQL 결과를 미니 레디스에 캐시 + 글쓰기 때 태그 무효화
 *  3. 페이지 넘기기     id 기준(keyset, B+ 트리 범위) vs 앞에서부터 건너뛰기(offset)
 *  4. 이메일로 찾기     선형 탐색 vs 레디스에 "email → id" 보조 인덱스
 *
 *  flags 를 true 로 바꾸면 "일부러 망가뜨린" 버전 (예제 페이지의 🧪 버튼)
 */
import { decodeRow } from '../storage.js';

export const flags = {
  signupNoEscape: false,    // 따옴표를 이스케이프하지 않고 문자열을 이어 붙임 → SQL 인젝션
  boardNoInvalidate: false, // 글을 써도 목록 캐시를 안 지움 → 새 글이 안 보임
  emailNoNx: false,         // 가입할 때 SET NX 대신 SET → 같은 이메일로 두 번 가입
};

export function resetFlags() {
  for (const k of Object.keys(flags)) flags[k] = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** SQL 문자열 안전하게: ' → '' */
export const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ================================================================ 1. 회원 가입
/** 입력값 → INSERT 문. 망가뜨리면 따옴표를 그대로 이어 붙인다 */
export function signupSql({ name, age, email }) {
  const ageSql = String(age).trim() === '' ? 'NULL' : String(age).trim();
  if (flags.signupNoEscape) return `INSERT INTO users (name, age, email) VALUES ('${name}', ${ageSql}, '${email}')`;
  return `INSERT INTO users (name, age, email) VALUES (${quote(name)}, ${ageSql}, ${quote(email)})`;
}

/** @returns {{ ok: boolean, sql: string, ids?: number[], error?: string }} */
export function signup(db, input) {
  const sql = signupSql(input);
  try {
    const [r] = db.execute(sql);
    return { ok: true, sql, ids: r.ids };
  } catch (e) {
    return { ok: false, sql, error: e.message };
  }
}

// ================================================================ 2. 게시판 목록 캐시 (DBMS + 레디스)
export class BoardService {
  /**
   * @param {import('../engine.js').Database} db
   * @param {import('../../redis/miniredis.js').MiniRedis} redis
   */
  constructor(db, redis, { latencyMs = 80, pageSize = 5 } = {}) {
    this.db = db;
    this.redis = redis;
    this.latencyMs = latencyMs;
    this.pageSize = pageSize;
    this.dbQueries = 0;
  }

  async #sql(sql) {
    this.dbQueries++;
    await sleep(this.latencyMs); // 디스크·네트워크 비용 흉내
    return this.db.execute(sql);
  }

  /** 최신 글 목록 (cache-aside, 60초, 태그 posts) */
  async latest() {
    const t0 = performance.now();
    const cached = this.redis.command(['GET', 'board:latest']);
    if (cached !== null) return { rows: JSON.parse(cached), hit: true, ms: performance.now() - t0 };
    const max = this.db.tables.posts.nextId - 1;
    const [r] = await this.#sql(`SELECT id, title, author FROM posts WHERE id > ${Math.max(0, max - this.pageSize)}`);
    const rows = r.rows.reverse();
    this.redis.command(['SET', 'board:latest', JSON.stringify(rows), 'EX', '60']);
    this.redis.command(['TAG', 'board:latest', 'posts']);
    return { rows, hit: false, ms: performance.now() - t0 };
  }

  async write(title, author) {
    const [r] = await this.#sql(`INSERT INTO posts (title, author) VALUES (${quote(title)}, ${quote(author)})`);
    const invalidated = flags.boardNoInvalidate ? 0 : this.redis.command(['INVALIDATE', 'posts']);
    return { id: r.ids[0], invalidated };
  }
}

// ================================================================ 3. 페이지 넘기기
/** id 기준: "지난 페이지의 마지막 id 보다 큰 것 10개" → B+ 트리 범위 조회, 몇 쪽이든 10개만 읽음 */
export function keysetPage(db, lastId, size = 10) {
  const [r] = db.execute(`SELECT id, title FROM posts WHERE id > ${lastId} LIMIT ${size}`);
  return { rows: r.rows, scanned: r.plan.scanned, plan: r.plan.type, nextLast: r.rows.at(-1)?.[0] ?? lastId };
}

/** 앞에서부터 건너뛰기 (OFFSET 방식): 앞쪽 (page-1)*size 개를 읽고 버림 → 뒤로 갈수록 느려짐 */
export function offsetPage(db, page, size = 10) {
  const skip = (page - 1) * size;
  const [r] = db.execute(`SELECT id, title FROM posts WHERE title != '' LIMIT ${skip + size}`);
  return { rows: r.rows.slice(skip), scanned: r.plan.scanned, plan: r.plan.type };
}

// ================================================================ 4. 이메일로 찾기
/** 레디스에 email → id 를 저장해 두는 보조 인덱스 */
export class EmailIndex {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  /** 회원 가입: 레디스에 먼저 자리 잡기(SET NX) → DB 에 INSERT → email → id 확정 */
  signUp(name, email) {
    const key = `email:${email.toLowerCase()}`;
    const claim = flags.emailNoNx ? this.redis.command(['SET', key, 'pending']) : this.redis.command(['SET', key, 'pending', 'NX']);
    if (claim === null) return { ok: false, reason: '이미 가입한 이메일' };
    const [r] = this.db.execute(`INSERT INTO users (name, age, email) VALUES (${quote(name)}, 20, ${quote(email)})`);
    this.redis.command(['SET', key, String(r.ids[0])]);
    return { ok: true, id: r.ids[0] };
  }

  /** 레디스 → id → B+ 트리 (두 번 다 O(1)/O(log n)) */
  find(email) {
    const id = this.redis.command(['GET', `email:${email.toLowerCase()}`]);
    if (id === null || id === 'pending') return { row: null, scanned: 0, via: 'index' };
    const [r] = this.db.execute(`SELECT * FROM users WHERE id = ${Number(id)}`);
    return { row: r.rows[0] ?? null, scanned: r.plan.scanned, via: 'index' };
  }

  /** 인덱스 없이: 파일 처음부터 끝까지 */
  scan(email) {
    const [r] = this.db.execute(`SELECT * FROM users WHERE email = ${quote(email)} LIMIT 1`);
    return { row: r.rows[0] ?? null, scanned: r.plan.scanned, via: 'scan' };
  }

  /** 같은 이메일로 가입한 회원 수 (선형 탐색) */
  countEmail(email) {
    const [r] = this.db.execute(`SELECT id FROM users WHERE email = ${quote(email)}`);
    return r.rows.length;
  }

  /** 이미 있는 회원으로 인덱스 만들기 (서버 시작 시 1회) */
  rebuild() {
    let n = 0;
    for (const [, line] of this.db.storage.scan('users')) {
      if (!line) continue;
      const cols = decodeRow(line); // 쉼표·따옴표가 든 값도 정확히 (NULL 은 null)
      const email = cols[3];
      if (email) {
        this.redis.command(['SET', `email:${email.toLowerCase()}`, cols[0]]);
        n++;
      }
    }
    return n;
  }
}

// ================================================================ 망가뜨리기 실험 설명
export const EXPERIMENTS = [
  {
    id: 'signupNoEscape', app: 'signup', title: '따옴표 이스케이프 안 하기', concept: 'SQL 인젝션 · 토크나이저', theory: '../theory/index.html#sqlflow',
    before: "VALUES (${quote(name)}, …)\n// O'Brien → 'O''Brien'", after: "VALUES ('${name}', …)\n// 입력을 그대로 이어 붙임",
    try: "이름에 O'Brien 을 넣어 가입 → 예시 버튼 \"해커 입력\" 으로 가입해 보세요.",
    watch: "O'Brien 은 문법 오류가 나고, 해커 입력은 가입 한 번에 회원이 2명 생깁니다(관리자 행이 몰래 추가됨).",
    why: "입력값 안의 ' 가 문자열을 닫아 버려서, 그 뒤의 글자가 SQL 문법으로 해석됩니다. 공격자는 이것으로 원하는 행을 넣거나(이 예제), 실제 DBMS 에서는 데이터를 지우거나 훔칩니다. 값은 반드시 이스케이프하거나, 값을 SQL 과 따로 보내는 준비된 문장(prepared statement)을 씁니다.",
  },
  {
    id: 'boardNoInvalidate', app: 'board', title: '글쓰기 후 캐시 안 지우기', concept: '캐시 무효화', theory: '../../redis/theory/index.html#invalidate',
    before: "INSERT INTO posts …\nINVALIDATE posts", after: 'INSERT INTO posts …\n// 캐시는 그대로',
    try: '목록 보기 → 글쓰기를 눌러 보세요.',
    watch: '방금 쓴 글이 목록에 안 보이고, 막대에 HIT(캐시)라고 나옵니다. 60초가 지나야 보입니다.',
    why: '원본(DBMS)만 바꾸고 복사본(캐시)을 그대로 두면 TTL 이 끝날 때까지 옛 목록이 나갑니다. "내 글 어디 갔어요?" 문의의 흔한 원인. 캐시를 넣는 순간 언제 지울지를 같이 설계해야 합니다.',
  },
  {
    id: 'emailNoNx', app: 'email', title: 'SET NX 대신 SET', concept: '중복 방지 · 보조 인덱스', theory: '../theory/index.html#index',
    before: "SET email:주소 pending NX\n// 이미 있으면 null → 거절", after: 'SET email:주소 pending\n// 있어도 덮어씀',
    try: '이미 있는 이메일(user77@jungle.test)로 가입해 보세요.',
    watch: '가입이 성공하고, 같은 이메일을 가진 회원이 2명이 됩니다. 보조 인덱스는 새 회원만 가리킵니다.',
    why: 'NX(없을 때만)가 "한 이메일 = 한 회원" 을 지키는 유일한 장치였습니다. 덮어쓰면 중복 가입이 되고, 인덱스와 테이블의 내용이 어긋납니다. 실제 DBMS 는 UNIQUE 제약으로 이것을 테이블이 직접 지킵니다.',
  },
];
