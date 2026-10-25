import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@salon/source'] },
  test: { include: ['src/**/*.test.ts'] },
});
