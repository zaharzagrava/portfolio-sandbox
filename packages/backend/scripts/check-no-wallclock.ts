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
];
const FORBIDDEN =
  /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const offenders: string[] = [];
for (const d of DIRS.map((x) => join(BACKEND, x)).filter(existsSync)) {
  for (const file of walk(d).filter(
    (f) =>
      f.endsWith('.ts') && !/spec\.ts$/.test(f) && !f.endsWith('/clock.ts'),
  )) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (FORBIDDEN.test(line) && !line.trim().startsWith('//'))
          offenders.push(`${relative(BACKEND, file)}:${i + 1}  ${line.trim()}`);
      });
  }
}

if (offenders.length) {
  console.error(
    `Direct wall-clock reads (${offenders.length}); inject CLOCK instead:\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log('check:no-wallclock OK');
