import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import path from 'node:path';

const r = (p: string) => path.resolve(__dirname, p);
// Spike: the e2e suites under Vitest. One process, module cache shared between files (isolate: false), swc for decorator metadata.
export default defineConfig({
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
  resolve: {
    dedupe: ['graphql'],
    alias: [
      { find: /^@app\/(infrastructure|composition|domains)\/(.*)$/, replacement: r('libs') + '/$1/$2' },
      { find: /^@app\/test\/(.*)$/, replacement: r('test') + '/$1' },
      { find: /^@app\/common\/(.*)$/, replacement: r('libs/common') + '/$1' },
      { find: /^@app\/(core|bff|sse-gateway|worker|projector|collab|public-api|payment-processor)\/(.*)$/, replacement: r('apps') + '/$1/src/$2' },
    ],
  },
  test: {
    globals: true,
    include: ['libs/**/*.e2e-spec.ts', 'apps/**/*.e2e-spec.ts', 'test/toolkit/**/*.e2e-spec.ts', 'scripts/rag-eval/**/*.e2e-spec.ts'], // the same roots as jest-e2e.json,
    setupFiles: ['./test/e2e-env.setup.ts', './test/vitest-jest-shim.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    isolate: process.env.VITEST_ISOLATE === '1',
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    server: { deps: { inline: [/@app\//, /graphql/, /apollo/] } },
  },
});
