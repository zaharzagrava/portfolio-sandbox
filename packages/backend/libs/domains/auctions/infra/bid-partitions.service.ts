import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { defaultPartitionRows } from '../domain/auction-metrics';
import { AUCTION_SETTINGS } from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';

/**
 * Monthly partitions of the append-only "Bid" log, always created ahead (S21 FR-037, P0318): the current month and
 * `auctions_partition_months_ahead` more. Two runs at once are serialized by a transaction-level advisory lock, so
 * the second finds the partitions and adds nothing. A bid whose month has no partition still lands in the default
 * partition and never fails; the gauge counts what is parked there so an alert can fire (AS-50).
 */
@Injectable()
export class BidPartitionService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    private readonly runner: TransactionRunner,
  ) {}

  async ensure(): Promise<{ defaultRows: number }> {
    const now = this.clock.now();
    await this.runner.run(async () => {
      await this.sequelize.query(
        `SELECT pg_advisory_xact_lock(hashtext('auctions.ensure-bid-partitions'))`,
        { type: QueryTypes.SELECT },
      );
      await this.sequelize.query(
        `SELECT bid_ensure_partitions(date_trunc('month', CAST(:now AS timestamptz))::date, :months)`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            now,
            months: this.settings.partitionMonthsAhead + 1,
          },
        },
      );
    });
    const [row] = await this.sequelize.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM "Bid_default"`,
      { type: QueryTypes.SELECT },
    );
    const defaultRows = Number(row?.rows ?? 0);
    defaultPartitionRows.set(defaultRows);
    return { defaultRows };
  }
}
