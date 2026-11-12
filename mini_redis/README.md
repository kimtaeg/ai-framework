# Mini Redis

Python 내장 `dict` 없이 **해시 테이블을 직접 구현**해서 만든 키-값 저장소입니다. HTTP API로 사용할 수 있고, TTL 만료, 캐시 무효화, AOF 영속화를 지원합니다.
마지막에는 느린 API 앞에 캐시로 붙였을 때의 성능 차이를 측정했습니다.

- 언어/스택: Python 3.11+ (개발 환경 3.13.9), FastAPI, uvicorn, Pydantic v2, pytest, httpx
- 테스트: 123개 (통과 122 + 의도된 실패 시연 xfail 1)

---

## 1. 요구사항별 대응표

| 요구사항 | 어떻게 해결했나 | 담당 파일 / 함수 |
|---|---|---|
| 해시 테이블 직접 구현 (dict 금지) | 분리 체이닝, FNV-1a 64비트 해시, 부하율 0.75 초과 시 2배 리사이징 | `core/hashtable.py` — `HashTable`, `Node`, `fnv1a_64()` |
| 키-값 저장소 | 값용·만료시각용 HashTable 두 개 | `core/store.py` — `MiniRedis` (`_data`, `_expires`) |
| 외부에서 HTTP API로 사용 | FastAPI 엔드포인트 13개 + Python 클라이언트 | `server/routes.py`, `server/app.py`, `client.py` |
| 동시성 문제 없음 | 싱글 스레드 이벤트 루프 + 모든 엔드포인트 `async def` + await 없는 저장소 메서드 + `threading.Lock` 안전망 + 서버 쪽 `incr` | `server/routes.py` 상단 주석, `MiniRedis._lock`, `MiniRedis.incr()` |
| 만료(TTL) 처리 | 절대 시각 저장. Lazy(조회 시 검사)와 Active(100ms마다 표본 청소)를 함께 사용 | `MiniRedis._expire_if_needed()`, `core/expiry.py` — `active_expire_cycle()`, `server/app.py` — `active_expire_loop()` |
| 데이터 무효화 | DEL, 패턴 삭제, 전체 삭제, TTL, 덮어쓰기. 데모에서는 수정 시 키 삭제 | `delete()`, `delete_pattern()`, `flush_all()`, `demo/cached_api.py` — `update_product()` |
| 서버 다운 시 데이터 보존 | AOF(JSON 한 줄씩 기록), 시작 시 replay, rewrite로 압축 | `core/persistence.py` — `AOF.append()/replay()/rewrite()` |
| 단위 테스트 | 자료구조와 저장소를 가짜 시계로 검증 | `tests/test_hashtable.py`, `tests/test_store.py`, `tests/test_persistence.py` |
| 기능 테스트 | HTTP 엔드포인트, 에지 케이스, 데모 흐름 | `tests/test_api.py` |
| 동시성 테스트 | 실제 uvicorn 서버에 동시 요청 1000개 | `tests/test_concurrency.py` |
| 캐시 사용/미사용 성능 비교 | 느린 원본 API와 캐시 API 비교, HashTable vs dict 비교 | `demo/slow_api.py`, `demo/cached_api.py`, `bench/benchmark.py` |

---

## 2. 실행 방법

모든 명령은 **저장소 루트(`ai-framework/`)에서** 실행합니다. 패키지 이름이 `mini_redis`라서, 그 바깥 폴더에서 실행해야 `import mini_redis...`가 동작합니다.

### 설치
```bash
python3 -m venv mini_redis/.venv
source mini_redis/.venv/bin/activate
pip install -r mini_redis/requirements.txt
```

### 서버 실행 순서 (터미널 3개)
```bash
# 1) Mini Redis — 포트 8000 (반드시 워커 1개)
uvicorn mini_redis.server.app:app --workers 1 --port 8000

# 2) 느린 원본 API — 포트 8001
uvicorn mini_redis.demo.slow_api:app --port 8001

# 3) 캐시를 붙인 API — 포트 8002
uvicorn mini_redis.demo.cached_api:app --port 8002
```

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `MINI_REDIS_AOF` | `data/appendonly.aof` | AOF 파일 경로. 빈 문자열이면 AOF를 끕니다 |
| `MINI_REDIS_FSYNC` | `everysec` | `always` / `everysec` / `no` |
| `SLOW_API_DELAY` | `0.5` | slow_api가 응답 전에 기다리는 시간(초) |
| `MINI_REDIS_URL`, `SLOW_API_URL` | `http://127.0.0.1:8000`, `:8001` | cached_api가 연결할 주소 |

### Swagger 문서
- Mini Redis: http://127.0.0.1:8000/docs
- slow_api: http://127.0.0.1:8001/docs
- cached_api: http://127.0.0.1:8002/docs

### 테스트
```bash
python -m pytest mini_redis/tests -v                       # 전체 (약 8초)
python -m pytest mini_redis/tests/test_hashtable.py -v     # 파일 하나만
python -m pytest mini_redis/tests -k demo -v               # 이름에 demo 가 들어간 테스트만
```

### 벤치마크와 데모
```bash
python -m mini_redis.bench.benchmark                       # 서버 3개를 띄운 상태에서
python -m mini_redis.bench.benchmark --only-hashtable      # 서버 없이 자료구조 비교만
python -m mini_redis.demo.race_demo                        # 서버 쪽 incr 과 Lock 이 필요한 이유 시연
```

---

## 3. 폴더 구조

