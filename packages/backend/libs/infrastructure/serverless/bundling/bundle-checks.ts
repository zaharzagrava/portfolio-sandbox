import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

/** Lambda's zipped package limit is 50 MB; the single `index.js` of a bundle must stay far below it. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/** Packages of which a Nest bundle may contain exactly one copy (a second breaks DI, metadata or `instanceof`). */
export const SINGLETON_PACKAGES = [
  '@nestjs/core',
  '@nestjs/common',
  'reflect-metadata',
  'class-validator',
];

export interface SourceMap {
  sources: string[];
}

export interface BundleProblem {
  bundle: string;
  check: string;
  message: string;
}

/** The package directory (up to and including the package name) of a `node_modules/...` source path, else undefined. */
export function packageRootOf(source: string, pkg: string): string | undefined {
  const marker = `node_modules/${pkg}/`;
  const at = source.lastIndexOf(marker);
  return at < 0 ? undefined : source.slice(0, at + marker.length - 1);
}

/** Distinct installed copies of `pkg` named by the source map (the same path through different files counts once). */
export function copiesOf(map: SourceMap, pkg: string): string[] {
  return [
    ...new Set(
      map.sources
        .map((s) => packageRootOf(s.replace(/\\/g, '/'), pkg))
        .filter((root): root is string => root !== undefined),
    ),
  ];
}

/** Source-map checks (AS-48, AS-49): no Nest in a plain bundle, one copy of each singleton, no AWS SDK client inlined. */
export function checkSourceMap(
  bundle: string,
  map: SourceMap,
  { plain }: { plain: boolean },
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const add = (check: string, message: string) =>
    problems.push({ bundle, check, message });
  if (
    plain &&
    copiesOf(map, '@nestjs/core').length +
      copiesOf(map, '@nestjs/common').length >
      0
  )
    add('plain-has-no-nest', 'a plain handler bundle contains Nest');
  for (const pkg of SINGLETON_PACKAGES) {
    const copies = copiesOf(map, pkg);
    if (copies.length > 1)
      add(
        'single-copy',
        `${pkg} is bundled ${copies.length} times: ${copies.join(', ')}`,
      );
  }
  if (!plain && copiesOf(map, '@nestjs/core').length === 0)
    add('nest-present', 'a Nest bundle does not contain the DI core');
  for (const sdk of [
    '@aws-sdk/client-sqs',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-s3',
    '@aws-sdk/lib-dynamodb',
  ]) {
    if (copiesOf(map, sdk).length > 0)
      add(
        'sdk-external',
        `${sdk} is inside the bundle (the runtime provides it)`,
      );
  }
  return problems;
}

/**
 * File checks: CommonJS (no top-level `import`/`export`), no top-level `await` (Node refuses to parse it in CommonJS),
 * the exported `handler` is a function, and the size is below the platform limit. `env` is what the module needs to be
 * loaded (a function may read configuration at module scope).
 */
export function checkBundleFile(
  bundle: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const add = (check: string, message: string) =>
    problems.push({ bundle, check, message });
  const size = statSync(file).size;
  if (size > MAX_BUNDLE_BYTES)
    add('size', `${size} bytes exceeds ${MAX_BUNDLE_BYTES}`);
  const source = readFileSync(file, 'utf8');
  if (/^\s*(import\s[^(]|export\s)/m.test(source.slice(0, 4096)))
    add('format', 'the bundle is not CommonJS');
  try {
    // compiled as the body of a CommonJS wrapper function: a top-level `await`, `import` or `export` does not parse
    new Script(
      `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
      { filename: file },
    );
  } catch (error) {
    add(
      'syntax',
      `not valid CommonJS (a top-level await?): ${(error as Error).message}`,
    );
    return problems;
  }
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        "const m = require(process.argv[1]); process.exit(typeof m.handler === 'function' ? 0 : 3)",
        resolve(file),
      ],
      { stdio: 'pipe', env, timeout: 60_000 },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    add(
      'handler',
      status === 3
        ? 'the exported handler is not a function'
        : `the bundle cannot be loaded: ${String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 300)}`,
    );
  }
  return problems;
}
