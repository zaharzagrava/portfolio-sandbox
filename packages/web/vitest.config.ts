import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Unit tests for isolated, reused logic (lib/, hooks/). UI journeys live in tests/ (Playwright). */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'hooks/**/*.test.ts'],
    environment: 'jsdom',
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