```
mini_redis/
├── core/                    ← 웹을 전혀 모르는 순수 Python (단독 테스트 가능)
│   ├── hashtable.py         해시 테이블: Node, HashTable, fnv1a_64, MISSING 센티넬
│   ├── store.py             MiniRedis: set/get/delete/expire/ttl/persist/incr/keys/delete_pattern/flush_all/stats
│   │                        + AOF 전용 apply_command/snapshot, active 만료용 sample_expire
│   ├── expiry.py            active_expire_cycle: 표본 20개, 25% 초과면 반복, 최대 25ms
│   └── persistence.py       AOF: append/flush/close/replay/rewrite, AOFCorruptError
├── server/                  ← FastAPI 껍데기 (검증 + 변환만)
│   ├── app.py               create_app: 저장소 1개, lifespan(replay·백그라운드 태스크·종료 flush), 에러 형식 통일
│   ├── routes.py            엔드포인트 13개, 의존성 get_store/valid_key, 크기 제한
│   ├── schemas.py           Pydantic 요청/응답 모델 (strict 정수 검증)
│   └── thread_server.py     running_server: 실제 uvicorn 을 스레드로 (테스트·데모용)
├── client.py                MiniRedisClient(동기) / AsyncMiniRedisClient(비동기), MiniRedisUnavailable
├── demo/
│   ├── slow_api.py          0.5초 걸리는 원본 상품 API (포트 8001)
│   ├── cached_api.py        Cache-Aside 캐시 API (포트 8002): HIT / MISS / BYPASS
│   └── race_demo.py         GET→SET 유실, Lock 유무 비교 시연
├── bench/
│   └── benchmark.py         캐시 유무 비교 + HashTable vs dict → bench/result.json
├── tests/
│   ├── fakes.py             FakeClock (가짜 시계)
│   ├── test_hashtable.py    22개
│   ├── test_store.py        23개
│   ├── test_persistence.py  19개
│   ├── test_api.py          49개
│   └── test_concurrency.py  10개
└── requirements.txt
```

---

## 4. 전체 동작 흐름

### 4-1. 요청 하나가 처리되는 과정 (`PUT /keys/user:1 {"value": {...}, "ttl": 60}`)

```
클라이언트 (curl / MiniRedisClient / cached_api)
   │  HTTP 요청
   ▼
uvicorn (워커 1개, 이벤트 루프 1개 = 스레드 1개)
   │
   ▼
FastAPI 라우터 ─ server/routes.py
   │  ① 경로 매칭: /keys/{key:path}/ttl 같은 하위 경로를 먼저 검사 → 없으면 /keys/{key:path}
   │  ② 의존성 실행: get_store()  → app.state.store (MiniRedis 하나)
   │                 valid_key()  → 1~512자, /ttl·/expire 등으로 끝나면 400
   │  ③ 본문 검증: SetRequest (schemas.py) → ttl 은 strict 양의 정수, 아니면 422
   │  ④ check_value_size() → JSON 직렬화 1MB 초과면 413
   ▼
MiniRedis.set()  ─ core/store.py           ┐
   │  with self._lock:   (안전망)            │
   │  ⑤ _data.put(key, value)               │ 이 구간에 await 가 없다
   │  ⑥ _expires.put(key, now + ttl)        │ → 다른 요청이 끼어들 수 없음
   │  ⑦ _log("SET", key, value, expire_at)  │
   ▼                                        │
HashTable.put() ─ core/hashtable.py         │
   │  fnv1a_64(key) & (capacity-1) → 버킷   │
   │  체인 검색 → 덮어쓰기 or 앞에 삽입       │
   │  size > capacity×0.75 → _resize(2배)   │
   ▼                                        │
AOF.append() ─ core/persistence.py          │
   │  {"cmd":"SET","args":[...]} 한 줄       │
   │  always: 즉시 fsync / everysec: 버퍼     ┘
   ▼
응답 {"key": "user:1", "value": {...}, "ttl": 60}
```

조회(`GET /keys/{key}`)는 ⑤ 대신 **lazy 만료 확인**을 먼저 합니다.
```
MiniRedis.get(key, MISSING)
   └─ _expire_if_needed(key)
        ├─ _expires 에 없음        → 만료 없는 키, 통과
        ├─ now < expire_at         → 아직 살아 있음, 통과
        └─ now >= expire_at        → _data, _expires 에서 삭제, expired += 1
   └─ _data.get(key, MISSING)
        ├─ MISSING → misses += 1 → 404 KEY_NOT_FOUND
        └─ 값      → hits += 1   → 200 (값이 null 이어도 200)
```

### 4-2. 서버 시작부터 종료까지 (`server/app.py` 의 `lifespan`)

```
uvicorn 시작
   │
   ▼
lifespan 시작 부분 (아직 요청을 받지 않음)
   │  ① aof.replay(store)  ── AOF 파일을 처음부터 읽어 store.apply_command() 로 재실행
   │       · 절대 만료 시각이 이미 지난 키는 버림
   │       · 마지막 줄이 잘려 있으면 경고 후 잘라냄, 중간이 깨졌으면 AOFCorruptError 로 시작 중단
   │  ② asyncio.create_task(aof_flush_loop)     ── everysec 일 때 1초마다 aof.flush()
   │  ③ asyncio.create_task(active_expire_loop) ── 100ms 마다 active_expire_cycle()
   ▼
yield  ──────────── 이 동안 요청 처리 ────────────
   │
   │   이벤트 루프 (스레드 1개)
   │   ┌───────────────────────────────────────────────────────────┐
   │   │ 요청A 처리 │ 요청B 처리 │ active 만료 │ 요청C │ fsync │ ...   │
   │   └───────────────────────────────────────────────────────────┘
   │     ↑ 한 번에 하나씩만 실행. 전환은 await 지점에서만 일어남
   ▼
lifespan 종료 부분 (SIGTERM / Ctrl+C)
   │  ④ 백그라운드 태스크 cancel
   │  ⑤ aof.close() ── 버퍼에 남은 명령을 fsync 하고 파일 닫기
   ▼
종료
```

### 4-3. Active 만료 한 번 (`core/expiry.py`)

```
active_expire_cycle(store)
  start = perf_counter()
  반복:
    sampled, expired = store.sample_expire(20)   # expires 테이블에서 random_key() 20번
    sampled == 0          → 멈춤 (만료 걸린 키 없음)
    expired/sampled ≤ 25% → 멈춤 (청소할 게 적음)
    25ms 경과             → 멈춤 (나머지는 100ms 뒤 다음 주기에)
```

### 4-4. 데모: Cache-Aside (`demo/cached_api.py`)

```
GET /products/7  (포트 8002)
   │
   ├─ cache.get("product:7")  ── Mini Redis(8000)
   │     ├─ 연결 실패(MiniRedisUnavailable) → slow_api 호출 → X-Cache: BYPASS
   │     ├─ 값 있음                         → 바로 반환       → X-Cache: HIT   (약 13ms)
   │     └─ 없음
   │           └─ slow_api(8001) 호출 (0.5초)
   │                 └─ cache.set("product:7", 상품, ttl=60) → X-Cache: MISS (약 500ms)
   │
PUT /products/7
   ├─ slow_api 원본 수정 (version+1)
   └─ cache.delete("product:7")  → 다음 GET 은 MISS 로 최신 값을 다시 캐시
```

