"""캐시 사용/미사용 성능 비교 + HashTable vs dict 비교.

실행 전 세 서버를 띄워 둔다 (README 의 실행 순서 참고):
    Mini Redis :8000 / slow_api :8001 / cached_api :8002
실행 (ai-framework 폴더에서):
    python -m mini_redis.bench.benchmark
    python -m mini_redis.bench.benchmark --requests 200 --concurrency 10
    python -m mini_redis.bench.benchmark --only-hashtable      # 서버 없이 자료구조 비교만
결과는 표로 출력하고 mini_redis/bench/result.json 에도 저장한다.
"""

import argparse
import asyncio
import json
import os
import platform
import sys
import time

import httpx

from ..core.hashtable import HashTable

MINI_REDIS_URL = "http://127.0.0.1:8000"
SLOW_API_URL = "http://127.0.0.1:8001"
CACHED_API_URL = "http://127.0.0.1:8002"
RESULT_PATH = os.path.join(os.path.dirname(__file__), "result.json")  # 이 파일과 같은 폴더
PRODUCT_IDS = 20


# ---------------------------------------------------------------------------
# 통계 도우미
# ---------------------------------------------------------------------------
def percentile(sorted_values: list[float], p: float) -> float:
    """정렬된 값에서 p 백분위수 (nearest-rank 방식). p95 = 100개 중 95번째로 느린 값."""
    if not sorted_values:
        return 0.0
    rank = max(1, round(p / 100 * len(sorted_values)))  # 1부터 세는 순위
    return sorted_values[rank - 1]


def summarize(name: str, latencies_ms: list[float], wall_seconds: float, cache_headers: list[str], origin_calls) -> dict:
    s = sorted(latencies_ms)
    hits = cache_headers.count("HIT")
    return {
        "name": name,
        "requests": len(s),
        "avg_ms": round(sum(s) / len(s), 2),
        "p50_ms": round(percentile(s, 50), 2),
        "p95_ms": round(percentile(s, 95), 2),
        "throughput_rps": round(len(s) / wall_seconds, 1),  # 초당 처리량 = 요청 수 / 전체 걸린 시간
        # 캐시를 안 쓰는 경로는 히트율 개념이 없으므로 None
        "hit_rate": round(hits / len(s), 3) if any(cache_headers) else None,
        "cache": {h: cache_headers.count(h) for h in ("HIT", "MISS", "BYPASS") if h in cache_headers},
        "origin_calls": origin_calls,
    }


# ---------------------------------------------------------------------------
# HTTP 부하
# ---------------------------------------------------------------------------
async def run_load(base_url: str, n_requests: int, concurrency: int):
    """id 1~20 을 돌려가며 n_requests 번 GET. 동시에 concurrency 개까지 보낸다."""
    sem = asyncio.Semaphore(concurrency)   # 동시에 날아가는 요청 수 제한
    latencies: list[float] = []
    headers: list[str] = []

    async with httpx.AsyncClient(base_url=base_url, timeout=30, limits=httpx.Limits(max_connections=concurrency)) as c:

        async def one(i: int):
            product_id = i % PRODUCT_IDS + 1             # 1, 2, ..., 20, 1, 2, ...
            async with sem:
                t0 = time.perf_counter()
                resp = await c.get(f"/products/{product_id}")
                latencies.append((time.perf_counter() - t0) * 1000)
                resp.raise_for_status()
                headers.append(resp.headers.get("X-Cache", ""))

        start = time.perf_counter()
        await asyncio.gather(*(one(i) for i in range(n_requests)))
        wall = time.perf_counter() - start
    return latencies, wall, headers


async def origin_calls() -> int:
    async with httpx.AsyncClient(base_url=SLOW_API_URL, timeout=5) as c:
        return (await c.get("/stats")).json()["origin_calls"]


async def servers_up() -> list[str]:
    """응답하지 않는 서버 이름 목록."""
    down = []
    async with httpx.AsyncClient(timeout=2) as c:
        for name, url in (("Mini Redis", MINI_REDIS_URL), ("slow_api", SLOW_API_URL), ("cached_api", CACHED_API_URL)):
            try:
                (await c.get(url + "/health")).raise_for_status()
            except httpx.HTTPError:
                down.append(f"{name} ({url})")
    return down


