import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import type {
  AggregateReader,
  ExactHourClicks,
  RawClickReader,
} from '../domain/ads-ports';
import { ANALYTICS_TIMEOUT_MS } from '../domain/ads-constants';
import { withDeadline } from './ads-timeout';

const SETTINGS = { max_execution_time: ANALYTICS_TIMEOUT_MS / 1000 };

/** `YYYY-MM-DDTHH` -> `YYYY-MM-DD HH:00:00`, the form `DateTime` parameters take. */
const chHour = (hour: string) =>
  `${hour.slice(0, 10)} ${hour.slice(11, 13)}:00:00`;

/**
 * The two analytics reads of billing, with a 10 s limit (FR-072):
 *  - the exact valid clicks of a UTC day from the raw log: one row per click id, the first recorded verdict (`argMin` over
 *    `(received_at, ingested_at)`), counted in the hour and day of its own `received_at` (AS-49, AS-66);
 *  - the committed per-minute aggregates of an hour, partials of the salted keys summed, read with `FINAL` so a redelivered
 *    batch counts once (AS-46).
 * A failure or a timeout throws `AdsDependencyUnavailableError`: reconciliation then records `FAILED` and moves no money.
 */
@Injectable()
export class ClickhouseAdReader implements RawClickReader, AggregateReader {
  constructor(private readonly clickhouse: ClickHouseService) {}

  private query<T extends Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    return withDeadline('analytics', ANALYTICS_TIMEOUT_MS, async () => {
      const result = await this.clickhouse.getClient().query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: SETTINGS,
      });
      return result.json<T>();
    });
  }

  async exactValidClicksByHour(day: string): Promise<ExactHourClicks[]> {
    // The window is widened by an hour on each side so that every row of a click id is seen before the verdict is chosen.
    const rows = await this.query<{
      campaign_id: string;
      hour: string;
      clicks: string;
    }>(
      `SELECT campaign_id, formatDateTime(toStartOfHour(ts), '%Y-%m-%dT%H', 'UTC') AS hour, count() AS clicks
         FROM (
           SELECT click_id,
                  argMin(campaign_id, (received_at, ingested_at)) AS campaign_id,
                  argMin(valid, (received_at, ingested_at)) AS first_valid,
                  min(received_at) AS ts
             FROM ad_clicks_log
            WHERE received_at >= toDateTime64({day:String}, 3, 'UTC') - INTERVAL 1 HOUR
              AND received_at <  toDateTime64({day:String}, 3, 'UTC') + INTERVAL 25 HOUR
            GROUP BY click_id)
        WHERE first_valid = 1
          AND ts >= toDateTime64({day:String}, 3, 'UTC')
          AND ts <  toDateTime64({day:String}, 3, 'UTC') + INTERVAL 1 DAY
        GROUP BY campaign_id, hour
        ORDER BY campaign_id, hour`,
      { day: `${day} 00:00:00` },
    );
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      hour: r.hour,
      clicks: Number(r.clicks),
    }));
  }

  async clicksByCampaign(
    hour: string,
  ): Promise<{ campaignId: string; clicks: number }[]> {
    const rows = await this.query<{ campaign_id: string; clicks: string }>(
      `SELECT campaign_id, sum(clicks) AS clicks FROM ad_click_minute_v2 FINAL
        WHERE minute >= {from:DateTime('UTC')} AND minute < {from:DateTime('UTC')} + INTERVAL 1 HOUR
        GROUP BY campaign_id HAVING clicks > 0
        ORDER BY campaign_id`,
      { from: chHour(hour) },
    );
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      clicks: Number(r.clicks),
    }));
  }
}