---

## 5. 핵심 설계

### 5-1. 해시 테이블 (`core/hashtable.py`)

```
_buckets (list, 크기 = capacity, 항상 2의 거듭제곱)
 [0] None
 [1] ──► Node(key="b", value=2) ──► Node(key="q", value=9) ──► None
 [2] None
 [3] ──► Node(key="a", value=1) ──► None
 ...
```

| 설계 | 내용 | 이유 |
|---|---|---|
| 분리 체이닝 | 같은 버킷에 들어온 키는 단일 연결 리스트로 잇고, 새 노드는 맨 앞에 넣음 | 구현이 단순하고 삭제가 쉬움 (개방 주소법은 삭제 표시가 필요) |
| FNV-1a 64비트 | 시작값 `0xcbf29ce484222325`에 바이트마다 `XOR → ×0x100000001b3 → & 64비트 마스크`. 키는 UTF-8 바이트로 변환 | 짧은 코드로 고른 분포. 내장 `hash()`는 실행마다 값이 바뀌어 재현이 안 됨 |
| 비트 AND 인덱스 | `hash & (capacity - 1)` | 용량이 2의 거듭제곱이면 `%`와 결과가 같고 더 빠름 |
| 리사이징 | `size > capacity × 0.75`이면 2배로 늘리고 전체 rehash. 노드 객체는 재사용하고 `next`만 바꿈 | 체인을 짧게 유지. 키는 "원래 칸" 또는 "원래 칸 + 옛 용량"으로만 이동 |
| `MISSING` 센티넬 | `object()`로 만든 유일한 객체 | `None`을 값으로 저장할 수 있게 하려고. `get(k, MISSING) is MISSING`이면 키 없음 |
| `random_key()` | 무작위 버킷에서 시작해 비어 있지 않은 버킷을 찾고, 그 체인에서 하나를 고름 | Active 만료의 표본 추출용. 한 바퀴 안에 반드시 끝남 |

시간 복잡도
| 연산 | 평균 | 최악 | 설명 |
|---|---|---|---|
| `put` / `get` / `remove` / `contains` | O(1) | O(n) | 최악은 모든 키가 한 버킷에 몰릴 때 |
| `_resize` | O(n) | O(n) | 용량을 2배씩 키우므로 `put` 비용을 나눠 보면 O(1) (분할 상환) |
| `keys()` | O(n + capacity) | | 제너레이터라 메모리는 O(1) |

### 5-2. 동시성: 싱글 스레드인데 왜 안전한가

1. **uvicorn 워커 1개**: 프로세스가 하나라서 저장소도 하나입니다. 워커가 여러 개면 프로세스마다 저장소가 따로 생깁니다.
2. **모든 엔드포인트와 의존성은 `async def`**: FastAPI는 일반 `def` 함수를 스레드 풀에서 실행합니다. 그러면 여러 스레드가 동시에 저장소를 건드립니다. `async def`는 이벤트 루프 스레드 하나에서만 실행됩니다. 자세한 설명은 `server/routes.py` 상단 주석에 있습니다.
3. **저장소 메서드에는 `await`가 없음**: 이벤트 루프는 `await`에서만 다른 코루틴으로 넘어갑니다. 그래서 `MiniRedis.incr()`이 실행되는 동안에는 다른 요청이 절대 끼어들지 못합니다. Redis의 싱글 스레드 모델과 같은 원리입니다.
4. **백그라운드 태스크도 같은 루프**: `active_expire_loop`와 `aof_flush_loop`는 스레드가 아니라 asyncio 태스크입니다. 저장소와 동시에 실행되지 않습니다.
5. **`threading.Lock` 안전망**: 누군가 저장소를 스레드에서 직접 쓰더라도 안전하게 하려고 모든 공개 메서드를 `with self._lock:`으로 감쌌습니다. 공개 메서드끼리는 서로 부르지 않고 Lock 없는 내부 도우미(`_expire_if_needed`, `_delete`)를 씁니다. `Lock`은 같은 스레드가 두 번 잡으면 데드락이 나기 때문입니다. 잠그는 순서는 항상 저장소 Lock → AOF Lock입니다.
6. **서버 쪽 `incr`**: 서버가 요청 하나를 원자적으로 처리해도, 클라이언트가 GET 후 SET으로 증가시키면 두 요청 사이에 다른 요청이 끼어듭니다. 읽기·수정·쓰기를 요청 하나로 묶은 것이 `POST /keys/{key}/incr`입니다.

`python -m mini_redis.demo.race_demo` 실측 결과
```
[실험 1] HTTP 동시 요청 1000개
  GET 후 SET (클라이언트 증가):   152  ← 848번의 증가가 사라짐
  POST /incr (서버 증가)      :  1000
[실험 2] 스레드 8개 × 20,000번 store.incr (기대값 160,000)
  Lock 없음: 64,654  ← 95,346번 유실
  Lock 있음: 160,000
```

### 5-3. TTL

- **절대 시각 저장**: `expire_at = clock() + ttl`을 `_expires` 테이블에 넣습니다. AOF에도 절대 시각으로 기록하므로 재시작해도 TTL이 늘어나지 않습니다.
- **시계 주입**: `MiniRedis(clock=time.time)`. 테스트는 `FakeClock`을 넣고 `clock.advance(9.9)`처럼 시간을 직접 움직입니다. sleep 없이 0.1초 경계까지 검증합니다.
- **Lazy 만료**: 키를 다루는 모든 메서드가 먼저 `_expire_if_needed()`를 호출합니다. `now >= expire_at`이면 삭제하고 없는 키로 처리합니다.
- **Active 만료**: Lazy만 있으면 다시 읽지 않는 키가 메모리에 계속 남습니다. 그래서 100ms마다 `active_expire_cycle()`이 표본 20개를 검사하고, 만료 비율이 25%를 넘으면 반복합니다. 한 번에 최대 25ms로 제한해서 요청이 오래 멈추지 않게 합니다.
- **`ttl()` 반환값**: -2는 키 없음, -1은 만료 없음, 그 외에는 남은 초를 **올림**한 값입니다. 0.3초 남은 키가 0을 돌려주면 이미 사라진 키처럼 보이기 때문입니다.
- Redis와 같은 규칙: `set`은 기존 TTL을 지우고, `incr`은 TTL을 유지하고, `persist`는 TTL을 제거하고, `expire(key, 0 이하)`는 키를 즉시 삭제합니다.

