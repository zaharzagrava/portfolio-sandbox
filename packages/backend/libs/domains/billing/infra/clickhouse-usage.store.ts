import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import {
  Domain_UsageUnavailableError,
  amountOutOfRange,
} from '../domain/errors';
import type { UsageStorePort, UsageWindow } from '../domain/ports';
import type { UsageRecord } from '../domain/usage-types';

/** Every read of the usage store is bounded (S18 FR-023): it answers within five seconds or rejects. */
export const USAGE_STORE_TIMEOUT_MS = 5_000;

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC: the text form of a `DateTime64(3, 'UTC')` value (no `.replace('Z', '')`). */
export function clickhouseInstant(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid instant');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

const TS = `DateTime64(3, 'UTC')`;

/** The class and numeric code of a failure, never its message (a store message can carry the statement). */
export const errorKind = (error: unknown): string => {
  const e = error as { name?: unknown; code?: unknown };
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return typeof e?.code === 'string' || typeof e?.code === 'number'
    ? `${name} ${String(e.code)}`
    : name;
};

/** Parses a ClickHouse `UInt64` (a string in JSON) into a safe integer, never wrapping or rounding. */
function safeTotal(value: unknown): number {
  const text =
    value === null || value === undefined
      ? '0'
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'bigint'
        ? String(value)
        : '';
  if (!/^\d+$/.test(text)) throw new Error('usage total is not an integer');
  const big = BigInt(text);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw amountOutOfRange();
  return Number(big);
}

/**
 * The usage store of billing over the analytical `usage_events` table (data-model.md). Reads are exact: `FINAL`
 * collapses duplicate event ids whether or not a background merge ran (FR-025). Instants are bound as
 * `DateTime64(3, 'UTC')`. Every failure or timeout is `usage_unavailable`, never a partial answer. Inserts are
 * durable: they resolve only when the server stored the rows.
 */
@Injectable()
export class ClickHouseUsageStore implements UsageStorePort {
  private readonly logger = new Logger(ClickHouseUsageStore.name);

  constructor(private readonly clickhouse: ClickHouseService) {}

  async insert(records: UsageRecord[], ingestedAt: Date): Promise<void> {
    if (records.length === 0) return;
    const stamp = clickhouseInstant(ingestedAt);
    await this.clickhouse.insert(
      'usage_events',
      records.map((r) => ({
        event_id: r.identity,
        subject_id: r.subjectId,
        metric: r.metric,
        quantity: r.quantity,
        ts: clickhouseInstant(r.ts),
        ingested_at: stamp,
      })),
      { timeoutMs: USAGE_STORE_TIMEOUT_MS },
    );
  }

  async total(subjectId: string, window: UsageWindow): Promise<number> {
    return (await this.totals(subjectId, [window]))[0];
  }

  async totals(subjectId: string, windows: UsageWindow[]): Promise<number[]> {
    if (windows.length === 0) return [];
    const params: Record<string, unknown> = { subject: subjectId };
    const columns = windows.map((w, i) => {
      params[`m${i}`] = w.metric;
      params[`f${i}`] = clickhouseInstant(w.from);
      params[`t${i}`] = clickhouseInstant(w.to);
      return `sumIf(quantity, metric = {m${i}:String} AND ts >= {f${i}:${TS}} AND ts < {t${i}:${TS}}) AS c${i}`;
    });
    const rows = await this.read<Record<string, unknown>>(
      `SELECT ${columns.join(', ')} FROM usage_events FINAL
        WHERE subject_id = {subject:String}`,
      params,
    );
    return windows.map((_, i) => safeTotal(rows[0]?.[`c${i}`]));
  }

  async totalIngestedBy(
    subjectId: string,
    window: UsageWindow,
    ingestedBy: Date,
  ): Promise<number> {
    const rows = await this.read<{ total: unknown }>(
      `SELECT sum(quantity) AS total FROM usage_events FINAL
        WHERE subject_id = {subject:String} AND metric = {metric:String}
          AND ts >= {from:${TS}} AND ts < {to:${TS}} AND ingested_at <= {by:${TS}}`,
      {
        subject: subjectId,
        metric: window.metric,
        from: clickhouseInstant(window.from),
        to: clickhouseInstant(window.to),
        by: clickhouseInstant(ingestedBy),
      },
    );
    return safeTotal(rows[0]?.total);
  }

  async totalsByMetric(
    subjectId: string,
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.read<{ metric: string; total: unknown }>(
      `SELECT metric, sum(quantity) AS total FROM usage_events FINAL
        WHERE subject_id = {subject:String} AND ts >= {from:${TS}} AND ts < {to:${TS}}
        GROUP BY metric ORDER BY metric`,
      {
        subject: subjectId,
        from: clickhouseInstant(from),
        to: clickhouseInstant(to),
      },
    );
    return new Map(rows.map((r) => [r.metric, safeTotal(r.total)]));
  }

  private async read<T extends Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    try {
      return await this.clickhouse.query<T>(sql, params, {
        timeoutMs: USAGE_STORE_TIMEOUT_MS,
      });
    } catch (error) {
      // neither the store's message nor the query reaches a log line or the caller (V.3): only the kind of failure
      this.logger.warn(`usage store read failed (${errorKind(error)})`);
      throw new Domain_UsageUnavailableError();
    }
  }
}
