import { defineConfig } from 'vitest/config';

// 보관용: archive/의 예전 엔진(src/*.js)과 학습 페이지 테스트만 돌린다 (npm run test:archive).
// 지금 쓰는 코드(src/core·src/app·todo)의 테스트는 tests/에서 node:test로 돈다 (npm test).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['archive/test/**/*.test.js'],
  },
});
