/**
 * Fails when any provider uses request scope (constitution I.3, S54 G-18 / AS-26): `Scope.REQUEST`
 * in an `@Injectable` / `@Module`, or `@Inject(REQUEST)`, across apps/ and libs/. Spec files are ignored.
 *
 * Run: pnpm check:no-request-scope
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BACKEND = join(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const PATTERNS: [string, RegExp][] = [
  ['Scope.REQUEST', /\bScope\.REQUEST\b/],
  ['scope: REQUEST', /\bscope\s*:\s*Scope\.(REQUEST|TRANSIENT)\b/],
  ['@Inject(REQUEST)', /@Inject\(\s*REQUEST\s*\)/],
];

const offenders: string[] = [];
for (const root of ['apps', 'libs']) {
  for (const file of walk(join(BACKEND, root)).filter(
    (f) => f.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(f),
  )) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of PATTERNS) {
        if (
          re.test(line) &&
          !line.trim().startsWith('//') &&
          !line.trim().startsWith('*')
        ) {
          offenders.push(`${relative(BACKEND, file)}:${i + 1}  ${name}`);
        }
      }
    });
  }
}

if (offenders.length) {
  console.error(
    `Request-scoped providers are forbidden (${offenders.length}):\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log('check:no-request-scope OK');
