/**
 * 학습 가이드 챗봇 — 서버 쪽 (Gemini API 중계)
 * ------------------------------------------------------------------
 * 브라우저 → POST /api/chat { messages, progress, page } → 이 서버가 Gemini 호출 → { text }
 * API 키(GEMINI_API_KEY)는 서버 환경 변수에만 있고 브라우저로 보내지 않는다.
 *
 * 환경 변수
 *   GEMINI_API_KEY   필수. 없으면 챗봇은 "꺼짐" 상태로 응답한다.
 *   GEMINI_MODEL     선택. 기본 gemini-flash-lite-latest
 *   GEMINI_FALLBACK_MODELS 선택. 기본 모델이 바쁠 때(503/429) 대신 쓸 모델들, 쉼표로 구분. 기본 gemini-flash-latest
 *   GEMINI_API_BASE  선택. 기본 https://generativelanguage.googleapis.com (테스트에서 가짜 서버로 바꿈)
 */

const MAX_BODY = 64 * 1024;
const MAX_MESSAGES = 16;
const MAX_CHARS = 2000;
/** 모델 하나당 기다리는 최대 시간 (GEMINI_TIMEOUT_MS 로 조절, 테스트에서 짧게) */
const attemptTimeout = () => Number(process.env.GEMINI_TIMEOUT_MS) || 10000;

