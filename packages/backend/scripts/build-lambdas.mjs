// SD-03: one deployable bundle per Lambda (dist/lambda-bundles/<name>/index.js).
// Two stages on purpose: esbuild cannot emit TypeScript decorator metadata, which Nest DI needs,
// so plain `tsc` (emitDecoratorMetadata on) compiles first and esbuild bundles the emitted JS.
// `@app/*` path aliases survive tsc untouched → resolved to the compiled libs by `appAliases` below
// The AWS SDK v3 is left out (the Node.js Lambda runtime ships it): smaller zips, faster cold starts.
// The manifest (libs/infrastructure/serverless/manifest) is validated before anything is built, every bundle is
// checked after it (S55 AS-48, AS-49) and `manifest.json` is written last, expanded and validated (AS-52).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Native addons that a Nest context pulls in through shared modules (password hashing, the function sandbox) but that no
// Lambda calls. node-gyp-build looks for the `.node` file next to the bundle, so they cannot load from a single
// `index.js`; a stub that throws when used keeps the bundle small and loadable instead of failing at cold start.
const NATIVE_STUBS = ['argon2', 'bcrypt', 'isolated-vm'];
const nativeStubs = {
  name: 'native-stubs',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^(${NATIVE_STUBS.join('|')})$`) }, ({ path }) => ({ path, namespace: 'native-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'native-stub' }, ({ path }) => ({
      loader: 'js',
      contents: `const fail = () => { throw new Error('the native addon "${path}" is not available in a Lambda bundle'); };
module.exports = new Proxy(function () {}, { get: (_t, key) => (key === '__esModule' || key === 'then' ? undefined : fail), apply: fail, construct: fail });`,
    }));
  },
};
// A plain function (manifest `plain: true`) must not contain Nest. The barrel of a domain also exports its Nest modules,
// and CommonJS cannot be tree-shaken, so such a function gets the framework-free files of the barrel it uses.
const PLAIN_BARRELS = {
  '@app/domains/media': {
    createMediaProcessor: 'libs/domains/media/infra/media-processor.js',
    createTx: 'libs/domains/media/infra/media-tx.js',
  },
};
const plainBarrels = {
  name: 'plain-barrels',
  setup(b) {
    b.onResolve({ filter: /^@app\/domains\/media$/ }, ({ path }) => ({ path, namespace: 'plain-barrel' }));
    b.onLoad({ filter: /.*/, namespace: 'plain-barrel' }, ({ path }) => ({
      loader: 'js',
      resolveDir: resolve(out),
      contents: Object.entries(PLAIN_BARRELS[path])
        .map(([name, file]) => `export { ${name} } from ${JSON.stringify(resolve(out, file))};`)
        .join('\n'),
    }));
  },
};
rmSync(out, { recursive: true, force: true });
execSync(`npx tsc -p apps/lambdas/tsconfig.app.json --outDir ${out} --rootDir . --declaration false`, { stdio: 'inherit' });
const serverless = resolve(out, 'libs/infrastructure/serverless');
const { LAMBDAS } = await import(resolve(serverless, 'manifest/lambdas.manifest.js'));
const { expandManifest } = await import(resolve(serverless, 'manifest/lambda-spec.js'));
const { validateManifest } = await import(resolve(serverless, 'manifest/validate-manifest.js'));
const { checkBundleFile, checkSourceMap } = await import(resolve(serverless, 'bundling/bundle-checks.js'));

const entries = expandManifest(LAMBDAS);
validateManifest(entries); // throws, naming function and field

rmSync('dist/lambda-bundles', { recursive: true, force: true });
mkdirSync('dist/lambda-bundles', { recursive: true });
const problems = [];
for (const spec of entries) {
  const outfile = `dist/lambda-bundles/${spec.name}/index.js`;
  await build({
    entryPoints: [resolve(out, 'apps/lambdas/src', spec.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: 'linked',
    keepNames: true, // some Nest internals and our logs rely on class names
    plugins: [nativeStubs, ...(spec.plain ? [plainBarrels] : []), appAliases],
    // pg-hstore: Sequelize requires it only for the HSTORE type, which no model here uses; it is not installed
    // sharp: a native addon (.node files) cannot be inlined; it ships as a Lambda layer / node_modules next to the bundle
    external: ['@aws-sdk/*', 'pg-native', 'pg-hstore', 'sharp', '@img/*', '@nestjs/microservices', '@nestjs/websockets/socket-module', 'class-transformer/storage'],
    logLevel: 'info',
  });
  const map = JSON.parse(readFileSync(`${outfile}.map`, 'utf8'));
  problems.push(...checkSourceMap(spec.name, map, { plain: spec.plain === true }));
  // a function may read its configuration when the module loads: give the load check what the real function gets
  problems.push(
    ...checkBundleFile(spec.name, outfile, {
      ...process.env,
      MEDIA_BUCKET: process.env.MEDIA_BUCKET ?? 'build-check',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://build:check@localhost:5432/check',
      MEDIA_SCANNER_DISABLED: 'true',
      NODE_ENV: 'test',
    }),
  );
}
if (problems.length) {
  for (const p of problems) console.error(`bundle ${p.bundle}: ${p.check}: ${p.message}`);
  process.exit(1);
}
// Terraform (O-03) and the local runner read this: every manifest field, dead-letter handlers expanded.
writeFileSync('dist/lambda-bundles/manifest.json', JSON.stringify(entries, null, 2));
