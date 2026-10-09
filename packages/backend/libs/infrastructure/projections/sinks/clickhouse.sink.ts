import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { TransientError } from '../errors';
import type { SinkCounts } from '../projector';

/** ClickHouse server codes that mean "try again": timeouts, network, overload, too many parts, read-only table. */
const TRANSIENT_CODES = new Set([
  '159',
  '202',
  '209',
  '210',
  '241',
  '242',
  '252',
  '285',
  '425',
]);
const TRANSIENT_MESSAGE =
  /timeout|timed out|socket hang up|ECONN|EPIPE|too many (parts|simultaneous)|memory limit|read.?only/i;

/** Wraps driver and network failures that a retry can cure in `TransientError`; anything else (bad schema) passes. */
export function clickhouseFailure(error: unknown): unknown {
  const rawCode = (error as { code?: unknown } | undefined)?.code;
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number'
      ? String(rawCode)
      : '';
  const message = (error as Error | undefined)?.message ?? '';
  return TRANSIENT_CODES.has(code) || TRANSIENT_MESSAGE.test(message)
    ? new TransientError('ClickHouse is unavailable', { cause: error })
    : error;
}

/**
 * Batched inserts into ReplacingMergeTree(version) tables: duplicates and stale versions collapse at merge time
 * (queries use FINAL or argMax). Without a token `async_insert` lets ClickHouse buffer small inserts server-side.
 * With a `dedupeToken` (a stable id of the batch, e.g. from the source offsets) the insert is deduplicated by the
 * server, so a retried batch adds no rows even before a merge (S53 FR-043, FR-045).
 */
@Injectable()
export class ClickHouseSink {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async insert(
    table: string,
    rows: Record<string, unknown>[],
    options: { dedupeToken?: string } = {},
  ): Promise<SinkCounts> {
    if (rows.length === 0) return { applied: 0, duplicate: 0, stale: 0 };
    try {
      await this.clickhouse.getClient().insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: options.dedupeToken
          ? {
              async_insert: 0,
              insert_deduplicate: 1,
              insert_deduplication_token: options.dedupeToken,
            }
          : { async_insert: 1, wait_for_async_insert: 1 },
      });
    } catch (error) {
      throw clickhouseFailure(error);
    }
    // Duplicates collapse at merge time and are not visible here: every row is reported as applied.
    return { applied: rows.length, duplicate: 0, stale: 0 };
  }
}
