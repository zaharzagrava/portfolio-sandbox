/**
 * Applies packages/backend/cql/*.cql in filename order, once each, tracking
 * applied files in marketplace.schema_migrations. CQL has no transactional
 * DDL, so every statement must be idempotent (IF NOT EXISTS).
 *
 * Usage: CASSANDRA_CONTACT_POINTS=localhost:9042 npx ts-node scripts/cql/migrate.ts
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'cassandra-driver';

async function main() {
  const dir = join(__dirname, '../../cql');
  const client = new Client({
    contactPoints: (
      process.env.CASSANDRA_CONTACT_POINTS ?? 'localhost:9042'
    ).split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DC ?? 'datacenter1',
  });
  await client.connect();

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.cql'))
    .sort();
  // 000_keyspace creates the tracking table, so it always runs (it's idempotent).
  const applied = new Set<string>();
  for (const file of files) {
    if (file !== '000_keyspace.cql') {
      const rows = await client.execute(
        'SELECT file FROM marketplace.schema_migrations',
      );
      rows.rows.forEach((r) => applied.add(r.file));
    }
    if (applied.has(file)) continue;

    const statements = readFileSync(join(dir, file), 'utf8')
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await client.execute(statement);

    await client.execute(
      'INSERT INTO marketplace.schema_migrations (file, applied_at) VALUES (?, toTimestamp(now()))',
      [file],
      {
        prepare: true,
      },
    );
    console.log(`applied ${file}`);
  }

  await client.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
