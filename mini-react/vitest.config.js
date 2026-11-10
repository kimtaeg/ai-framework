import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // 새 코어(src/core)의 테스트는 tests/에서 node:test로 돈다. vitest는 기존 test/만 맡는다.
    include: ['test/**/*.test.js'],
  },
});