### 5-4. 데이터 무효화 5가지

| 방식 | API | 함수 | 언제 쓰나 |
|---|---|---|---|
| ① TTL 만료 | `PUT` 의 `ttl`, `POST /keys/{k}/expire` | `set(ttl=)`, `expire()` + lazy/active 만료 | 일정 시간 뒤 자동으로 오래된 값 제거. 무효화를 놓쳤을 때의 최후 안전망 |
| ② 단일 키 삭제 | `DELETE /keys/{k}` | `delete()` | 원본이 바뀌었을 때 (cached_api의 `PUT`이 이 방식) |
| ③ 패턴 삭제 | `DELETE /keys?pattern=product:*` | `delete_pattern()` | 한 종류의 캐시를 한꺼번에 비울 때. pattern이 없으면 400 (실수로 전체 삭제 방지) |
| ④ 전체 삭제 | `POST /flush` | `flush_all()` | 배포·스키마 변경 등으로 전부 버릴 때 |
| ⑤ 덮어쓰기 | `PUT /keys/{k}` | `set()` | 새 값을 바로 넣을 때. 이전 TTL도 함께 사라짐 |

cached_api는 수정 시 캐시를 **갱신하지 않고 삭제**합니다. 갱신 방식은 동시에 들어온 두 수정의 순서가 꼬이면 옛 값이 캐시에 남을 수 있기 때문입니다. 삭제하면 다음 조회가 원본에서 최신 값을 가져갑니다.

### 5-5. AOF 영속화 (`core/persistence.py`)

```
data/appendonly.aof
{"cmd":"SET","args":["user:1",{"name":"김"}]}
{"cmd":"SET","args":["session",{"id":7},1794467276.30]}   ← 세 번째 인자 = 절대 만료 시각
{"cmd":"EXPIREAT","args":["user:1",1794467300.0]}
{"cmd":"SET","args":["cnt",3]}                            ← INCR 도 결과값 SET 으로 기록
{"cmd":"DEL","args":["tmp"]}
```

- **기록 (`MiniRedis._log` → `AOF.append`)**: 쓰기가 성공했을 때만 기록하고, 읽기나 실패한 쓰기는 기록하지 않습니다.
  - `incr`은 `INCR`이 아니라 결과값으로 `SET`을 기록합니다. 복구 시점에 키가 만료됐는지에 따라 결과가 달라지지 않게 하려는 것입니다.
  - `delete_pattern`은 실제로 지운 키를 하나씩 `DEL`로 기록합니다.
- **fsync 정책**

  | 정책 | 동작 | 유실 가능 범위 | 속도 |
  |---|---|---|---|
  | `always` | 명령마다 `flush()` + `os.fsync()` | 없음 | 가장 느림 |
  | `everysec` (기본) | 버퍼에 모았다가 `aof_flush_loop`가 1초마다 fsync | 최대 1초 | 빠름 |
  | `no` | 명령마다 OS에만 넘기고 fsync는 OS가 알아서 | OS가 죽으면 유실 | 가장 빠름 |

- **replay**: 서버가 요청을 받기 **전에** `store.apply_command()`로 다시 실행합니다. 이 메서드는 `_log`를 부르지 않으므로 같은 줄이 다시 쌓이지 않습니다.
  - 마지막 줄이 깨졌으면 기록 도중 죽은 흔적으로 보고, 경고를 남긴 뒤 `os.truncate`로 잘라냅니다. 그대로 두면 다음 기록이 깨진 줄 뒤에 붙어서 파일 중간이 깨진 상태가 됩니다.
  - 중간 줄이 깨졌으면 `AOFCorruptError`를 내고 시작하지 않습니다.
- **rewrite (`POST /admin/rewrite-aof`)**:
  - `store.snapshot(callback)`이 저장소 Lock을 잡은 채로, 살아 있는 키만 `SET` 명령으로 임시 파일에 씁니다. 그다음 fsync하고 `os.replace`로 원자적으로 교체한 뒤 폴더까지 fsync합니다.
  - Lock을 잡고 있는 동안 다른 쓰기는 기다립니다. 그 사이에 들어온 쓰기가 옛 파일에 기록됐다가 사라지는 일을 막기 위해서입니다.
  - 예를 들어 `incr` 1000번이면 1000줄이 1줄로 줄어듭니다.

---

## 6. API 명세

에러 응답은 모두 `{"error": "코드", "message": "설명"}` 형식입니다.

| 메서드 | 경로 | 요청 본문 | 성공 응답 | 에러 |
|---|---|---|---|---|
| PUT | `/keys/{key}` | `{"value": any, "ttl": int\|null}` | 200 `{key, value, ttl}` (ttl 없으면 -1) | 400 키, 413 값 1MB 초과, 422 검증, 400 잘못된 JSON |
| GET | `/keys/{key}` | | 200 `{key, value, ttl}` | 404 `KEY_NOT_FOUND` |
| DELETE | `/keys/{key}` | | 200 `{"deleted": true}` | 404 |
| GET | `/keys/{key}/ttl` | | 200 `{key, ttl}` (-1 = 만료 없음) | 404 |
| POST | `/keys/{key}/expire` | `{"ttl": int}` | 200 `{key, ttl}` | 404, 422 |
| POST | `/keys/{key}/persist` | | 200 `{key, persisted}` | 404 |
| POST | `/keys/{key}/incr` | `{"amount": int}` (생략 시 1) | 200 `{key, value}` | 409 `NOT_INTEGER`, 422 |
| GET | `/keys?pattern=*` | | 200 `{"keys": [...]}` (정렬됨) | |
| DELETE | `/keys?pattern=...` | | 200 `{"deleted": n}` | 400 `PATTERN_REQUIRED` |
| POST | `/flush` | | 200 `{"flushed": true}` | |
| GET | `/stats` | | 200 `{keys, capacity, load_factor, hits, misses, expired}` | |
| GET | `/health` | | 200 `{"status": "ok"}` | |
| POST | `/admin/rewrite-aof` | | 200 `{"rewritten": true, "commands": n}` | 409 `AOF_DISABLED` |

