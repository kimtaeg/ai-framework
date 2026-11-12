"""벤치마크 도우미 단위 테스트 (서버 없이 실행). 실행: python -m pytest mini_redis/tests/test_bench.py -v"""

import argparse

import pytest

from mini_redis.bench.benchmark import main, percentile, positive_int


def test_percentile_nearest_rank_rounds_up():
    values = list(range(1, 12))          # 11개
    assert percentile(values, 95) == 11  # ceil(0.95 × 11) = ceil(10.45) = 11번째 (반올림이면 10번째로 틀림)
    assert percentile(values, 50) == 6   # ceil(5.5) = 6번째
    assert percentile([7.0], 95) == 7.0
    assert percentile([], 95) == 0.0


def test_percentile_exact_rank():
    values = list(range(1, 101))         # 100개 → p95 는 정확히 95번째
    assert percentile(values, 95) == 95


@pytest.mark.parametrize("text", ["0", "-3", "abc", "1.5"])
def test_positive_int_rejects(text):
    with pytest.raises(argparse.ArgumentTypeError):
        positive_int(text)


def test_positive_int_accepts():
    assert positive_int("1") == 1
    assert positive_int("200") == 200


@pytest.mark.parametrize("args", [["--requests", "0"], ["--concurrency", "0"], ["--concurrency", "-1"]])
def test_main_rejects_invalid_arguments(args):
    with pytest.raises(SystemExit) as e:  # argparse 는 잘못된 인자에서 종료 코드 2 로 끝낸다
        main(args + ["--only-hashtable"])
    assert e.value.code == 2
