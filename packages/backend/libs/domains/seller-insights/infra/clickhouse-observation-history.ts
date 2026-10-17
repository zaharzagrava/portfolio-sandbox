import { Inject, Injectable } from '@nestjs/common';
import type { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ObservationHistoryUnavailable } from '../domain/competitor-errors';
import type {
  ObservationHistory,
  ObservationPoint,
} from '../domain/crawler-ports';

/** The ClickHouse client of the price history; a spec swaps it for one that fails on demand. */
export const COMPETITOR_CLICKHOUSE = Symbol('S41_COMPETITOR_CLICKHOUSE');
/** History calls give up after 3 seconds (S41 AS-15). */
export const HISTORY_TIMEOUT_MS = 3_000;

type Store = Pick<ClickHouseService, 'getClient' | 'query'>;

const ts = (at: Date): string =>
  at.toISOString().replace('T', ' ').replace('Z', '');

/**
 * `competitor_prices`: one row per recorded observation. A write carries the insert deduplication token
 * `<targetId>:<observationNo>`, so a retry after a half-finished attempt adds no second row (AS-41). Every failure
 * is `ObservationHistoryUnavailable`; the caller decides what that means for the crawl or the route.
 */
@Injectable()
export class ClickHouseObservationHistory implements ObservationHistory {
  constructor(@Inject(COMPETITOR_CLICKHOUSE) private readonly store: Store) {}

  async append(row: {
    targetId: string;
    observationNo: number;
    observedAt: Date;
    priceMinor: number;
    currency: string;
  }) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), HISTORY_TIMEOUT_MS);
    try {
      await this.store.getClient().insert({
        table: 'competitor_prices',
        format: 'JSONEachRow',
        values: [
          {
            target_id: row.targetId,
            ts: ts(row.observedAt),
            price_minor: row.priceMinor,
            currency: row.currency,
            observation_no: row.observationNo,
          },
        ],
        abort_signal: abort.signal,
        clickhouse_settings: {
          async_insert: 0,
          insert_deduplicate: 1,
          insert_deduplication_token: `${row.targetId}:${row.observationNo}`,
        },
      });
    } catch (error) {
      throw new ObservationHistoryUnavailable(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async read(
    targetId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<ObservationPoint[]> {
    try {
      const rows = await this.store.query<{
        ms: string | number;
        price_minor: string | number;
        currency: string;
      }>(
        `SELECT ms, price_minor, currency FROM (
           SELECT toUnixTimestamp64Milli(ts) AS ms, price_minor, currency
             FROM competitor_prices
            WHERE target_id = {targetId:String}
              AND ts >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
              AND ts <= fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
            ORDER BY ts DESC, observation_no DESC
            LIMIT {limit:UInt32})
         ORDER BY ms ASC`,
        {
          targetId,
          fromMs: from.getTime(),
          toMs: to.getTime(),
          limit,
        },
        { timeoutMs: HISTORY_TIMEOUT_MS },
      );
      return rows.map((r) => ({
        observedAt: new Date(Number(r.ms)),
        priceMinor: Number(r.price_minor),
        currency: r.currency,
      }));
    } catch (error) {
      throw new ObservationHistoryUnavailable(error);
    }
  }
}