검증 규칙
- 키는 1~512자입니다. 한글, 이모지, 공백, 콜론, 슬래시 모두 허용합니다. 단 `/ttl`, `/expire`, `/persist`, `/incr`로 끝나는 키는 금지합니다. `/keys/foo/ttl`이 "키 `foo/ttl` 조회"인지 "키 `foo`의 TTL 조회"인지 구분할 수 없기 때문입니다.
- `ttl`과 `amount`는 strict 정수입니다. `"10"`, `1.5`, `true`는 422이고, `ttl`은 0 이하도 422입니다.
- 값은 JSON 직렬화 결과가 UTF-8 기준 1MB(1,048,576바이트)를 넘으면 413입니다.

### curl 예시
```bash
# 저장 (TTL 60초)
curl -X PUT localhost:8000/keys/user:1 -H 'content-type: application/json' \
     -d '{"value": {"name": "김정글"}, "ttl": 60}'
# → {"key":"user:1","value":{"name":"김정글"},"ttl":60}

# 조회 / TTL
curl localhost:8000/keys/user:1            # → {"key":"user:1","value":{"name":"김정글"},"ttl":58}
curl localhost:8000/keys/user:1/ttl        # → {"key":"user:1","ttl":58}

# 한글·슬래시 키는 URL 인코딩 (세션:kim/a)
curl -X PUT "localhost:8000/keys/%EC%84%B8%EC%85%98%3Akim%2Fa" -H 'content-type: application/json' -d '{"value": 1}'

# 카운터
curl -X POST localhost:8000/keys/visits/incr                                   # → {"key":"visits","value":1}
curl -X POST localhost:8000/keys/visits/incr -H 'content-type: application/json' -d '{"amount": 10}'

# 만료 설정 / 해제
curl -X POST localhost:8000/keys/user:1/expire -H 'content-type: application/json' -d '{"ttl": 5}'
curl -X POST localhost:8000/keys/user:1/persist                                # → {"key":"user:1","persisted":true}

# 패턴 조회 / 패턴 삭제 / 전체 삭제
curl "localhost:8000/keys?pattern=user:*"
curl -X DELETE "localhost:8000/keys?pattern=product:*"                         # → {"deleted":20}
curl -X POST localhost:8000/flush

# 상태 / AOF 압축
curl localhost:8000/stats
curl -X POST localhost:8000/admin/rewrite-aof                                  # → {"rewritten":true,"commands":3}

# 에러 예시
curl localhost:8000/keys/nope        # → 404 {"error":"KEY_NOT_FOUND","message":"키 'nope' 가 없습니다"}
curl -X DELETE localhost:8000/keys   # → 400 {"error":"PATTERN_REQUIRED",...}

# 캐시 데모
curl -i localhost:8002/products/1    # X-Cache: MISS (약 0.5초)
curl -i localhost:8002/products/1    # X-Cache: HIT
curl -X PUT localhost:8002/products/1 -H 'content-type: application/json' -d '{"price": 9900}'
curl -i localhost:8002/products/1    # X-Cache: MISS (무효화됨, 새 가격)
```

Python 클라이언트
```python
from mini_redis.client import MiniRedisClient, MiniRedisUnavailable

with MiniRedisClient("http://127.0.0.1:8000") as r:
    r.set("user:1", {"name": "kim"}, ttl=60)
    r.get("user:1")          # {'name': 'kim'}   (없으면 None)
    r.incr("visits")         # 1
    r.ttl("user:1")          # 60 / -1 / -2
    r.delete_pattern("user:*")
```
async 앱 안에서는 `AsyncMiniRedisClient`를 쓰고 `await r.get(...)`처럼 호출합니다(`cached_api.py`가 이 방식입니다).

---

## 7. 테스트 전략

| 파일 | 종류 | 개수 | 다루는 내용 |
|---|---|---|---|
| `test_hashtable.py` | 단위 | 22 | FNV-1a 공개 테스트 벡터, put/get/remove, 덮어쓰기 시 개수 유지, None 값과 `MISSING` 구분, **강제 충돌**(같은 버킷 키 5개), 체인 **맨 앞/중간/끝 삭제**, **13번째 put에서 용량 32**, 용량이 항상 2의 거듭제곱, 1만 개 삽입 후 절반 삭제, 한글·이모지·가족 이모지(ZWJ)·빈 문자열 키, `random_key` |
| `test_store.py` | 단위 | 23 | `FakeClock`으로 **9.9초에는 있음 / 10초에는 없음**, 조회 순간 내부에서도 삭제됨, 덮어쓰면 TTL 제거, persist, expire(없는 키, 0 이하), ttl -2/-1/올림, incr(신규·누적·문자열 "5"·실수·만료 후 1부터·TTL 유지), 패턴(`*`, `?`, 대소문자 구분, 만료 제외), hits/misses, **AOF 기록 형식**(절대 시각, 실패한 쓰기는 기록 안 함) |
| `test_persistence.py` | 단위+통합 | 19 | 여러 명령 후 replay하면 같은 상태, FLUSHALL, JSON 줄 형식, replay가 다시 기록하지 않음, **30초 다운 후 TTL 70초**, 다운 중 만료된 키 버림, **마지막 줄 잘림 → 경고·잘라냄·이어쓰기 가능**, 줄바꿈만 빠진 줄, **중간 줄 손상 → 에러**, 모르는 명령, everysec 버퍼/always·no 즉시 기록, **rewrite 후 줄 수 감소·상태 동일·임시 파일 없음**, 앱 lifespan(시작 시 replay, 종료 시 flush), rewrite API |
| `test_api.py` | 기능 | 49 | 모든 엔드포인트의 정상 응답과 상태 코드, 에러 형식 통일, 의존성 교체, **빈 키 / 512자 OK / 513자 400**, 한글·이모지·공백·슬래시·`..`·`%`·`?`·`#`·앞뒤 공백 키, 예약 접미사, **ttl 0·음수·"10"·1.5·true → 422**, **1MB 경계**(정확히 1MB는 OK, 초과는 413, 한글은 바이트로 계산), 잘못된 JSON 400, value 누락, **null 저장 후 조회 200**, **만료 키 404**, 없는 경로 404·405, 실제 uvicorn으로 클라이언트 왕복·에러 변환·연결 실패, **데모: MISS → HIT → PUT → MISS**, 캐시 다운 시 BYPASS, 없는 상품은 캐시 안 함 |
| `test_concurrency.py` | 동시성 | 10 | Active 만료(**만료 100 + 생존 100 → 만료 키만 삭제**, 만료 없는 키 무시, 비율 높으면 반복, 25ms 제한, 비율 낮으면 한 묶음), lifespan 백그라운드 청소, **incr 1000개 동시 요청 → 1~1000이 한 번씩**, set/get 500개 섞어서, 스레드 8개 Lock 안전망, **GET→SET 유실 (xfail strict)** |

