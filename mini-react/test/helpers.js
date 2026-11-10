// 테스트 공용 도우미

// setState는 다시 그리기를 마이크로태스크로 예약만 한다.
// 다음 매크로태스크(setTimeout 0)까지 기다리면 예약된 update와 그 effect까지 모두 끝나 있다.
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
