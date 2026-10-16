/**
 * Fails on direct wall-clock reads in the S54 libs (G-74 / AS-151): time must come from the injected CLOCK
 * so tests can drive it. `clock.ts` and spec files are exempt.
 *
 * Run: pnpm check:no-wallclock
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BACKEND = join(__dirname, '..');
const DIRS = [
  'libs/common/resilience',
  'libs/common/load-shedding',
  'libs/common/core',
  'libs/infrastructure/health',
  'libs/infrastructure/http-client',
  'libs/infrastructure/net',
  'libs/infrastructure/idempotency',
  'libs/infrastructure/context',
  'libs/infrastructure/jobs',
  // S37 AS-65: the share-link rules read time only through the injected clock
  'libs/domains/marketing/domain',
  'libs/domains/marketing/application',
  // S31 FR-049: every expiry, cap, grace and retention of the asset library reads the injected clock
  'libs/domains/asset-library/domain',
  'libs/domains/asset-library/application',
  'libs/domains/asset-library/infra',
  // S47 G50: the knowledge half reads time only through the injected clock (the database clock stays in lease / sweep SQL)
  'libs/domains/assistant/domain',
];
/** Files of directories that mix owners: the knowledge half of `assistant/application` (S46's files there are not S47's). */
const FILES = [
  'ask',
  'document',
  'ingest',
  'knowledge-search',
  'lifecycle',
  'reindex',
  'sweep',
].map((name) => `libs/domains/assistant/application/${name}.service.ts`);
/** No exemptions remain: S36's ads code reads time only through the injected clock too. */
const EXEMPT: string[] = [];
const FORBIDDEN =
  /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const offenders: string[] = [];
const candidates = [
  ...DIRS.map((x) => join(BACKEND, x))
    .filter(existsSync)
    .flatMap(walk),
  ...FILES.map((x) => join(BACKEND, x)).filter(existsSync),
];
for (const file of candidates.filter(
  (f) =>
    f.endsWith('.ts') &&
    !/spec\.ts$/.test(f) &&
    !f.endsWith('/clock.ts') &&
    !EXEMPT.some((e) => f.endsWith(e)),
)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.trim().startsWith('//'))
        offenders.push(`${relative(BACKEND, file)}:${i + 1}  ${line.trim()}`);
    });
}

if (offenders.length) {
  console.error(
    `Direct wall-clock reads (${offenders.length}); inject CLOCK instead:\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log('check:no-wallclock OK');
