import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { COUNTER_STORE, type CounterStore } from '../domain/ports';
import { scrub } from '../domain/scrub';
import { InboxService } from './inbox.service';
import './notification-delivery.job-types';

/** A user is repaired only when the mark is older than this: a router that is still between insert and count is left alone. */
const SETTLE_MS = 60_000;
const BATCH = 500;
const MAX_BATCHES = 10;

/**
 * The handler of job `notifications.reconcile-unread` (S49, every 5 minutes, one run in the fleet): a user the router
 * marked dirty before an inbox insert and never cleared (a crash between storing and counting) gets the counter rebuilt
 * from the inbox itself (FR-038, AS-62). Idempotent: a rebuild is a recount, never an adjustment, and a repeat finds
 * the user already cleared.
 */
@Injectable()
export class UnreadReconcileService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UnreadReconcileService.name);

  constructor(
    @Inject(COUNTER_STORE) private readonly counter: CounterStore,
    private readonly inbox: InboxService,
    private readonly jobs: JobsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'notifications.reconcile-unread',
        cron: '0 */5 * * * *',
        jobType: 'notifications.reconcile-unread',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('notifications.reconcile-unread', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async reconcile(): Promise<{ rebuilt: number; failed: number }> {
    let rebuilt = 0;
    let failed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const before = new Date(this.clock.now().getTime() - SETTLE_MS);
      const users = await this.counter.dirtyBefore(before, BATCH);
      for (const userId of users) {
        try {
          await this.inbox.rebuildUnread(userId);
          await this.counter.clearDirty(userId);
          rebuilt++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `notifications.reconcile.failed userId=${userId}: ${scrub((error as Error).message)}`,
          );
        }
      }
      // A failed user stays marked and would come back at once: stop there and leave it to the next run.
      if (users.length < BATCH || failed > 0) break;
    }
    return { rebuilt, failed };
  }
}
