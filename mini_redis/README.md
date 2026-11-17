# miniRedis — 해시 테이블 키-값 저장소

FNV-1a 해시 테이블 · 점진적 리해시 · TTL 만료 · 태그/패턴 무효화 · AOF 영속성 · HTTP API 를 외부 라이브러리 없이 구현했습니다.

| 파일 · 폴더 | 내용 |
| :--- | :--- |
| [`hashtable.js`](hashtable.js) · [`miniredis.js`](miniredis.js) | 해시 테이블과 명령어 (GET · SET · TTL · 무효화) |
| [`persistence.js`](persistence.js) | AOF 기록 · 재시작 시 복구 |
| [`api.js`](api.js) · [`server.js`](server.js) · [`client.js`](client.js) | HTTP API 서버와 클라이언트 |
| [`experiment/`](experiment/) | 2주차 발표 실험 (캐시는 정말 몇 배 빠를까?) — Docker 로 E1~E7 재현 |
| [`load/`](load/) | k6 부하 · 한계 측정 스크립트 |
| `guide/` · `theory/` · `walkthrough/` · `sandbox/` 등 | 학습 페이지 |

```bash
npm run redis
```

학습 페이지는 저장소 루트에서 `npm start` 한 뒤 `/mini_redis/` 로 엽니다.
