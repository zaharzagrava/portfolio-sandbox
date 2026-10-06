import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';

/**
 * Batched inserts into ReplacingMergeTree(version) tables: duplicates and
 * stale versions collapse at merge time (queries use FINAL or argMax).
 * `async_insert` lets ClickHouse buffer small inserts server-side.
 */
@Injectable()
export class ClickHouseSink {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.clickhouse.getClient().insert({
      table,
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
  }
}