테스트를 만들면서 알게 된 것
- `httpx.ASGITransport`는 네트워크 없이 앱을 직접 호출합니다. 그래서 요청 하나가 중간에 멈추지 않고 끝까지 실행되고, `gather`로 1000개를 보내도 실제로는 한 줄로 처리됩니다(유실 0번). 그래서 동시성 테스트는 `server/thread_server.py`의 `running_server()`로 **실제 uvicorn 서버**를 띄우고 소켓으로 보냅니다.
- 시간은 모두 `FakeClock`으로 움직입니다. `time.sleep`을 쓰는 테스트는 없습니다.

---

## 8. 성능 비교 결과

측정 환경: macOS (Apple Silicon), Python 3.13.9. 같은 컴퓨터에서 서버 3개를 실행했고, `slow_api`의 지연은 0.5초입니다. 요청 200회, 동시 10개, 상품 id는 1~20을 순환합니다. 아래 수치는 `bench/result.json`에서 가져왔습니다.

| 구분 | 평균 | p50 | p95 | 처리량 | 히트율 | 원본 호출 |
|---|---:|---:|---:|---:|---:|---:|
| (a) slow_api 직접 (캐시 없음) | 503.1 ms | 502.7 ms | 507.5 ms | 19.9 req/s | - | 200 |
| (b) cached_api, 빈 캐시에서 시작 | 68.7 ms | 12.7 ms | 531.9 ms | 124.9 req/s | 89.5% | 21 |
| (c) cached_api, 캐시가 채워진 상태 | 19.0 ms | 13.2 ms | 44.9 ms | 519.1 req/s | 100% | 0 |

해석
- **평균 응답 시간 7.3배 단축(503 → 69ms), 처리량 6.3배(20 → 125 req/s)**, 원본 호출은 200번에서 21번으로 **89.5% 감소**했습니다.
- (b)의 **p50은 12.7ms인데 p95는 532ms**입니다. 요청 대부분은 캐시에서 나오지만, 처음 상품을 볼 때(MISS)는 원본 속도 그대로라 꼬리 지연이 남습니다. 캐시는 평균을 줄여 주지만 콜드 스타트는 없애지 못합니다. 캐시가 다 차면 (c)처럼 p95도 45ms로 내려갑니다.
- 고유 상품은 20개인데 MISS는 21번이었습니다. 같은 키를 동시에 요청하면, 첫 요청이 캐시를 채우기 전에 두 번째 요청도 원본으로 갑니다(**cache stampede**). 실제 서비스라면 키별 잠금이나 미리 채워 두기(warm-up)로 해결합니다.
- HIT에도 약 13ms가 걸리는 이유는 요청이 cached_api와 Mini Redis를 거치며 HTTP를 두 번 타고, 두 서버가 모두 Python이기 때문입니다. 실제 Redis는 TCP 바이너리 프로토콜과 C 구현이라 이보다 훨씬 빠릅니다.

HashTable vs dict (10만 건)
| | put | get |
|---|---:|---:|
| 직접 만든 `HashTable` | 360.8 ms | 110.9 ms |
| 내장 `dict` | 14.4 ms | 4.5 ms |
| 배율 | 25.1배 느림 | 24.6배 느림 |

- `dict`는 C로 구현돼 있고 해시값을 문자열 객체에 캐시합니다. 우리 `fnv1a_64()`는 매번 Python 반복문으로 바이트를 하나씩 계산합니다. 이 차이가 대부분입니다.
- 그래도 조회 한 번이 약 1.1µs입니다. HTTP 요청 한 번(약 13ms)에 비하면 1만분의 1 수준이라, 실제 서버 성능에서 병목은 자료구조가 아니라 네트워크와 프레임워크입니다.

---

## 9. 발표용 설명

### 왜 싱글 스레드인데 동시성 문제가 없나요?
> uvicorn 워커를 1개로 띄우면 이벤트 루프 하나가 모든 요청을 처리합니다. 이벤트 루프는 한 번에 코루틴 하나만 실행하고, `await`를 만났을 때만 다른 코루틴으로 넘어갑니다.
> 모든 엔드포인트를 `async def`로 만들었고(일반 `def`는 FastAPI가 스레드 풀에서 실행합니다), 저장소 메서드에는 `await`가 하나도 없습니다. 그래서 `incr`이 값을 읽고 더하고 쓰는 도중에 다른 요청이 끼어들 수 없습니다. Redis가 싱글 스레드로 원자성을 보장하는 것과 같은 원리입니다.
> 혹시 저장소를 여러 스레드에서 직접 쓰는 경우에 대비해 `threading.Lock`을 안전망으로 걸었습니다. Lock을 빼면 16만 번 중 9만 번이 사라지는 것을 데모로 보였습니다.
> 다만 서버가 요청 하나를 지켜줘도 클라이언트가 GET 후 SET을 하면 그 사이에 끼어들 수 있습니다. 1000번 중 848번이 사라졌습니다. 그래서 서버 쪽 `incr`을 제공합니다.

### 만료된 값을 요청하면 어떻게 되나요?
> 만료 시각은 절대 시각으로 저장합니다. 키를 다루는 모든 메서드가 먼저 `_expire_if_needed()`로 현재 시각과 비교하고, 지났으면 그 자리에서 지우고 없는 키로 처리합니다(lazy). 그래서 만료된 키를 GET하면 항상 404이고, TTL 조회는 -2입니다.
> 아무도 다시 읽지 않는 키를 위해, 100ms마다 만료가 걸린 키 20개를 무작위로 검사하는 active 만료도 돕니다. 만료 비율이 25%를 넘으면 반복하고, 한 번에 25ms를 넘기지 않아 요청 처리를 오래 막지 않습니다.

