import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'outbox.purge-published': Record<string, never>;
  }
}

export const PURGE_PUBLISHED_JOB = 'outbox.purge-published';
const BATCH_SIZE = 1_000;
const DAY_MS = 86_400_000;

/**
 * Body of the `outbox.purge-published` job (S49): deletes published rows older than the retention period
 * (`outbox_retention_days`, default 7), oldest first, in batches of at most 1 000. Pending and parked rows are
 * never touched: an unpublished row is a message not yet delivered, a parked row waits for an operator.
 */
@Injectable()
export class OutboxPurgeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPurgeService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs?.upsertSchedule({
      name: PURGE_PUBLISHED_JOB,
      cron: '*/15 * * * *',
      jobType: PURGE_PUBLISHED_JOB,
      payload: {},
    });
  }

  /** Deletes one batch of at most 1 000 rows; returns how many went. */
  async purgeBatch(): Promise<number> {
    const cutoff = new Date(
      this.clock.nowMs() - this.config.get('outbox_retention_days') * DAY_MS,
    );
    return this.runner.run(async (transaction) => {
      const [rows] = await this.sequelize.query(
        `DELETE FROM "Outbox" WHERE "id" IN (
           SELECT "id" FROM "Outbox"
           WHERE "status" = 'published' AND "publishedAt" < $1
           ORDER BY "publishedAt" LIMIT $2
         ) RETURNING "id"`,
        { bind: [cutoff, BATCH_SIZE], transaction },
      );
      return rows.length;
    });
  }

  /** Runs batches until none is left; returns the total removed. */
  @JobHandler(PURGE_PUBLISHED_JOB, { concurrency: 1 })
  async run(): Promise<number> {
    let total = 0;
    for (;;) {
      const removed = await this.purgeBatch();
      total += removed;
      if (removed < BATCH_SIZE) break;
    }
    if (total > 0) this.logger.log(`purged ${total} published outbox rows`);
    return total;
  }
}