// ---------------------------------------------------------------- 시스템 프롬프트
export const PAGES = [
  ['/guide/index.html', '학습 가이드', '볼 순서 12단계, 예측 → 실행 → 확인 → 설명 방법, 발표용 질문-시연 짝짓기'],
  ['/phase1/index.html', 'Phase 1 · Diff Playground', '실제/테스트 영역, Patch·뒤로가기·앞으로가기, 예시 케이스 9개, 단계별 Patch, 예측 퀴즈, 이전 ↔ 새 트리 비교'],
  ['/phase2/index.html', 'Phase 2 · 스터디 플래너', 'useState/useEffect/useMemo 할 일 앱, Batching 데모, 타이머, Inspector(렌더 원인, 단계별 시간, Hook 저장소)'],
  ['/examples/index.html', '예제 모음', '장바구니, 회원가입 폼, 칸반, 1,000행 리스트, 스톱워치, Effect 타이밍(렌더 → useLayoutEffect → useEffect 실행 순서 보기, 경쟁 상태 실험은 없음), Context. 망가뜨리기 실험 7개, Virtual DOM vs 전체 다시 그리기 비교'],
  ['/sandbox/index.html', '샌드박스', '틀 9개와 조각 15개로 miniReact 코드를 직접 만들어 실행'],
  ['/walkthrough/index.html', '핵심 코드 해설', 'h, domToVNode, diff, diffChildren, applyPatch, render/getHookSlot, useState/scheduleUpdate, update/commit, useEffect/useMemo 를 조각마다 설명 + 설명 연습'],
  ['/theory/index.html', 'React 이론', '브라우저 렌더링, Virtual DOM, Diff, key, Fiber, Hooks, 동시성, SSR, React 19. 직접 해보는 예제 4개'],
  ['/deepdive/index.html', '개념 더 파고들기', '왜 그렇게 만들었는지 12주제(스냅샷/클로저, O(n³)→O(n) 가정, key 정체성, LIS, Hook 순서 설계, 이벤트 루프와 Batching, Effect=동기화와 경쟁 상태, 불변성과 Object.is, Fiber 시간 쪼개기, Render/Commit 분리, Virtual DOM vs Signals/컴파일러, miniReact 한계). 주제마다 실행해 보는 실험. 경쟁 상태(race condition)·index key 메모 버그·Hook 칸 표·이벤트 루프 순서 맞히기·시간 쪼개기 실험은 이 페이지에만 있다'],
  ['/cheatsheet/index.html', '한 장 요약', '발표 직전용 15칸 요약, A4 인쇄'],
  ['/docs/index.html', '설명서', '과제 중점 포인트 정리'],
  // ---- 2주차
  ['/index.html#redis', '홈 (2주차 미니 레디스)', '왼쪽에서 2주차 미니 레디스를 고르면 레디스 페이지 목록'],
  ['/index.html#dbms', '홈 (2주차 미니 DBMS)', '왼쪽에서 2주차 미니 DBMS 를 고르면 DBMS 페이지 목록'],
  ['/week2/redis/guide/index.html', '미니 레디스 학습 가이드', '예측 → 실행 → 확인 → 설명, 볼 순서 8단계, 예제별 질문, 망가뜨리기 목록, 도구, 발표 질문 → 시연, 요구사항 지도'],
  ['/week2/redis/index.html', '미니 레디스 Playground', '1 명령 콘솔, 2 해시 테이블 버킷·점진적 리해시, 3 만료(지연/주기 삭제), 4 캐시·무효화·성능 비교, 5 동시성(GET+SET vs INCR), 6 AOF 서버 다운·복원(fsync 정책), 7 HTTP API'],
  ['/week2/redis/examples/index.html', '미니 레디스 예제', '로그인 세션, 요청 횟수 제한, 분산 락, 좋아요 카운터 + 망가뜨리기 버튼 5개(TTL 없음, EXPIRE 빼먹기, 락 TTL 없음, 토큰 확인 없이 해제, GET→SET 나누기)'],
  ['/week2/redis/sandbox/index.html', '미니 레디스 샌드박스', 'redis.exec() 로 직접 코딩. 틀 7개(기본 명령, 캐시, 요청 제한 완성하기, 해시 테이블, 태그 무효화, AOF 재생, 빈 틀)'],
  ['/week2/redis/walkthrough/index.html', '미니 레디스 코드 해설', '핵심 함수 7개: fnv1a/set, 리해시, command/#lookup, activeExpireCycle, SET/AOF 기록, AofFile/loadAof, API + 설명 연습'],
  ['/week2/redis/theory/index.html', '레디스 이론', 'Redis, Redis vs DBMS, 해시 테이블, 충돌, 리해시, TTL, 캐시 전략, 무효화, eviction, 단일 스레드 동시성, AOF/RDB, API, 예상 질문. 예제 2개(버킷, 만료)'],
  ['/week2/redis/deepdive/index.html', '미니 레디스 개념 더 파고들기', '8주제와 실험: 해시 함수 분포, 부하율, 한 번에 vs 점진적 리해시, KEYS 가 막는 시간, 만료 표본 크기, 캐시 스탬피드, AOF 크기, 한계'],
  ['/week2/redis/cheatsheet/index.html', '미니 레디스 한 장 요약', '발표 직전용 10칸, A4 인쇄'],
  ['/week2/redis/docs/index.html', '미니 레디스 설명서', '구조, 해시 테이블, 동시성, 만료, API 목록, 무효화, 영속성, 테스트, 한계'],
  ['/week2/dbms/guide/index.html', '미니 DBMS 학습 가이드', '예측 → 실행 → 확인 → 설명, 볼 순서 8단계, 예제별 질문, 망가뜨리기 목록, 도구, 발표 질문 → 시연, 요구사항 지도'],
  ['/week2/dbms/phase1/index.html', 'Phase 1 · SQL 처리기', 'SQL 실행: 토큰 → AST → 실행 계획 → 결과, 읽은 파일 줄 표시, 예시 SQL 10개, CLI 명령'],
  ['/week2/dbms/phase2/index.html', 'Phase 2 · B+ 트리', '1 B+ 트리 삽입·분할·검색 경로·범위, 2 인덱스 vs 선형 탐색 벤치마크 + 100만 건 결과'],
  ['/week2/dbms/phase3/index.html', 'Phase 3 · API 서버', '1 스레드 풀·읽기/쓰기 락 시뮬레이션(락 끄면 중복 id), 2 실제 스레드 풀 서버에 요청(npm start 일 때)'],
  ['/week2/dbms/examples/index.html', '미니 DBMS 예제', '회원 가입(따옴표 이스케이프, SQL 인젝션), 게시판 목록 캐시, 페이지 넘기기(id 기준 vs OFFSET), 이메일 보조 인덱스 + 망가뜨리기 버튼 3개'],
  ['/week2/dbms/sandbox/index.html', '미니 DBMS 샌드박스', 'sql()·tokenize()·parse()·BPlusTree 로 직접 코딩. 틀 7개(SQL, 토큰과 AST, B+ 트리, 대용량 성능, SQL 인젝션, 레디스+DBMS, 빈 틀)'],
  ['/week2/dbms/walkthrough/index.html', '미니 DBMS 코드 해설', '핵심 함수 9개: tokenize, parse, insert, select/choosePlan, FileStorage, B+ 트리 분할, RWLock, ThreadPool, service.query + 설명 연습'],
  ['/week2/dbms/theory/index.html', 'DBMS 이론', 'DBMS, SQL 처리 흐름, 토크나이저·파서, 저장 형식, 인덱스, B+ 트리, 실행 계획, 스레드 풀, 락, API 서버 구조, 실제 DBMS 와 차이, 예상 질문. 예제 2개(토큰·AST, 실행 계획)'],
  ['/week2/dbms/deepdive/index.html', '미니 DBMS 개념 더 파고들기', '8주제와 실험: 차수와 높이, 순차 삽입 채움률, 인덱스의 비용, 선택도, 실행 계획기, 교착 상태, 스레드 수, 한계'],
  ['/week2/dbms/cheatsheet/index.html', '미니 DBMS 한 장 요약', '발표 직전용 10칸, A4 인쇄'],
  ['/week2/dbms/docs/index.html', '미니 DBMS 설명서', '구조, Phase 1·2·3, 파일 저장 방식, CLI·API 목록, 테스트, 한계'],
];