### 서버가 죽으면 데이터는 어떻게 되나요?
> 쓰기 명령이 성공할 때마다 AOF 파일에 JSON 한 줄로 덧붙입니다. 서버가 다시 켜지면 요청을 받기 전에 이 파일을 처음부터 재실행해서 상태를 복구합니다.
> 기본 정책 everysec는 1초마다 fsync하므로 최악의 경우 1초치를 잃습니다. always 정책은 `kill -9`로 죽여도 마지막 명령까지 복구되는 것을 확인했습니다.
> 만료 시각을 절대 시각으로 기록하므로 30초 동안 꺼져 있었다면 TTL은 남은 시간으로 복구되고, 그동안 만료된 키는 버려집니다.
> 기록 도중 죽어서 마지막 줄이 잘렸으면 그 줄만 버리고, 중간이 깨졌으면 서버를 띄우지 않고 알립니다. 파일이 커지면 rewrite로 살아 있는 키만 남겨 원자적으로 교체합니다.

---

## 10. 실제 Redis와의 차이

| 항목 | 이번 구현 | 실제 Redis |
|---|---|---|
| 통신 | HTTP + JSON (FastAPI) | TCP 위의 RESP 바이너리 프로토콜. 파이프라이닝, Pub/Sub 지원 |
| 구현 언어/속도 | Python, 요청당 수 ms | C, 초당 수십만 요청 |
| 자료형 | 값은 JSON 하나 (문자열·숫자·객체·배열) | String, List, Hash, Set, Sorted Set, Stream, Bitmap, HyperLogLog 등과 전용 명령 |
| 해시 테이블 리사이징 | 한 번에 전체 rehash (그 순간 O(n) 멈춤) | **점진적 rehash**: 테이블 두 개를 두고 명령마다 조금씩 옮김. 줄어들 때도 축소 |
| 영속화 | AOF만 (JSON 줄) | **RDB 스냅샷**(fork 후 바이너리 덤프) + AOF + 둘을 섞은 방식 |
| AOF rewrite | 저장소 Lock을 잡고 동기로 처리 (그동안 요청 대기) | fork한 자식 프로세스가 쓰고, 그동안 쌓인 명령은 rewrite 버퍼에 모았다가 합침 |
| everysec fsync | 이벤트 루프에서 직접 실행 | 백그라운드 스레드(bio)에서 실행 |
| 메모리 제한 | 없음 | `maxmemory` + **eviction 정책**(LRU, LFU, random, volatile-ttl 등) |
| 만료 | lazy + active (표본 20개, 25%, 25ms) | 같은 아이디어. 키 수와 CPU에 따라 더 정교하게 조절 |
| 원자적 묶음 | `incr` 하나 | `MULTI/EXEC` 트랜잭션, Lua 스크립트, `WATCH` |
| 확장·가용성 | 단일 프로세스 | 복제(replica), Sentinel 자동 장애 조치, Cluster 샤딩(16384 슬롯) |
| 보안 | 없음 | AUTH, ACL, TLS |
| 키 이름 | 1~512자, 하위 경로 접미사 금지 (URL 제약) | 바이너리 안전, 최대 512MB |

---

## 11. 기능 테스트 체크리스트 (수동 확인)

서버 3개를 띄운 뒤 순서대로 확인합니다.

- [ ] `curl localhost:8000/health` → `{"status":"ok"}`
- [ ] `http://127.0.0.1:8000/docs` Swagger에서 엔드포인트 13개 확인
- [ ] PUT 후 GET하면 같은 값이 나오는가, `/stats`의 hits가 1 증가하는가
- [ ] `ttl: 5`로 저장하고 5초 뒤 GET하면 404, `/ttl`은 404인가
- [ ] 저장 후 `expire`로 10초 → `persist` → `/ttl`이 -1인가
- [ ] 값이 `null`인 키를 GET하면 404가 아니라 200 + `"value": null`인가
- [ ] 문자열 값에 `incr`하면 409 `NOT_INTEGER`인가
- [ ] 빈 키(`/keys/`), 513자 키는 400, `ttl: 0`·`"10"`은 422, 1MB 초과 값은 413인가
- [ ] 한글·공백·슬래시 키(`세션:kim/a`)를 URL 인코딩해 저장·조회되는가
- [ ] `DELETE /keys`(pattern 없음)은 400, `?pattern=user:*`은 개수를 반환하는가
- [ ] **재시작 복구**: 값을 넣고 Ctrl+C → 재시작 → 값과 남은 TTL이 그대로인가
- [ ] **강제 종료 복구**: `MINI_REDIS_FSYNC=always`로 실행 → 값 저장 → `kill -9` → 재시작 → 값이 남아 있는가
- [ ] **rewrite**: `incr`을 여러 번 → `wc -l data/appendonly.aof` → `POST /admin/rewrite-aof` → 줄 수가 줄었는가
- [ ] **캐시 데모**: `curl -i localhost:8002/products/1` 두 번 → MISS(약 0.5초) 다음 HIT
- [ ] **무효화**: `PUT localhost:8002/products/1 {"price": 9900}` → 다음 GET이 MISS이고 가격이 9900, version이 2인가
- [ ] **캐시 다운**: Mini Redis를 끄고 `curl -i localhost:8002/products/2` → `X-Cache: BYPASS`로 정상 응답하는가
- [ ] `python -m mini_redis.demo.race_demo` → GET 후 SET 방식에서 유실이 생기고 incr은 1000인가
- [ ] `python -m mini_redis.bench.benchmark` → 표 출력과 `bench/result.json` 생성

---

## 12. Python 문법 가이드 (이 코드의 실제 예시로)

Java·C와 비교하며 이 프로젝트에 나오는 문법만 정리했습니다.

### 클래스
```python
# core/hashtable.py
class Node:
    __slots__ = ("key", "value", "next")    # 속성 목록을 고정 (C 구조체처럼, 메모리 절약)

    def __init__(self, key, value, next=None):   # 생성자. Java 의 Node(...) { } 와 같다
        self.key = key                           # self = Java 의 this. 반드시 첫 인자로 받는다
        self.value = value
        self.next = next
```
- `__init__`, `__len__`, `__contains__`처럼 앞뒤에 밑줄 두 개가 붙은 메서드는 특별한 문법과 연결됩니다.
  - `len(t)`를 쓰면 `t.__len__()`이 호출됩니다.
  - `key in t`를 쓰면 `t.__contains__(key)`가 호출됩니다(`HashTable` 참고).
  - `FakeClock`은 `__call__`이 있어서 `clock()`처럼 함수로 호출할 수 있고, 그래서 `time.time` 자리에 끼워 넣을 수 있습니다.
