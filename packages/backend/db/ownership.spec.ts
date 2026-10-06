import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DOMAINS, INFRASTRUCTURE_OWNERS, OWNERSHIP, RETIRED_TABLES, ownerOf } from './ownership';

/** Constitution IX.3: the registry is complete, has exactly one owner per table, and matches where models live. */
const BACKEND = join(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === 'node_modules' ? [] : walk(p)) : [p];
  });

/** Partition children and migration staging copies belong to their parent table. */
const parentTable = (name: string) => name.replace(/(_new)?(_default)?$/, '');

function tablesCreatedByMigrations(): Set<string> {
  const created = new Set<string>();
  for (const file of walk(join(BACKEND, 'migrations')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/createTable\(\s*['"]([A-Za-z_]+)['"]|CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z_]+)"?|RENAME TO "([A-Za-z_]+)"/g)) {
      created.add(parentTable(m[1] ?? m[2] ?? m[3]));
    }
  }
  for (const t of RETIRED_TABLES) created.delete(t);
  return created;
}

function modelTables(): { file: string; table: string }[] {
  return walk(join(BACKEND, 'libs'))
    .filter((f) => f.endsWith('.model.ts'))
    .map((file) => {
      const table = /tableName:\s*'([A-Za-z_]+)'/.exec(readFileSync(file, 'utf8'))?.[1];
      if (!table) throw new Error(`${relative(BACKEND, file)}: model has no explicit tableName`);
      return { file: relative(BACKEND, file), table };
    });
}

describe('database ownership registry (IX.3)', () => {
  const registered = new Set(Object.keys(OWNERSHIP));

  it('lists every table that migrations or models create', () => {
    const existing = new Set([...tablesCreatedByMigrations(), ...modelTables().map((m) => m.table)]);
    expect([...existing].filter((t) => !registered.has(t)).sort()).toEqual([]);
  });

  it('lists no table that nothing creates', () => {
    const existing = new Set([...tablesCreatedByMigrations(), ...modelTables().map((m) => m.table)]);
    expect([...registered].filter((t) => !existing.has(t)).sort()).toEqual([]);
  });

  it('uses only known owners, and infrastructure owns exactly the technical allowlist', () => {
    const owners = new Set(Object.values(OWNERSHIP) as string[]);
    const valid = new Set([...DOMAINS.map((d) => `domain:${d}`), ...INFRASTRUCTURE_OWNERS.map((i) => `infrastructure:${i}`)]);
    expect([...owners].filter((o) => !valid.has(o))).toEqual([]);
    const infraTables = Object.entries(OWNERSHIP).filter(([, o]) => o.startsWith('infrastructure:')).map(([t]) => t).sort();
    expect(infraTables).toEqual(['Job', 'JobKey', 'JobSchedule', 'Migration', 'Outbox', 'ProcessedWebhookEvent']);
  });

  it('places every migrated model inside the lib that owns its table', () => {
    const misplaced = modelTables()
      .filter(({ file }) => !file.startsWith(`libs${sep}common${sep}src${sep}`)) // legacy models: not migrated yet
      .map(({ file, table }) => {
        const [, area, lib] = file.split(sep);
        const expected = area === 'domains' ? `domain:${lib}` : `infrastructure:${lib}`;
        return ownerOf(table) === expected ? null : `${file}: table ${table} is owned by ${ownerOf(table)}, model lives in ${expected}`;
      })
      .filter(Boolean);
    expect(misplaced).toEqual([]);
  });

  it('knows every domain folder that exists', () => {
    const folders = readdirSync(join(BACKEND, 'libs/domains')).filter((d) => statSync(join(BACKEND, 'libs/domains', d)).isDirectory());
    expect(folders.filter((d) => !(DOMAINS as readonly string[]).includes(d))).toEqual([]);
  });
});
