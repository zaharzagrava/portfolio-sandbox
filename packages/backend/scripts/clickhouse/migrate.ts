/**
 * Applies packages/backend/clickhouse/*.sql in filename order, once each,
 * tracking applied files in `schema_migrations` (same scheme as cql/migrate.ts).
 * Statements are idempotent (IF NOT EXISTS), so a half-applied file can be re-run.
 *
 * Usage: pnpm clickhouse:migrate (reads CLICKHOUSE_* from .env)
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@clickhouse/client';

async function main() {
  const database = process.env.CLICKHOUSE_DATABASE ?? 'marketplace';
  const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
  const auth = { username: process.env.CLICKHOUSE_USER ?? 'default', password: process.env.CLICKHOUSE_PASSWORD ?? '' };

  const admin = createClient({ url, ...auth });
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await admin.close();

  const client = createClient({ url, ...auth, database });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations (file String, applied_at DateTime DEFAULT now()) ENGINE = ReplacingMergeTree ORDER BY file`,
  });
  const applied = new Set(
    (await (await client.query({ query: 'SELECT file FROM schema_migrations FINAL', format: 'JSONEachRow' })).json<{ file: string }>()).map((r) => r.file),
  );

  const dir = join(__dirname, '../../clickhouse');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    // Comments first (a statement may end with `; -- note`), then split on statement terminators.
    const statements = readFileSync(join(dir, file), 'utf8')
      .replace(/--.*$/gm, '')
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const query of statements) await client.command({ query });
    await client.insert({ table: 'schema_migrations', values: [{ file }], format: 'JSONEachRow' });
    console.log(`applied ${file}`);
  }
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
