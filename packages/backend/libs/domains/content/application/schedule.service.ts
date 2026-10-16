import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StoryPublishResultDto } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  StoryError,
  isPermanentPublishCode,
  notScheduled,
  scheduleInPast,
  scheduleTooFar,
  storyNotFound,
  validationFailed,
  versionConflict,
} from '../domain/errors';
import type { StoryConfig } from '../domain/limits';
import {
  STORY_REPOSITORY,
  TRANSITION_REPOSITORY,
  VERSION_REPOSITORY,
  type StoryRepository,
  type TransitionRepository,
  type VersionRepository,
} from '../domain/ports';
import { checkSchedule } from '../domain/schedule-rules';
import { StoryScheduleFailed } from './events/story-events';
import { logOutcome } from './story-log';
import { PublishService, ShopNotActiveError } from './publish.service';
import { STORY_CONFIG } from './story-config.token';
import { StoryWriteLimit } from './story-limits';
import { storyMetrics } from './story-metrics';
import { STORY_PUBLISH_JOB, storyPublishJobKey } from './story.job-types';

/** Sweep batch: due schedules handled per run (the next minute continues). */
const SWEEP_BATCH = 200;

const permanentCodeOf = (error: unknown): string | null => {
  if (error instanceof ShopNotActiveError) return error.storyCode;
  if (error instanceof StoryError && isPermanentPublishCode(error.storyCode))
    return error.storyCode;
  return null;
};

