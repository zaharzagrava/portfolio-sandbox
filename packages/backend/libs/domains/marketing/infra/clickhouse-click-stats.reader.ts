import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import {
  DependencyUnavailableError,
  type ClickStats,
  type ClickStatsQuery,
  type ClickStatsReader,
} from '../domain/ports';

const TIMEOUT_MS = 2_000;
const COUNTRY_LIMIT = 10;

const BUCKET_FN = {
  minute: 'toStartOfMinute',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
} as const;

const chTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

/**
 * Owner statistics from `link_clicks` (derived, 13-month TTL; owner `marketing`). Counts are `uniqExact(click_id)`, so a
 * click delivered twice is one click before any background merge (AS-43). The window is `[from, to]`: a click exactly at
 * `from` counts, one just after `to` does not (AS-58).
 */
@Injectable()
export class ClickhouseClickStatsReader implements ClickStatsReader {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async read(query: ClickStatsQuery): Promise<ClickStats> {
    const params = {
      code: query.code,
      from: chTime(query.from),
      to: chTime(query.to),
    };
    const window =
      "code = {code:String} AND ts >= {from:DateTime64(3, 'UTC')} AND ts <= {to:DateTime64(3, 'UTC')}";
    const fn = BUCKET_FN[query.bucket];
    try {
      const [series, countries] = await this.withTimeout(
        Promise.all([
          this.clickhouse.query<{ start: string; clicks: string }>(
            `SELECT toUnixTimestamp(${fn}(ts, 'UTC')) AS start, uniqExact(click_id) AS clicks
               FROM link_clicks WHERE ${window} GROUP BY start ORDER BY start`,
            params,
          ),
          this.clickhouse.query<{ country: string; clicks: string }>(
            `SELECT country, uniqExact(click_id) AS clicks
               FROM link_clicks WHERE ${window} AND country != ''
               GROUP BY country ORDER BY clicks DESC, country ASC LIMIT ${COUNTRY_LIMIT}`,
            params,
          ),
        ]),
      );
      const rows = series.map((r) => ({
        start: new Date(Number(r.start) * 1000).toISOString(),
        clicks: Number(r.clicks),
      }));
      return {
        total: rows.reduce((sum, r) => sum + r.clicks, 0),
        series: rows,
        countries: countries.map((r) => ({
          country: r.country,
          clicks: Number(r.clicks),
        })),
      };
    } catch (error) {
      throw new DependencyUnavailableError('click-analytics', error);
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('analytics timeout')),
            TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
