/**
 * S31 AS-79 / FR-054: no migration written for the asset library declares a foreign key to a table another capability
 * owns (constitution IX.4: references across owners are plain identifiers). The history of
 * `20261002110000-asset-library.js` (which declared the keys to `Shop` and `Product`) stays as it was; the contract step
 * `20261010110000-asset-library-contract.js` drops them. This check covers every later `asset-library` migration.
 *
 * Run: pnpm check:asset-library-no-fk
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNERSHIP } from '../db/ownership';

const MIGRATIONS = join(__dirname, '..', 'migrations');
const FIRST = '20261010';

const owned = new Set(
  Object.entries(OWNERSHIP)
    .filter(([, owner]) => owner === 'domain:asset-library')
    .map(([table]) => table),
);

const problems: string[] = [];
for (const file of readdirSync(MIGRATIONS).sort()) {
  if (!file.includes('asset-library') || file < FIRST) continue;
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  // SQL keyword only (upper case): the word also appears in comments
  for (const match of sql.matchAll(
    /\bREFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/g,
  )) {
    if (!owned.has(match[1]))
      problems.push(
        `${file}: foreign key to "${match[1]}", which asset-library does not own`,
      );
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `no asset-library migration declares a foreign key to another owner's table (${owned.size} owned tables).`,
);
