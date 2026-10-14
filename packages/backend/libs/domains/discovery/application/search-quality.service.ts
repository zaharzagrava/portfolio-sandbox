import { Injectable } from '@nestjs/common';
import {
  searchQualityQuerySchema,
  type SearchQualityReport,
} from '@marketplace-sandbox/contracts';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { SearchValidationError } from '../domain/search-errors';

/**
 * Relevance is measured, not guessed: result clicks + query logs (SD-12) give CTR, mean reciprocal rank and
 * zero-result rate per query - the numbers you look at before and after changing boosts or synonyms (S32 FR-054).
 * Parameters outside their range are refused, never clamped.
 */
@Injectable()
export class SearchQualityService {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async report(
    rawQuery: Record<string, unknown>,
  ): Promise<SearchQualityReport> {
    const parsed = searchQualityQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new SearchValidationError([
        ...new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys
              : [String(issue.path[0] ?? 'query')],
          ),
        ),
      ]);
    const { days, limit } = parsed.data;
    const rows = await this.clickhouse.query<{
      query: string;
      searches: string | number;
      ctr: number;
      mrr: number;
      zeroResultRate: number;
    }>(
      `WITH s AS (
         SELECT query, count() AS searches, countIf(results = 0) AS zero
         FROM search_queries FINAL WHERE ts >= now() - INTERVAL {days:UInt32} DAY GROUP BY query
       ), c AS (
         SELECT query, count() AS clicks, sum(1 / (position + 1)) AS rr
         FROM search_clicks FINAL WHERE ts >= now() - INTERVAL {days:UInt32} DAY GROUP BY query
       )
       SELECT s.query AS query, s.searches AS searches,
              round(coalesce(c.clicks, 0) / s.searches, 3) AS ctr,
              round(coalesce(c.rr, 0) / s.searches, 3) AS mrr,
              round(s.zero / s.searches, 3) AS zeroResultRate
       FROM s LEFT JOIN c USING (query)
       ORDER BY s.searches DESC, s.query ASC LIMIT {limit:UInt32}`,
      { days, limit },
    );
    return {
      rows: rows.map((row) => ({
        query: row.query,
        searches: Number(row.searches),
        ctr: Number(row.ctr),
        mrr: Number(row.mrr),
        zeroResultRate: Number(row.zeroResultRate),
      })),
    };
  }
}
