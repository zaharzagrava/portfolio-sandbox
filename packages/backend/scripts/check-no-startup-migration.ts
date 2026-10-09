/**
 * Fails when an app entry point runs migrations at boot (constitution III.11, S54 G-45 / AS-71):
 * migrations run once per release in the pre-deploy migrator, never from `apps/* /src/main.ts` or a bootstrap path.
 *
 * Run: pnpm check:no-startup-migration
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BACKEND = join(__dirname, '..');
const FORBIDDEN =
  /\b(umzug|Umzug|queryInterface|sequelize-cli|\.sync\s*\(|migrate\s*\()/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const targets = readdirSync(join(BACKEND, 'apps'))
  .map((a) => join(BACKEND, 'apps', a, 'src/main.ts'))
  .filter(existsSync);
const bootstrapDir = join(BACKEND, 'libs/infrastructure/platform');
if (existsSync(bootstrapDir))
  targets.push(
    ...walk(bootstrapDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('spec.ts'),
    ),
  );

const offenders: string[] = [];
for (const file of targets) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.trim().startsWith('//'))
        offenders.push(`${relative(BACKEND, file)}:${i + 1}  ${line.trim()}`);
    });
}

if (offenders.length) {
  console.error(
    `Migrations must not run at startup (${offenders.length}):\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log('check:no-startup-migration OK');
