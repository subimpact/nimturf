import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs the Durable Object tests inside real workerd, against real SQLite
 * storage - the same runtime as production, not a mock.
 */
export default defineWorkersConfig({
  test: {
    include: ['test/**/*.worker.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            SESSION_SECRET: 'test-secret-long-enough-to-be-accepted',
            TREASURY_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
          },
        },
      },
    },
  },
});
