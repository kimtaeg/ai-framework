"""여러 테스트 파일이 같이 쓰는 가짜 객체."""


class FakeClock:
    """가짜 시계. 객체를 함수처럼 부르면(clock()) 현재 시각을 돌려준다."""

    def __init__(self, start: float = 1_000_000.0):
        self.now = start

    def __call__(self) -> float:  # __call__ 덕분에 clock() 처럼 호출할 수 있음 → time.time 대신 주입 가능
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
