import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { defaultPartitionRowsGauge } from '../domain/ledger-metrics';
import {
  LEDGER_MAINTENANCE_STORE,
  type LedgerMaintenanceStore,
} from '../domain/ledger-ports';

export const DEFAULT_MONTHS_AHEAD = 3;

/**
 * Monthly partitions of the entries, created ahead of time (S14 FR-042, research R-3): the current month and the next
 * `monthsAhead`, each protected like the others (balance check at commit, append-only). Idempotent: an existing
 * partition is skipped. Rows that landed in the catch-all partition for a month that had no partition are moved into
 * the new partition by the SQL function (rebuild, counts and sums asserted), and the gauge returns to 0.
 */
@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(
    @Inject(LEDGER_MAINTENANCE_STORE)
    private readonly store: LedgerMaintenanceStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async ensure(options: { monthsAhead?: number } = {}): Promise<void> {
    const now = this.clock.now();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    await this.store.ensurePartitions(
      from,
      (options.monthsAhead ?? DEFAULT_MONTHS_AHEAD) + 1,
    );
    await this.refreshDefaultGauge();
  }

  /** Rows sitting in the catch-all partition: any is an alert (a month was not covered in time). */
  async refreshDefaultGauge(): Promise<number> {
    const rows = await this.store.defaultPartitionRows();
    defaultPartitionRowsGauge.set(rows);
    if (rows > 0)
      this.logger.error(
        `LEDGER ALERT: ${rows} entries sit in the catch-all partition; ledger.ensure-partitions moves them`,
      );
    return rows;
  }
}