/**
 * Scheduled publish (S27 FR-014 to FR-017). A schedule is an attribute of the story (`scheduledAt`), never a status.
 * One delayed job per schedule publishes only when the story is still scheduled at exactly that time and it is due; a
 * sweep every minute catches the jobs that were lost. A permanent failure at fire time clears the schedule and
 * records `scheduleFailure` and `story.schedule_failed`; a transient one is retried by the scheduler.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger('StorySchedule');

  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(TRANSITION_REPOSITORY)
    private readonly transitions: TransitionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
    private readonly runner: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly outbox: OutboxService,
    private readonly publisher: PublishService,
    private readonly writes: StoryWriteLimit,
  ) {}

  async schedule(
    shopId: string,
    storyId: string,
    actorId: string,
    expectedVersion: number,
    at: string,
  ): Promise<StoryPublishResultDto> {
    await this.writes.take(shopId);
    const checked = checkSchedule(
      at,
      this.clock.now(),
      this.config.scheduleHorizonDays,
    );
    if (!checked.ok) {
      if (checked.code === 'invalid_format')
        throw validationFailed([{ field: 'at', code: 'invalid_format' }]);
      throw checked.code === 'schedule_in_past'
        ? scheduleInPast()
        : scheduleTooFar();
    }
    const scheduledAt = checked.at;
    const now = this.clock.now();
    const story = await this.runner.run(async () => {
      const locked = await this.stories.lock(shopId, storyId);
      if (!locked) throw storyNotFound();
      if ((locked.publishedVersion ?? 0) !== expectedVersion)
        throw versionConflict(locked.publishedVersion ?? 0);
      await this.stories.setSchedule({
        shopId,
        storyId,
        scheduledAt,
        scheduledBy: actorId,
      });
      await this.transitions.record({
        shopId,
        storyId,
        from: locked.status,
        to: locked.status,
        action: 'schedule',
        actor: actorId,
        now,
      });
      return locked;
    });
    await this.enqueue(shopId, storyId, scheduledAt);
    const locales =
      story.publishedVersion === null
        ? []
        : (
            await this.versions.rows(shopId, storyId, story.publishedVersion)
          ).map((r) => r.locale);
    return {
      status: story.status,
      version: story.publishedVersion,
      locales,
      publishedAt: story.publishedAt ? story.publishedAt.toISOString() : null,
      scheduledAt: scheduledAt.toISOString(),
    };
  }

  /** The job is a convenience: if it cannot be created the sweep still publishes the story (FR-016). */
  private async enqueue(
    shopId: string,
    storyId: string,
    scheduledAt: Date,
  ): Promise<void> {
    const iso = scheduledAt.toISOString();
    try {
      await this.jobs.enqueue(
        STORY_PUBLISH_JOB,
        { storyId, scheduledAt: iso },
        {
          runAt: scheduledAt,
          idempotencyKey: storyPublishJobKey(storyId, iso),
          shopId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `alert: the reveal job was not created (${(error as Error).name}); the sweep will publish it`,
      );
    }
  }

  async cancel(
    shopId: string,
    storyId: string,
    actorId: string,
  ): Promise<void> {
    await this.writes.take(shopId);
    const now = this.clock.now();
    await this.runner.run(async () => {
      const locked = await this.stories.lock(shopId, storyId);
      if (!locked) throw storyNotFound();
      if (!(await this.stories.clearSchedule(shopId, storyId)))
        throw notScheduled();
      await this.transitions.record({
        shopId,
        storyId,
        from: locked.status,
        to: locked.status,
        action: 'cancel_schedule',
        actor: actorId,
        now,
      });
    });
  }

  /**
   * The `stories.publish` job and the sweep. `isLastAttempt` is true on the scheduler's final try: a transient failure
   * then becomes the permanent code `publish_failed` instead of being thrown into a dead job.
   */
  async fire(
    storyId: string,
    scheduledAtIso: string,
    isLastAttempt: boolean,
  ): Promise<void> {
    const scheduledAt = new Date(scheduledAtIso);
    const shopId = await this.stories.shopIdOf(storyId);
    if (!shopId || Number.isNaN(scheduledAt.getTime())) return;
    try {
      const result = await this.publisher.execute({
        shopId,
        storyId,
        actorId: null,
        fire: { scheduledAt },
      });
      const fired = result.kind === 'published' ? 'published' : 'skipped';
      storyMetrics.scheduleFired.add(1, { result: fired });
      logOutcome(this.logger, 'story.fire', {
        outcome: fired,
        storyId,
        shopId,
        version:
          result.kind === 'published'
            ? (result.dto.version ?? undefined)
            : undefined,
      });
    } catch (error) {
      if (error instanceof StoryError && error.storyCode === 'story_not_found')
        return;
      const code = permanentCodeOf(error);
      if (code) return this.recordFailure(shopId, storyId, scheduledAt, code);
      if (isLastAttempt)
        return this.recordFailure(
          shopId,
          storyId,
          scheduledAt,
          'publish_failed',
        );
      storyMetrics.scheduleFired.add(1, { result: 'retried' });
      throw error;
    }
  }

  private async recordFailure(
    shopId: string,
    storyId: string,
    scheduledAt: Date,
    code: string,
  ): Promise<void> {
    const now = this.clock.now();
    const recorded = await this.runner.run(async () => {
      const locked = await this.stories.lock(shopId, storyId);
      if (
        !locked ||
        !locked.scheduledAt ||
        locked.scheduledAt.getTime() !== scheduledAt.getTime()
      )
        return false;
      await this.stories.recordScheduleFailure({
        shopId,
        storyId,
        at: now,
        code,
      });
      await this.transitions.record({
        shopId,
        storyId,
        from: locked.status,
        to: locked.status,
        action: 'fire_failed',
        actor: locked.scheduledBy,
        now,
      });
      await this.outbox.append(
        StoryScheduleFailed.create(storyId, locked.publishedVersion ?? 0, {
          storyId,
          shopId,
          scheduledAt: scheduledAt.toISOString(),
          code,
        }),
      );
      return true;
    });
    if (recorded) {
      storyMetrics.scheduleFired.add(1, { result: 'failed' });
      this.logger.warn(`alert: a scheduled publish failed for good (${code})`);
      logOutcome(this.logger, 'story.fire', {
        outcome: 'failed',
        storyId,
        shopId,
        code,
      });
    }
  }

  /** Publishes every due schedule whose job did not (S27 AS-46). Safe to run twice at once: each story is locked. */
  async sweep(): Promise<number> {
    const due = await this.stories.claimDue(this.clock.now(), SWEEP_BATCH);
    let handled = 0;
    for (const candidate of due) {
      try {
        await this.fire(
          candidate.id,
          candidate.scheduledAt.toISOString(),
          false,
        );
        handled++;
      } catch (error) {
        this.logger.warn(
          `sweep could not publish a due story (${(error as Error).name}); it stays due`,
        );
      }
    }
    return handled;
  }
}
