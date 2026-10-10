import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import type {
  EligibleQueryParams,
  EligibleQueryRow,
  SearchLogReader,
} from '../domain/autocomplete-ports';
import { AutocompleteSettings } from './autocomplete-config';

/**
 * `SearchLogReader` over the ClickHouse `search_queries` table (read-only; the table and its projector are S32's).
 * Columns read: `event_id, query, results, user_hash, surface, ts`. Rows of the assistant's in-process searches
 * (`surface = 'internal'`) are not typing and are left out; a row without a surface (written before S32 added the column,
 * or a table without it) reads as `'http'`. Rows are collapsed per `event_id` first, so a re-delivered event counts once; popularity
 * is the exact number of distinct searchers; the order is `searchers DESC, query ASC` (deterministic).
 */
@Injectable()
export class SearchLogReaderAdapter implements SearchLogReader {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly settings: AutocompleteSettings,
  ) {}

  private async hasSurface(): Promise<boolean> {
    const rows = await this.clickhouse.query<{ n: string }>(
      `SELECT count() AS n FROM system.columns
       WHERE database = currentDatabase() AND table = 'search_queries' AND name = 'surface'`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async eligibleQueries(
    params: EligibleQueryParams,
    signal?: AbortSignal,
  ): Promise<EligibleQueryRow[]> {
    const surface = await this.hasSurface();
    const result = await this.clickhouse.getClient().query({
      query: `
        SELECT query, uniqExact(user_hash) AS searchers
        FROM (
          SELECT event_id,
                 argMin(query, ts) AS query,
                 argMin(user_hash, ts) AS user_hash,
                 argMin(results, ts) AS results
                 ${surface ? ', argMin(surface, ts) AS surface' : ''}
          FROM search_queries FINAL
          WHERE ts >= now() - INTERVAL {days:UInt32} DAY
          GROUP BY event_id
        )
        WHERE results > 0 ${surface ? "AND surface != 'internal'" : ''}
        GROUP BY query
        HAVING searchers >= {min:UInt32}
        ORDER BY searchers DESC, query ASC
        LIMIT {limit:UInt32}`,
      query_params: {
        days: params.windowDays,
        min: params.minSearchers,
        limit: params.cap,
      },
      format: 'JSONEachRow',
      abort_signal: signal,
      clickhouse_settings: {
        max_execution_time: Math.ceil(this.settings.logQueryTimeoutMs / 1000),
      },
    });
    const rows = await result.json<{ query: string; searchers: string }>();
    return rows.map((r) => ({
      query: r.query,
      searchers: Number(r.searchers),
    }));
  }
}
