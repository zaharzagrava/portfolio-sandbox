import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LAMBDAS } from '../manifest/lambdas.manifest';
import { expandManifest } from '../manifest/lambda-spec';
import { validateManifest } from '../manifest/validate-manifest';
import {
  checkBundleFile,
  checkSourceMap,
  copiesOf,
  MAX_BUNDLE_BYTES,
  SINGLETON_PACKAGES,
} from './bundle-checks';
import { startRunner } from '../runner/runner';
import { testSqsClient, SQS_PREFIX } from '../testing/queues';

// The build is the unit under test: it runs once, and every case inspects what it wrote.
const backend = resolve(__dirname, '../../../..');
const bundles = join(backend, 'dist/lambda-bundles');
const entries = expandManifest(LAMBDAS);
const env = {
  ...process.env,
  MEDIA_BUCKET: 'build-check',
  DATABASE_URL: 'postgres://build:check@localhost:5432/check',
  MEDIA_SCANNER_DISABLED: 'true',
  NODE_ENV: 'test',
};
const sourcesOf = (name: string) =>
  JSON.parse(readFileSync(join(bundles, name, 'index.js.map'), 'utf8')) as {
    sources: string[];
  };

describe('Lambda bundles (e2e: runs scripts/build-lambdas.mjs)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-lambdas.mjs'], {
      cwd: backend,
      stdio: 'pipe',
      timeout: 540_000,
      env,
    });
  }, 600_000);

  it('S55 AS-48: every manifest entry, dead-letter handlers included, has exactly one CommonJS bundle whose handler is a function, with no top-level await', () => {
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        'webhook-delivery',
        'media-processing',
        'document-extractor',
        'document-extractor-dlq',
      ]),
    );
    for (const entry of entries) {
      const file = join(bundles, entry.name, 'index.js');
      expect(existsSync(file)).toBe(true);
      expect(checkBundleFile(entry.name, file, env)).toEqual([]);
    }
  });

  it('S55 AS-48: the plain handler bundle (media processing) contains no Nest module, the Nest ones do', () => {
    expect(copiesOf(sourcesOf('media-processing'), '@nestjs/core')).toEqual([]);
    expect(copiesOf(sourcesOf('media-processing'), '@nestjs/common')).toEqual(
      [],
    );
    for (const name of [
      'webhook-delivery',
      'document-extractor',
      'document-extractor-dlq',
    ])
      expect(copiesOf(sourcesOf(name), '@nestjs/core')).toHaveLength(1);
  });

  it('S55 AS-49: one copy each of the DI core, metadata polyfill and validator, no AWS SDK client, below the size limit', () => {
    for (const entry of entries) {
      const map = sourcesOf(entry.name);
      expect(
        checkSourceMap(entry.name, map, { plain: entry.plain === true }),
      ).toEqual([]);
      for (const pkg of SINGLETON_PACKAGES)
        expect(copiesOf(map, pkg).length).toBeLessThanOrEqual(1);
      expect(
        map.sources.some((s) => /node_modules\/(@aws-sdk|@smithy)\//.test(s)),
      ).toBe(false);
      expect(
        readFileSync(join(bundles, entry.name, 'index.js')).length,
      ).toBeLessThan(MAX_BUNDLE_BYTES);
    }
  });

  it('S55 AS-52: manifest.json equals the manifest field for field, parses with the manifest rules, and the runner starts a function from it', async () => {
    const written = JSON.parse(
      readFileSync(join(bundles, 'manifest.json'), 'utf8'),
    );
    expect(written).toEqual(JSON.parse(JSON.stringify(entries)));
    for (const field of [
      'name',
      'entry',
      'queue',
      'fifo',
      'timeoutSec',
      'memoryMb',
      'batchSize',
      'maxConcurrency',
      'visibilityTimeoutSec',
      'maxReceiveCount',
      'dbPoolMax',
    ])
      for (const e of written) expect(e[field]).not.toBeUndefined();
    expect(
      written.find((e: { name: string }) => e.name === 'document-extractor')
        .deadLetter,
    ).toMatchObject({
      batchSize: 5,
      maxConcurrency: 5,
    });
    expect(() => validateManifest(written)).not.toThrow();

    // the runner reads that file and loads those bundles (not source): the extractor starts and stops cleanly
    const handle = await startRunner({
      manifestPath: join(bundles, 'manifest.json'),
      sqs: testSqsClient(),
      queueUrlPrefix: SQS_PREFIX,
      only: ['document-extractor'],
      waitTimeSeconds: 1,
    });
    await handle.stop();
  });
});
