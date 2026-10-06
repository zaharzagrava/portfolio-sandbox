// SD-03: one deployable bundle per Lambda (dist/lambda-bundles/<name>/index.js).
// Two stages on purpose: esbuild cannot emit TypeScript decorator metadata, which Nest DI needs,
// so plain `tsc` (emitDecoratorMetadata on) compiles first and esbuild bundles the emitted JS.
// `@app/*` path aliases survive tsc untouched → resolved to the compiled libs by `appAliases` below
// The AWS SDK v3 is left out (the Node.js Lambda runtime ships it): smaller zips, faster cold starts.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = 'dist/lambdas-tsc';
const AREAS = { infrastructure: ['libs/infrastructure'], composition: ['libs/composition'], domains: ['libs/domains'], common: ['libs/common'] };
const firstExisting = (base) => [base + '.js', resolve(base, 'index.js')].find((p) => existsSync(p));
const appAliases = {
  name: 'app-aliases',
  setup(b) {
    b.onResolve({ filter: /^@app\/(infrastructure|composition|domains|common)(\/|$)/ }, ({ path }) => {
      const [, area, rest = ''] = path.match(/^@app\/([^/]+)\/?(.*)$/);
      for (const dir of AREAS[area]) {
        const hit = firstExisting(resolve(out, dir, rest));
        if (hit) return { path: hit };
      }
      return { errors: [{ text: `Cannot resolve ${path}` }] };
    });
  },
};
rmSync(out, { recursive: true, force: true });
execSync(`npx tsc -p apps/lambdas/tsconfig.app.json --outDir ${out} --rootDir . --declaration false`, { stdio: 'inherit' });
const { LAMBDAS } = await import(resolve(out, 'apps/lambdas/src/lambdas.manifest.js'));
mkdirSync('dist/lambda-bundles', { recursive: true });

for (const spec of LAMBDAS) {
  await build({
    entryPoints: [resolve(out, 'apps/lambdas/src', spec.entry)],
    outfile: `dist/lambda-bundles/${spec.name}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: 'linked',
    keepNames: true, // some Nest internals and our logs rely on class names
    plugins: [appAliases],
    external: ['@aws-sdk/*', 'pg-native', '@nestjs/microservices', '@nestjs/websockets/socket-module', 'class-transformer/storage'],
    logLevel: 'info',
  });
}
// Terraform (O-03) reads this: function name, handler file, queue, timeout, memory, concurrency.
writeFileSync('dist/lambda-bundles/manifest.json', JSON.stringify(LAMBDAS, null, 2));