export const ANCHORS = [
  '/theory/index.html#what (React 란?)', '/theory/index.html#flow (전체 흐름)', '/theory/index.html#browser (Reflow/Repaint)',
  '/theory/index.html#vdom (Virtual DOM)', '/theory/index.html#diff (Diff 동작)', '/theory/index.html#cases (5가지 케이스)',
  '/theory/index.html#key (key)', '/theory/index.html#patch (Patch)', '/theory/index.html#phases (Render/Commit)',
  '/theory/index.html#fiber (Fiber)', '/theory/index.html#hooks-how (Hooks 원리)', '/theory/index.html#hooks-rules (Hooks 규칙)',
  '/theory/index.html#batching (setState와 Batching)', '/theory/index.html#useeffect (useEffect)', '/theory/index.html#usememo (useMemo)',
  '/theory/index.html#lifting (State 위치)', '/theory/index.html#interview (예상 질문)',
  '/deepdive/index.html#snapshot (렌더는 사진)', '/deepdive/index.html#reconcile (재조정 가정)', '/deepdive/index.html#identity (key 정체성)',
  '/deepdive/index.html#lis (LIS 최소 이동)', '/deepdive/index.html#hook-order (Hook 순서 설계)', '/deepdive/index.html#event-loop (이벤트 루프)',
  '/deepdive/index.html#sync (Effect 동기화, 경쟁 상태)', '/deepdive/index.html#equality (불변성)', '/deepdive/index.html#slicing (Fiber 시간 쪼개기)',
  '/deepdive/index.html#two-phase (Render/Commit)', '/deepdive/index.html#tradeoff (VDOM vs Signals)', '/deepdive/index.html#limits (miniReact 한계)',
  '/examples/index.html#ex-cart', '/examples/index.html#ex-form', '/examples/index.html#ex-kanban', '/examples/index.html#ex-list',
  '/examples/index.html#ex-stopwatch', '/examples/index.html#ex-effect', '/examples/index.html#ex-context',
  '/walkthrough/index.html#diff', '/walkthrough/index.html#children', '/walkthrough/index.html#patch',
  '/walkthrough/index.html#render', '/walkthrough/index.html#usestate', '/walkthrough/index.html#update',
  '/guide/index.html#method', '/guide/index.html#roadmap', '/guide/index.html#demo-map',
  '/week2/redis/index.html#console', '/week2/redis/index.html#hashtable', '/week2/redis/index.html#ttl', '/week2/redis/index.html#cache',
  '/week2/redis/index.html#race', '/week2/redis/index.html#aof', '/week2/redis/index.html#api', '/week2/redis/examples/index.html#ex-session',
  '/week2/redis/examples/index.html#ex-rate', '/week2/redis/examples/index.html#ex-lock', '/week2/redis/examples/index.html#ex-likes', '/week2/redis/theory/index.html#hash (해시 테이블)',
  '/week2/redis/theory/index.html#resize (리해시)', '/week2/redis/theory/index.html#ttl (만료)', '/week2/redis/theory/index.html#cache (캐시 전략)', '/week2/redis/theory/index.html#invalidate (무효화)',
  '/week2/redis/theory/index.html#concurrency (동시성)', '/week2/redis/theory/index.html#persistence (영속성)', '/week2/redis/theory/index.html#qa (레디스 예상 질문)', '/week2/dbms/phase1/index.html#sql',
  '/week2/dbms/phase2/index.html#bptree', '/week2/dbms/phase2/index.html#bench', '/week2/dbms/phase3/index.html#pool', '/week2/dbms/phase3/index.html#server',
  '/week2/dbms/examples/index.html#ex-signup', '/week2/dbms/examples/index.html#ex-board', '/week2/dbms/examples/index.html#ex-paging', '/week2/dbms/examples/index.html#ex-email',
  '/week2/dbms/theory/index.html#sqlflow (SQL 처리)', '/week2/dbms/theory/index.html#parser (파서)', '/week2/dbms/theory/index.html#index (인덱스)', '/week2/dbms/theory/index.html#bptree (B+ 트리)',
  '/week2/dbms/theory/index.html#plan (실행 계획)', '/week2/dbms/theory/index.html#threadpool (스레드 풀)', '/week2/dbms/theory/index.html#locks (락)', '/week2/dbms/theory/index.html#qa (DBMS 예상 질문)',
  '/week2/redis/guide/index.html#roadmap', '/week2/redis/guide/index.html#demo-map', '/week2/dbms/guide/index.html#roadmap', '/week2/dbms/guide/index.html#demo-map',
];

