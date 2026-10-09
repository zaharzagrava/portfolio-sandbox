import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';

/** Applies packages/backend/clickhouse/*.sql files (idempotent DDL) to the test ClickHouse. */
export async function applyClickHouseDdl(
  clickhouse: ClickHouseService,
  ...files: string[]
): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(join(process.cwd(), 'clickhouse', file), 'utf8');
    for (const statement of sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/--.*$/gm, '').trim())
      .filter(Boolean)) {
      await clickhouse.getClient().command({ query: statement });
    }
  }
}