- 이름이 `_`로 시작하면(`_buckets`, `_lock`) "내부용"이라는 약속입니다. Java의 `private`처럼 막지는 않습니다.
- 상속은 `class MiniRedisUnavailable(MiniRedisError):`처럼 괄호 안에 부모 클래스를 적습니다(Java의 `extends`).

### 데코레이터 (`@`)
함수나 클래스를 감싸서 기능을 덧붙이는 문법입니다. Java 어노테이션과 모양은 비슷하지만, 실제로 함수를 바꿔 끼웁니다.
```python
@property                       # core/hashtable.py: t.capacity 처럼 괄호 없이 읽는 '읽기 전용 속성'
def capacity(self) -> int:
    return len(self._buckets)

@staticmethod                   # core/store.py: self 가 필요 없는 메서드 (Java 의 static 메서드)
def _check_ttl(ttl) -> None: ...

@router.get("/keys/{key:path}/ttl")   # server/routes.py: 이 URL 로 GET 이 오면 아래 함수를 실행하라고 등록
async def get_ttl(...): ...

@pytest.fixture                 # tests: 테스트 인자 이름으로 자동 주입되는 준비물 (JUnit @BeforeEach 비슷)
def clock():
    return FakeClock()

@asynccontextmanager            # server/app.py: yield 앞=시작 시, 뒤=종료 시 실행되는 lifespan 을 만든다
async def lifespan(app): ...
```

### async / await
```python
# server/app.py
async def active_expire_loop(store, interval):   # async def = 코루틴 함수. 호출해도 바로 실행되지 않고 '예약'된다
    while True:
        await asyncio.sleep(interval)    # await = "여기서 잠깐 쉴게, 그동안 다른 일 해" → 이벤트 루프가 다른 요청 처리
        active_expire_cycle(store)       # await 가 없는 일반 호출 → 끝날 때까지 누구도 끼어들지 못함

task = asyncio.create_task(active_expire_loop(store, 0.1))   # 백그라운드에서 돌리기 시작 (스레드 아님)
task.cancel()                                                # 취소

# tests/test_concurrency.py
responses = await asyncio.gather(*coros)  # 여러 코루틴을 동시에 실행하고 모두 기다림 (CompletableFuture.allOf)
```
- 핵심은 **`await`에서만 다른 코루틴으로 넘어간다**는 점입니다. 이것이 이 프로젝트 동시성 설계의 근거입니다.
- `async with`, `async def __aenter__`(client.py `AsyncMiniRedisClient`)는 `with`의 비동기 버전입니다.

### 타입 힌트
```python
def get(self, key: str, default=None): ...                    # key 는 str
def remove(self, key: str) -> bool: ...                       # 반환은 bool
def __init__(self, capacity: int = INITIAL_CAPACITY): ...     # 기본값 있는 int
def keys(self, pattern: str = "*") -> list[str]: ...          # 문자열 리스트
ttl: PositiveTTL | None = None                                # schemas.py: 정수 또는 None (Java 의 @Nullable Integer)
def sample_expire(self, sample_size: int) -> tuple[int, int]  # (int, int) 묶음 반환
PositiveTTL = Annotated[int, Field(strict=True, gt=0)]        # 타입 + 추가 조건 (Pydantic 이 검사)
```
- Python 자체는 실행할 때 타입 힌트를 검사하지 않습니다. 읽는 사람과 도구를 위한 표시입니다.
- **예외**: Pydantic(`schemas.py`)과 FastAPI는 힌트를 읽어서 실제로 검증합니다. 그래서 `ttl: "10"`이 422가 됩니다.

### with 문
들어갈 때 준비하고, 나갈 때(예외가 나도) 반드시 정리합니다. Java의 try-with-resources나 `try/finally`와 같습니다.
```python
with self._lock:                  # core/store.py: 들어갈 때 lock.acquire(), 나갈 때 lock.release()
    self._data.put(key, value)

with open(self.path, "rb") as f:  # core/persistence.py: 블록이 끝나면 파일 자동 close
    raw_lines = f.readlines()

with pytest.raises(TypeError):    # tests: 이 블록에서 TypeError 가 나야 통과
    r.incr("s")

with running_server(app) as url:  # server/thread_server.py: 블록 동안만 서버 실행, 끝나면 종료
    ...
```

### 제너레이터 (`yield`)
```python
# core/hashtable.py
def keys(self):
    for head in self._buckets:
        node = head
        while node is not None:
            yield node.key      # 값을 하나 내보내고 '일시정지'. 다음 값을 요청받으면 여기서 이어서 실행
            node = node.next

for k in table.keys(): ...      # 전체 리스트를 만들지 않고 하나씩 꺼냄 (Java Iterator 와 같음, 메모리 O(1))
list(table.keys())              # 한 번에 리스트로 (순회 중 삭제할 때는 이렇게 먼저 복사 → store._matching_keys)
```
`yield`는 pytest fixture(`yield` 앞은 준비, 뒤는 정리)와 lifespan(앞은 시작, 뒤는 종료)에서도 같은 원리로 쓰입니다.

### 그 밖에 자주 나오는 문법
| 문법 | 예시 (파일) | 의미 |
|---|---|---|
| `*args` | `def append(self, cmd, *args)` (persistence.py) | 가변 인자. Java의 `String... args` |
| `**dict` 펼치기 | `{**current, **changes}` (slow_api.py) | 딕셔너리를 복사하면서 덮어쓰기 |
| f-string | `f"product:{product_id}"` | 문자열 안에 값 넣기 |
| 리스트 컴프리헨션 | `[f"key:{i}" for i in range(n)]` (benchmark.py) | 반복문으로 리스트 만들기 |
| 튜플 언패킹 | `sampled, expired = store.sample_expire(20)` | 여러 값을 한 번에 받기 |
| `for ... else` | `AOF.replay()` | `break` 없이 반복이 끝났을 때만 `else` 실행 |
| `is` 와 `==` | `value is MISSING` | `is`는 같은 객체인지(주소 비교, C의 포인터 비교), `==`는 값이 같은지 |
| `try/except/raise ... from e` | `client.py` `_request()` | 예외를 다른 예외로 바꿔 던지면서 원인을 연결 |
| `lambda` | `lambda t, k: t.get(k)` (benchmark.py) | 한 줄짜리 이름 없는 함수 |
