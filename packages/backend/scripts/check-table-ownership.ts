/**
 * Table-ownership report (constitution IX.4 / IX.5, first version of the CI check).
 *
 * For every domain, lists the places its code touches data owned by ANOTHER domain:
 *   - raw SQL: a quoted identifier ("Product") that the ownership registry assigns elsewhere;
 *   - models: a `<Name>Model` imported from another domain's barrel (@InjectModel, associations, includes).
 * Spec files are ignored. Raw-SQL detection is lexical: a quoted table name in any string counts.
 *
 * Run: pnpm check:table-ownership            # report, always exits 0
 *      pnpm check:table-ownership --strict   # exits 1 on any finding (turn on once debt D-7/D-12 is paid)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ownerOf } from '../db/ownership';

const BACKEND = join(__dirname, '..');
const DOMAINS = join(BACKEND, 'libs/domains');
const strict = process.argv.includes('--strict');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

type Finding = {
  kind: 'sql' | 'model';
  what: string;
  owner: string;
  file: string;
};
const byDomain = new Map<string, Finding[]>();

for (const file of walk(DOMAINS).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('spec.ts'),
)) {
  const domain = relative(DOMAINS, file).split('/')[0];
  const src = readFileSync(file, 'utf8');
  const add = (f: Finding) =>
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), f]);

  for (const [, table] of src.matchAll(/"([A-Z][A-Za-z_]+)"/g)) {
    const owner = ownerOf(table);
    if (owner?.startsWith('domain:') && owner !== `domain:${domain}`)
      add({ kind: 'sql', what: table, owner: owner.slice(7), file });
  }
  for (const [, names, from] of src.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@app\/domains\/([a-z-]+)'/g,
  )) {
    if (from === domain) continue;
    for (const name of names
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter((n) => /Model$/.test(n))) {
      add({ kind: 'model', what: name, owner: from, file });
    }
  }
}

let total = 0;
for (const [domain, findings] of [...byDomain].sort()) {
  const unique = [
    ...new Map(
      findings.map((f) => [`${f.kind}|${f.what}|${f.file}`, f]),
    ).values(),
  ];
  total += unique.length;
  console.log(`\n${domain}  (${unique.length})`);
  for (const f of unique.sort(
    (a, b) => a.owner.localeCompare(b.owner) || a.what.localeCompare(b.what),
  )) {
    console.log(
      `  ${f.kind === 'sql' ? 'SQL  ' : 'MODEL'} ${f.what.padEnd(26)} owned by ${f.owner.padEnd(18)} ${relative(BACKEND, f.file)}`,
    );
  }
}
console.log(
  `\n${total} cross-domain data accesses in ${byDomain.size} domains (${basename(__filename)}).`,
);
process.exit(strict && total > 0 ? 1 : 0);