export const ROADMAP = [
  '1. 큰 그림: React 란? → Phase 2 써보기',
  '2. Virtual DOM: DOM, Reflow/Repaint, Virtual DOM → Phase 1 트리 패널',
  '3. Diff 5가지 케이스 → Phase 1 예시 케이스를 예측 퀴즈로',
  '4. key → Phase 1 순서 섞기 → 칸반',
  '5. Patch, Render/Commit → Phase 1 단계별 Patch',
  '6. Hooks 원리와 규칙 → Phase 2 Inspector 의 Hook 저장소 → 코드 해설',
  '7. setState 와 Batching → Phase 2 Batching 데모 → 장바구니',
  '8. useEffect, useRef → 스톱워치 → Effect 타이밍',
  '9. 제어 컴포넌트 → 회원가입 폼',
  '10. 성능 → 1,000행 리스트 비교 실행',
  '11. 직접 만들어 보기 → 샌드박스',
  '12. 발표 준비 → 코드 해설 설명 연습 → 한 장 요약 → 시연 짝짓기',
];

export function systemPrompt(progress = [], page = '') {
  return `너는 "miniReact 학습 도우미" 다. 정글 SW-AI 과정 학생이 직접 만든 미니 리액트 프로젝트로 React 의 원리를 공부하도록 돕는다.

## 이 프로젝트
- Vanilla JS 로 직접 만든 Virtual DOM + Diff + Patch (Phase 1) 와 FunctionComponent + Hooks (Phase 2).
- 과제 제약: Hook 은 루트 컴포넌트에서만, 자식은 props 만 받는 순수 함수 (Lifting State Up). 예외로 useContext 는 상태를 만들지 않는 읽기라서 자식에서도 허용.
- 구현: h, domToVNode, createElement, diff(INSERT/REMOVE/REPLACE/TEXT/PROPS + MOVE, key 매칭, LIS 로 이동 최소화), applyPatches(path 기반, 삭제는 뒤에서부터 → 이동·추가 → 자식 재귀),
  useState/useReducer(값 계산 → 같으면 멈춤 → 저장 → queueMicrotask 로 렌더 예약 = Batching), useEffect(화면 그린 뒤), useLayoutEffect(DOM 반영 직후 그리기 전), useMemo/useCallback/useRef, createContext/useContext,
  개발 경고(key 누락, 중복 key), Hook 개수·순서 변화와 무한 업데이트 감지.
- 실제 React 와 차이: Fiber 없이 재귀 비교(중단 불가), Hook 저장은 배열(React 는 연결 리스트), Lane 우선순위 없음, 이벤트 위임 없음, Suspense·SSR 없음.

## 2주차 과제 (같은 사이트. 홈 왼쪽에서 "2주차 미니 레디스" 와 "2주차 미니 DBMS" 를 따로 고르고, 둘은 페이지 묶음이 따로 있다)
- 미니 레디스 (week2/redis): 직접 만든 해시 테이블(FNV-1a, 체이닝, 부하율 1 초과 시 2배, 0.1 미만 시 축소, Redis 처럼 테이블 두 개로 점진적 리해시) 위의 키-값 저장소.
  명령: SET(EX/PX/EXAT/PXAT, NX/XX, KEEPTTL) GET GETDEL MSET MGET DEL EXISTS EXPIRE PEXPIRE PEXPIREAT TTL PTTL PERSIST INCR DECR INCRBY DECRBY KEYS DBSIZE FLUSHALL INFO + 확장 TAG/INVALIDATE/DELPATTERN.
  만료: 읽을 때 지우는 지연 삭제 + 100ms 마다 TTL 키 20개 표본을 지우는 주기 삭제(25% 넘으면 반복). 동시성: 한 스레드에서 동기 함수로 명령 실행 → 명령 하나는 원자적, GET+SET 조합은 아님(INCR, pipeline 사용).
  영속성: AOF(JSON 한 줄, TTL 은 절대 시각 PXAT, INCR 은 결과값 SET 으로 기록), fsync always/everysec/no, 잘린 마지막 줄 무시, 임시 파일 + rename 으로 원자적 재작성. RDB·eviction(LRU)은 미구현.
  외부 사용: HTTP JSON API(/keys/:key GET·PUT·DELETE, /expire, /incr, /invalidate, /command, /pipeline, /info), client.js, 느린 상품 API 에 cache-aside 를 적용한 demo-api(negative caching 포함).
- 미니 DBMS (week2/dbms): Phase 1 SQL 처리기(토크나이저 + 재귀 하강 파서 → AST, INSERT/SELECT, WHERE =,!=,<,<=,>,>=,BETWEEN, AND, LIMIT, 행·열 위치가 붙은 에러, CLI cli.js run/exec/seed/info),
  테이블당 파일(.tbl, CSV 비슷한 한 줄 = 한 레코드, NULL 은 \\N), Phase 2 메모리 B+ 트리(id → 바이트 offset, 차수 64, 리프 연결로 범위 검색, 삭제 미구현), 실행 계획 index-lookup/index-range/full-scan,
  100만 건 측정: INSERT 2.09초, id 조회 0.038ms vs email 선형 탐색 1032ms(약 27,000배), 높이 4. Phase 3 worker_threads 스레드 풀 API 서버(POST /api/sql), 메인 스레드에서 파싱·테이블별 읽기/쓰기 락,
  INSERT 후 다른 워커에 인덱스 갱신을 알린 뒤 락 해제, 잠금 순서 고정으로 교착 방지, 대기 중인 쓰기가 있으면 새 읽기는 뒤로(기아 방지). 트랜잭션·MVCC·행 단위 락은 미구현.
- 질문이 2주차 내용이면 2주차 페이지로 안내하고, 1주차(React)와 연결되는 지점(예: 캐시와 useMemo 는 둘 다 "다시 하지 않기")이 있으면 짧게 짚는다.

## 페이지 (링크는 반드시 아래 경로만 사용. 없는 주소를 지어내지 마라)
${PAGES.map(([href, name, desc]) => `- [${name}](${href}): ${desc}`).join('\n')}
세부 위치: ${ANCHORS.join(', ')}

## 학습 가이드 12단계
${ROADMAP.join('\n')}
공부 방법: 누르기 전에 결과를 예측 → 실행 → 아래 막대의 숫자로 확인 → 틀린 부분을 이론으로 설명.

## 학생이 지금 보고 있는 페이지
${page || '(알 수 없음)'}

## 학생이 체크한 완료 단계
${progress.length ? progress.map((p) => `- ${p}`).join('\n') : '- (아직 없음)'}

## 답변 규칙
- 한국어로, 처음 배우는 사람도 이해하도록 쉽게. 필요하면 일상 비유 하나.
- 질문이 "이 페이지", "여기" 처럼 위치를 가리키면 지금 보고 있는 페이지 기준으로, 그 페이지에서 무엇을 눌러 보면 되는지까지 안내한다.
- 짧게: 보통 3~8문장 또는 짧은 목록. 길게 요청받았을 때만 길게.
- 관련 페이지를 1~3개 안내하고, "어디서 무엇을 눌러 확인하라" 처럼 구체적으로.
- 페이지를 추천하거나 이름을 말할 때는 매번 [이름](/경로) 마크다운 링크로 쓴다. 이름만 굵게 쓰고 링크를 빼지 않는다. 두 곳을 추천하면 링크도 두 개다.
- 링크 주소는 위 목록의 경로를 / 부터 그대로 쓴다 (예: [개념 더 파고들기](/deepdive/index.html#identity)). localhost, 상대 경로, 없는 #위치를 쓰지 않는다.
- 어떤 실험이 어느 페이지에 있는지는 위 페이지 설명에 적힌 것만 말한다. 설명에 없는 버튼이나 실험을 지어내지 않는다.
- 이 프로젝트(miniReact) 기준 설명과 실제 React 설명이 다르면 둘을 구분해서 말한다.
- "Virtual DOM 이 실제 DOM 보다 빠르다" 고 말하지 않는다. 바꿀 곳을 정확히 알고 직접 고치는 게 가장 빠르고, Virtual DOM 은 바꿀 곳을 개발자가 관리하지 않아도 불필요한 DOM 조작을 줄여 주는 절충안이다.
- 학생이 자기 설명을 보여주면 맞은 점, 빠진 점, 고칠 점을 짚어 채점한다.
- 퀴즈를 요청하면 한 문제씩 내고, 학생이 답한 뒤에 정답을 알려준다.
- 모르는 것은 모른다고 하고, 프로젝트에 없는 기능을 있다고 하지 않는다.
- React·웹 프론트엔드·이 과제와 무관한 질문은 한 문장으로 정중히 학습 주제로 돌린다.
- 코드는 \`\`\` 코드 블록으로. HTML 태그를 그대로 쓰지 말고 코드 블록 안에 넣는다.`;
}

