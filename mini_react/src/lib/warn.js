/**
 * 개발 모드 경고
 *  실수했을 때 바로 알려준다. 같은 메시지는 한 번만 출력한다.
 *  devConfig.warnings = false 로 끌 수 있다. (테스트 등)
 */
export const devConfig = { warnings: true, onWarn: null };

const seen = new Set();

export function warn(message) {
  if (!devConfig.warnings || seen.has(message)) return;
  seen.add(message);
  console.warn(`[miniReact] ${message}`);
  devConfig.onWarn?.(message);
}

/** 이미 출력한 경고 기록을 지운다 (같은 경고를 다시 보고 싶을 때) */
export function resetWarnings() {
  seen.clear();
}
