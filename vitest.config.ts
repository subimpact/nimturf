import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/shared/test/**/*.test.ts', 'worker/test/**/*.node.test.ts'],
    environment: 'node',
  },
});
