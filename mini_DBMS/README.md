# miniDBMS — B+ 트리 SQL DBMS

SQL 토크나이저/파서 · B+ 트리 인덱스 · 페이지 스토리지 · 읽기/쓰기 락 · 워커 스레드 풀 API 를 외부 라이브러리 없이 구현했습니다.

| 파일 · 폴더 | 내용 |
| :--- | :--- |
| [`sql.js`](sql.js) · [`engine.js`](engine.js) | SQL 파싱과 실행 |
| [`bptree.js`](bptree.js) | B+ 트리 인덱스 |
| [`storage.js`](storage.js) · [`storage-file.js`](storage-file.js) | 페이지 스토리지 (메모리 · 파일) |
| [`lock.js`](lock.js) · [`pool.js`](pool.js) · [`worker.js`](worker.js) | 읽기/쓰기 락과 워커 스레드 풀 |
| [`server.js`](server.js) · [`service.js`](service.js) · [`cli.js`](cli.js) | HTTP API 서버 · CLI |
| [`bench.js`](bench.js) | 100만 행 벤치마크 |
| `phase1/` ~ `phase3/` · `guide/` · `theory/` · `sandbox/` 등 | 학습 페이지 |

```bash
npm run dbms
```

```bash
npm run bench:dbms
```

학습 페이지는 저장소 루트에서 `npm start` 한 뒤 `/mini_DBMS/phase1/` 로 엽니다.