// ---------------------------------------------------------------- 요청 검증
export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return '요청 형식이 올바르지 않습니다.';
  const { messages, progress, page } = payload;
  if (!Array.isArray(messages) || messages.length === 0) return '메시지가 없습니다.';
  if (messages.length > MAX_MESSAGES) return `대화가 너무 깁니다 (최대 ${MAX_MESSAGES}개).`;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'model') || typeof m.text !== 'string') return '메시지 형식이 올바르지 않습니다.';
    if (m.text.length > MAX_CHARS) return `메시지가 너무 깁니다 (최대 ${MAX_CHARS}자).`;
  }
  if (messages.at(-1).role !== 'user') return '마지막 메시지는 사용자 질문이어야 합니다.';
  if (page !== undefined && (typeof page !== 'string' || page.length > 120)) return '페이지 정보 형식이 올바르지 않습니다.';
  if (progress !== undefined && (!Array.isArray(progress) || progress.some((p) => typeof p !== 'string' || p.length > 100))) return '진행 상황 형식이 올바르지 않습니다.';
  return null;
}

export function buildGeminiRequest({ messages, progress = [], page = '' }) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt(progress.slice(0, 20), page) }] },
    contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
  };
}

export function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text ?? '').join('').trim() : '';
  if (text) return { text };
  const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
  return { error: reason ? `답변을 만들지 못했습니다 (${reason}). 질문을 바꿔 보세요.` : '빈 답변이 왔습니다. 다시 시도해 보세요.' };
}