async def http_benchmark(n_requests: int, concurrency: int) -> list[dict]:
    results = []

    # (a) 캐시 없이 원본 직접
    before = await origin_calls()
    lat, wall, hdr = await run_load(SLOW_API_URL, n_requests, concurrency)
    results.append(summarize("(a) slow_api 직접", lat, wall, hdr, await origin_calls() - before))

    # (b) 캐시 사용: 공정한 비교를 위해 캐시를 비우고 시작 (처음 20번은 MISS)
    async with httpx.AsyncClient(base_url=MINI_REDIS_URL) as c:
        await c.post("/flush")
    before = await origin_calls()
    lat, wall, hdr = await run_load(CACHED_API_URL, n_requests, concurrency)
    results.append(summarize("(b) cached_api (빈 캐시에서 시작)", lat, wall, hdr, await origin_calls() - before))

    # (c) 참고: 캐시가 이미 채워진 상태에서 한 번 더 (전부 HIT 일 때의 속도)
    before = await origin_calls()
    lat, wall, hdr = await run_load(CACHED_API_URL, n_requests, concurrency)
    results.append(summarize("(c) cached_api (캐시 채워진 상태)", lat, wall, hdr, await origin_calls() - before))
    return results


# ---------------------------------------------------------------------------
# HashTable vs dict
# ---------------------------------------------------------------------------
def hashtable_benchmark(n: int = 100_000) -> dict:
    keys = [f"key:{i}" for i in range(n)]   # 키 문자열 생성 시간은 측정에서 제외

    def measure(table, put, get):
        t0 = time.perf_counter()
        for i, key in enumerate(keys):
            put(table, key, i)
        t1 = time.perf_counter()
        for key in keys:
            get(table, key)
        t2 = time.perf_counter()
        return round((t1 - t0) * 1000, 1), round((t2 - t1) * 1000, 1)

    ht_put, ht_get = measure(HashTable(), lambda t, k, v: t.put(k, v), lambda t, k: t.get(k))
    # 비교 대상으로만 쓰는 내장 dict (저장소에는 쓰지 않는다)
    d_put, d_get = measure({}, lambda t, k, v: t.__setitem__(k, v), lambda t, k: t.get(k))
    return {
        "n": n,
        "hashtable_put_ms": ht_put,
        "hashtable_get_ms": ht_get,
        "dict_put_ms": d_put,
        "dict_get_ms": d_get,
        "put_ratio": round(ht_put / d_put, 1),
        "get_ratio": round(ht_get / d_get, 1),
    }


# ---------------------------------------------------------------------------
# 출력
# ---------------------------------------------------------------------------
def print_http_table(results: list[dict]) -> None:
    print("\n[캐시 사용/미사용 비교]")
    header = f"{'구분':<30} {'요청':>5} {'평균ms':>9} {'p50ms':>9} {'p95ms':>9} {'req/s':>8} {'히트율':>7} {'원본호출':>8}"
    print(header)
    print("-" * 95)
    for r in results:
        hit = "-" if r["hit_rate"] is None else f"{r['hit_rate'] * 100:.1f}%"
        print(f"{r['name']:<30} {r['requests']:>5} {r['avg_ms']:>9.1f} {r['p50_ms']:>9.1f} {r['p95_ms']:>9.1f} "
              f"{r['throughput_rps']:>8.1f} {hit:>7} {r['origin_calls']:>8}")


def print_hashtable_table(h: dict) -> None:
    print(f"\n[HashTable vs dict — {h['n']:,}건]")
    print(f"{'':<12} {'put(ms)':>10} {'get(ms)':>10}")
    print(f"{'HashTable':<12} {h['hashtable_put_ms']:>10.1f} {h['hashtable_get_ms']:>10.1f}")
    print(f"{'dict':<12} {h['dict_put_ms']:>10.1f} {h['dict_get_ms']:>10.1f}")
    print(f"{'배율':<12} {h['put_ratio']:>9.1f}x {h['get_ratio']:>9.1f}x")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mini Redis 벤치마크")
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--only-hashtable", action="store_true", help="HTTP 비교는 건너뛰고 자료구조 비교만")
    args = parser.parse_args()

    result = {
        "measured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "environment": {"python": sys.version.split()[0], "platform": platform.platform()},
        "config": {"requests": args.requests, "concurrency": args.concurrency, "product_ids": PRODUCT_IDS},
        "http": None,
        "hashtable": None,
    }

    if not args.only_hashtable:
        down = asyncio.run(servers_up())
        if down:
            print("다음 서버가 응답하지 않아 HTTP 비교를 건너뜁니다:", ", ".join(down))
            print("README 의 '실행 방법' 순서대로 세 서버를 먼저 띄워 주세요.")
        else:
            result["http"] = asyncio.run(http_benchmark(args.requests, args.concurrency))
            print_http_table(result["http"])

    result["hashtable"] = hashtable_benchmark()
    print_hashtable_table(result["hashtable"])

    with open(RESULT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n결과 저장: {RESULT_PATH}")


if __name__ == "__main__":
    main()
