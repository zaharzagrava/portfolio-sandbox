import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { ScheduleService } from '../application/schedule.service';
import '../application/story.job-types';
import {
  STORY_PUBLISH_JOB,
  STORY_SWEEP_JOB,
} from '../application/story.job-types';

/**
 * The two jobs of S27 (FR-015, FR-016). Both are idempotent: the story row is locked and the schedule re-checked
 * before anything is published, so a stale, early or duplicated job does nothing and two sweeps at once publish once.
 */
@Injectable()
export class StoriesJobs {
  constructor(private readonly schedules: ScheduleService) {}

  @JobHandler(STORY_PUBLISH_JOB, { concurrency: 5 })
  async publish(
    payload: { storyId: string; scheduledAt: string },
    ctx: JobContext,
  ): Promise<void> {
    await this.schedules.fire(
      payload.storyId,
      payload.scheduledAt,
      ctx.isLastAttempt,
    );
  }

  @JobHandler(STORY_SWEEP_JOB, { concurrency: 1 })
  async sweep(): Promise<void> {
    await this.schedules.sweep();
  }
}

/** Upserts the every-minute sweep at start (S49 keeps one run per schedule across replicas, `overlap: skip`). */
@Injectable()
export class StoriesSchedule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.upsertSchedule({
      name: STORY_SWEEP_JOB,
      cron: '* * * * *',
      jobType: STORY_SWEEP_JOB,
      payload: {},
      overlap: 'skip',
    });
  }
}
