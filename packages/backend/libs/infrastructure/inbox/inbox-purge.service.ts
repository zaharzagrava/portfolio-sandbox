import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { INBOX_PURGE_BATCH, InboxService } from './inbox.service';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'inbox.purge': Record<string, never>;
  }
}

declareJobType({
  name: 'inbox.purge',
  contract: z.object({}),
});

export const INBOX_PURGE_JOB = 'inbox.purge';
/** Terminal inbox rows are kept this long (S53 assumption: 30 days). */
export const INBOX_RETENTION_MS = 30 * 86_400_000;

/** Body of the `inbox.purge` job (S49): terminal rows older than 30 days, in batches of at most 1 000. */
@Injectable()
export class InboxPurgeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InboxPurgeService.name);

  constructor(
    private readonly inbox: InboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs?.upsertSchedule({
      name: INBOX_PURGE_JOB,
      cron: '17 * * * *',
      jobType: INBOX_PURGE_JOB,
      payload: {},
    });
  }

  @JobHandler(INBOX_PURGE_JOB, { concurrency: 1 })
  async run(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - INBOX_RETENTION_MS);
    let total = 0;
    for (;;) {
      const removed = await this.inbox.purge(cutoff);
      total += removed;
      if (removed < INBOX_PURGE_BATCH) break;
    }
    if (total > 0) this.logger.log(`purged ${total} inbox rows`);
    return total;
  }
}