// ---------------------------------------------------------------- 모델 선택
/** 503(요청 몰림), 429(한도 초과)는 잠깐의 문제라 다른 모델로 바꿔 시도할 가치가 있다 */
const RETRYABLE = new Set([429, 503]);

/**
 * 시도할 모델 순서: GEMINI_MODEL → GEMINI_FALLBACK_MODELS(쉼표로 구분)
 * 기본은 빠른 gemini-flash-lite-latest 를 먼저, 바쁠 때만 gemini-flash-latest.
 * (gemini-flash-latest 가 자주 "요청 몰림" 으로 6초쯤 기다리다 실패해서, 가벼운 모델을 먼저 쓰는 쪽이 3~4배 빨랐다)
 */
export function modelChain() {
  const primary = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-flash-latest').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

// ---------------------------------------------------------------- HTTP 핸들러
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleChat(req, res) {
  if (req.method === 'GET') {
    // 상태 확인용: 키 값 자체는 절대 내보내지 않는다
    const [model, ...fallbacks] = modelChain();
    send(res, 200, { enabled: Boolean(process.env.GEMINI_API_KEY), model, fallbacks });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'POST 만 지원합니다.' });
    return;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    send(res, 503, { error: 'NO_KEY', message: '서버에 GEMINI_API_KEY 가 설정되지 않았습니다.' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    send(res, e.status ?? 400, { error: e.status === 413 ? '요청이 너무 큽니다.' : 'JSON 형식이 아닙니다.' });
    return;
  }
  const invalid = validatePayload(payload);
  if (invalid) {
    send(res, 400, { error: invalid });
    return;
  }

  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const models = modelChain();
  const body = JSON.stringify(buildGeminiRequest(payload));
  let upstream = null;
  let data = null;
  let model;
  let timedOut = false;
  try {
    // 시도마다 따로 시간 제한을 둔다. 기본 모델이 바쁘거나(503/429) 너무 느리면 다음 모델로 넘어간다
    for (model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeout());
      try {
        upstream = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
          signal: controller.signal,
        });
        data = await upstream.json().catch(() => null);
        timedOut = false;
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
        timedOut = true;
        upstream = null;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (!RETRYABLE.has(upstream.status)) break;
    }
    if (!upstream) {
      send(res, 504, { error: timedOut ? '모든 모델의 응답이 너무 오래 걸립니다. 잠시 후 다시 시도해 보세요.' : 'Gemini 에 연결하지 못했습니다.' });
      return;
    }
    if (!upstream.ok) {
      const msg = data?.error?.message || `HTTP ${upstream.status}`;
      const hint = upstream.status === 400 || upstream.status === 403 ? ' (API 키가 올바른지 확인하세요)' : RETRYABLE.has(upstream.status) ? ' (모든 모델이 바쁩니다. 잠시 후 다시 시도하세요)' : '';
      send(res, 502, { error: `Gemini 오류: ${msg}${hint}` });
      return;
    }
    const out = extractText(data);
    send(res, out.text ? 200 : 502, { ...out, model, fallback: model !== models[0] });
  } catch (e) {
    send(res, 504, { error: `Gemini 에 연결하지 못했습니다: ${e.message}` });
  }
}
