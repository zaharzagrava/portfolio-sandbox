import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { draftJobCounter } from '../application/draft-metrics';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  COLLAB_CONTROL,
  DRAFT_REPOSITORY,
  SNAPSHOT_STORE,
  SUPERSEDED_REGISTRY,
  VERSION_REPOSITORY,
  type CollabControl,
  type DraftRepository,
  type SnapshotStore,
  type SupersededRegistry,
  type VersionRepository,
} from '../domain/draft-ports';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'drafts.release-stale-publishing': Record<string, never>;
    'drafts.purge-superseded-snapshots': Record<string, never>;
  }
}

declareJobType({
  name: 'drafts.release-stale-publishing',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'drafts.purge-superseded-snapshots',
  contract: z.object({}).strict(),
});

/** Leases handled per run of the stale-publishing job. */
export const STALE_PER_RUN = 500;
const PAGE = 100;

/**
 * Housekeeping of the draft part of `catalog` (S06 AS-37, AS-56), one run in the whole fleet, both idempotent:
 *  - every minute, a draft in `PUBLISHING` whose 60 second lease ended goes back to `DRAFT` (conditional on the lease id,
 *    so a publisher that finishes in the same instant wins or loses cleanly);
 *  - every day, superseded snapshots past their 10 minute grace and version objects that no row references (a failed
 *    publish wrote the object and rolled back) older than one hour are deleted, a hundred at a time.
 */
@Injectable()
export class DraftsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(DraftsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore,
    @Inject(SUPERSEDED_REGISTRY)
    private readonly superseded: SupersededRegistry,
    @Inject(COLLAB_CONTROL) private readonly collab: CollabControl,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const schedule of [
      { name: 'drafts.release-stale-publishing', cron: '* * * * *' },
      { name: 'drafts.purge-superseded-snapshots', cron: '0 4 * * *' },
    ] as const) {
      try {
        await this.jobs.upsertSchedule({
          name: schedule.name,
          cron: schedule.cron,
          jobType: schedule.name,
          payload: {},
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(`schedule not registered: ${error.message}`);
      }
    }
  }

  @JobHandler('drafts.release-stale-publishing', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async releaseStalePublishing(): Promise<{ released: number }> {
    const now = this.clock.now();
    const stale = await this.drafts.expiredLeases(now, STALE_PER_RUN);
    let released = 0;
    for (const draft of stale) {
      const back = await this.drafts.transition({
        shopId: draft.shopId,
        draftId: draft.id,
        from: 'PUBLISHING',
        to: 'DRAFT',
        leaseId: draft.leaseId,
        now,
      });
      if (!back) continue; // the publisher finished or released in the meantime
      released += 1;
      await this.collab
        .unfreeze(draft.id, draft.leaseId)
        .catch(() => undefined);
    }
    draftJobCounter.add(released, { kind: 'stale_lease_released' });
    this.logger.log({
      msg: 'stale publishing released',
      event: 'drafts_released',
      released,
    });
    return { released };
  }

  @JobHandler('drafts.purge-superseded-snapshots', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 300_000,
  })
  async purgeSuperseded(): Promise<{ superseded: number; orphans: number }> {
    const now = this.clock.now();
    let superseded = 0;
    for (;;) {
      const due = await this.superseded.due(now, PAGE);
      if (due.length === 0) break;
      for (const entry of due) {
        await this.snapshots.delete(entry.key);
        await this.superseded.remove(entry.token);
        superseded += 1;
      }
    }

    const cutoff = now.getTime() - DRAFT_LIMITS.orphanObjectAgeMs;
    const old = (await this.snapshots.list('versions/')).filter(
      (o) => o.lastModified.getTime() <= cutoff,
    );
    let orphans = 0;
    for (let i = 0; i < old.length; i += PAGE) {
      const page = old.slice(i, i + PAGE);
      const referenced = await this.versions.referencedKeys(
        page.map((o) => o.key),
      );
      for (const object of page)
        if (!referenced.has(object.key)) {
          await this.snapshots.delete(object.key);
          orphans += 1;
        }
    }
    draftJobCounter.add(superseded, { kind: 'superseded_deleted' });
    draftJobCounter.add(orphans, { kind: 'orphan_deleted' });
    this.logger.log({
      msg: 'draft objects purged',
      event: 'drafts_objects_purged',
      superseded,
      orphans,
    });
    return { superseded, orphans };
  }
}
