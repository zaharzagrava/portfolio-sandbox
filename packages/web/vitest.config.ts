import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** Unit and component tests (Vitest + RTL + MSW). UI journeys live in tests/ (Playwright). */
export default defineConfig({
  // @vitejs/plugin-react is built against a newer Vite major than vitest's own; the types differ, the runtime works.
  plugins: [react() as never],
  test: {
    include: ['components/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}', 'hooks/**/*.test.{ts,tsx}', 'proxy.test.ts'],
    exclude: ['tests/**', 'node_modules/**', '.next/**'],
    environment: './vitest.environment.ts',
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, '.') },
      // `server-only` throws outside a Server Component build; tests import server modules directly.
      { find: /^server-only$/, replacement: path.resolve(__dirname, 'vitest.server-only.ts') },
    ],
  },
});
