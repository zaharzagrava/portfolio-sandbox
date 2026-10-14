import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import {
  analyticsDeadLetterTotal,
  analyticsStoreErrorsTotal,
} from './analytics-metrics';

/**
 * The store consumes the stream itself (ClickHouse's Kafka engine): a message it cannot parse is written to
 * `analytics_events_errors` and the stream goes on (S39 FR-012). The application never sees that happen, so this watcher
 * counts the new rows of the error table into `analytics_dead_letter_total{source="store"}`.
 *
 * It runs as a scheduled job with one run at a time across the fleet (see `AnalyticsJobs`), so a row is counted once. The
 * first poll only takes the baseline (rows that existed before this process looked are not news); a count that went down
 * (the table's 14-day retention) resets the baseline.
 */
@Injectable()
export class StoreDeadLetterWatcher {
  private readonly logger = new Logger(StoreDeadLetterWatcher.name);
  private seen: number | null = null;

  constructor(private readonly clickhouse: ClickHouseService) {}

  /** Counts the error rows added since the previous poll and returns how many there were. */
  async poll(): Promise<number> {
    let total: number;
    try {
      const [row] = await this.clickhouse.query<{ n: string }>(
        'SELECT count() AS n FROM analytics_events_errors',
      );
      total = Number(row?.n ?? 0);
    } catch (error) {
      analyticsStoreErrorsTotal.add(1, { operation: 'dead-letter-poll' });
      this.logger.warn({
        event: 'analytics.dead_letter_poll_failed',
        reason: (error as Error)?.name,
      });
      return 0;
    }
    const previous = this.seen;
    this.seen = total;
    const fresh = previous === null ? 0 : Math.max(0, total - previous);
    if (fresh > 0) analyticsDeadLetterTotal.add(fresh, { source: 'store' });
    return fresh;
  }
}
