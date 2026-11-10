// 화면 표시용 포맷 (순수 함수)

export const formatNumber = (n) => n.toLocaleString('ko-KR');
export const formatWon = (n) => `₩${n.toLocaleString('ko-KR')}`;

// 주문 시각: 상대 시간("3분 전")은 시간이 흐를 때마다 글자가 바뀌어 patch가 생기므로 절대 시각으로 쓴다
export function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
