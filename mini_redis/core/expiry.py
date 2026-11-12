"""Active expiration: 아무도 조회하지 않는 만료 키를 주기적으로 청소한다.

Lazy expiration(조회할 때 검사)만 있으면, 한 번 쓰고 다시 안 읽는 키는 만료돼도 메모리에 영원히 남는다.
그래서 Redis 처럼 "무작위 표본을 뽑아 검사 → 만료 비율이 높으면 한 번 더" 방식으로 조금씩 지운다.
전부 훑지 않는 이유: 키가 100만 개면 전체 검사가 요청 처리를 오래 멈추게 하기 때문이다.
"""

import time


def active_expire_cycle(
    store,
    sample_size: int = 20,
    threshold: float = 0.25,
    time_limit: float = 0.025,       # 25ms: 한 번 호출이 이보다 오래 이벤트 루프를 붙잡지 않게
    timer=time.perf_counter,         # 경과 시간 측정용 (테스트에서 가짜 타이머 주입 가능)
) -> int:
    """만료 키를 표본 추출로 지우고, 이번 호출에서 지운 개수를 돌려준다.

    - store 의 시계(clock)는 "키가 만료됐나"를 판단하는 용도
    - timer 는 "이 청소가 실제로 몇 ms 걸렸나"를 재는 용도 → 둘은 다른 시계다
    """
    start = timer()
    total_expired = 0
    while True:
        sampled, expired = store.sample_expire(sample_size)
        total_expired += expired
        if sampled == 0:
            break                                  # 만료가 걸린 키가 없음
        if expired / sampled <= threshold:
            break                                  # 만료 비율이 25% 이하 → 남은 쓰레기가 적다고 보고 멈춤
        if timer() - start >= time_limit:
            break                                  # 시간 예산 초과 → 나머지는 다음 주기(100ms 뒤)에
    return total_expired
