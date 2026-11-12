"""uvicorn 서버를 백그라운드 스레드에서 띄우는 도우미 (테스트·데모·벤치마크용).

실제 운영 실행은 `uvicorn mini_redis.server.app:app --workers 1` 을 쓴다.
이 도우미를 쓰는 이유: httpx.ASGITransport 는 네트워크 없이 앱을 직접 호출해서 요청이 중간에 멈추지 않는다.
그래서 "동시 요청"을 보내도 실제로는 하나씩 차례로 처리된다. 진짜 소켓 통신을 해야 요청들이 실제로 섞인다.
"""

import socket
import threading
import time
from contextlib import contextmanager

import uvicorn


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))  # 0번 포트 = OS 가 비어 있는 포트를 골라줌
        return s.getsockname()[1]


@contextmanager
def running_server(app, startup_timeout: float = 5.0):
    """with running_server(app) as url: 블록 안에서 서버가 돌고, 블록이 끝나면 종료된다."""
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)  # daemon: 메인 프로그램이 끝나면 같이 종료
    thread.start()
    # 시작 대기까지 try 안에 넣는다: 제한 시간을 넘겨 예외가 나도 finally 가 실행되어,
    # 뒤늦게 시작한 서버 스레드와 소켓까지 정리된다
    try:
        deadline = time.time() + startup_timeout
        while not server.started:  # 서버가 요청을 받을 준비가 될 때까지 대기
            if not thread.is_alive():
                raise RuntimeError("서버 스레드가 시작 중에 종료되었습니다")
            if time.time() > deadline:
                raise RuntimeError("서버가 시작되지 않았습니다")
            time.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True  # 서버에 종료 신호 → lifespan 종료 코드도 실행됨
        thread.join(timeout=5)
