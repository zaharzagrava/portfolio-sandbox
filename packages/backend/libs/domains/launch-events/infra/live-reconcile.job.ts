import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  InvalidScheduleError,
  JobHandler,
  JobsService,
} from '@app/infrastructure/jobs';
import { logLiveError } from '../application/live-log';
import { LiveMutes } from '../application/live-mutes.service';
import '../application/live.job-types';
import {
  LIVE_RECONCILE_CRON,
  LIVE_RECONCILE_JOB,
  LIVE_RECONCILE_SCHEDULE,
} from '../domain/live-constants';
import {
  ACTIVE_STREAM_SET,
  LIVE_STREAMS,
  type ActiveStreams,
  type LiveStreamRepository,
} from '../domain/live-ports';

/**
 * Every 30 seconds (FR-041): the set of active streams the statistics publisher walks and the mute caches are derived
 * data, rebuilt from the durable records. Idempotent and safe under duplicate or concurrent runs: each makes the derived
 * data equal to the same authoritative answer.
 */
@Injectable()
export class LiveReconcileJob {
  constructor(
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
    @Inject(ACTIVE_STREAM_SET) private readonly active: ActiveStreams,
    private readonly mutes: LiveMutes,
  ) {}

  @JobHandler(LIVE_RECONCILE_JOB, { concurrency: 1 })
  async handle(): Promise<void> {
    await this.run();
  }

  async run(): Promise<{ added: number; removed: number; streams: number }> {
    const ids = await this.streams.listLiveIds();
    const changed = await this.active.replace(ids);
    for (const streamId of ids) await this.mutes.rebuild(streamId);
    return { ...changed, streams: ids.length };
  }
}

/** Upserts the every-30-seconds schedule (S49 keeps one run per schedule across replicas, `overlap: skip`). */
@Injectable()
export class LiveReconcileSchedule implements OnApplicationBootstrap {
  private readonly logger = new Logger(LiveReconcileSchedule.name);

  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: LIVE_RECONCILE_SCHEDULE,
        cron: LIVE_RECONCILE_CRON,
        jobType: LIVE_RECONCILE_JOB,
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      // A malformed schedule is a deploy bug: say so loudly, the stream still works and the active set is repaired on end.
      logLiveError(
        this.logger,
        'reconcile_schedule_refused',
        { code: error.field },
        error,
      );
    }
  }
}
