import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { IMPORT_LIMITS, importShopPrefix } from '../domain/import-limits';
import { ImportProblem } from '../domain/import-problems';
import {
  IMPORT_QUEUE,
  IMPORT_REPOSITORY,
  IMPORT_STORAGE,
  type ImportQueuePort,
  type ImportRepository,
  type ImportStoragePort,
} from '../domain/ports';
import { importMetrics } from './import-metrics';
import { ImportStartService } from './import-start.service';

const RECOVERY_BATCH = 200;
const prefixOf = (shopId: string, importId: string) =>
  `imports/${shopId}/${importId}/`;

/**
 * What keeps imports honest over time (S07 FR-028, FR-007, FR-042, FR-043): recovery of lost work, expiry of abandoned
 * uploads, retention, and the shop-lifecycle reactions. Every step is a conditional statement or an idempotent delete,
 * so two instances running the same job at once change nothing twice (objects go before rows, so a retry finds what
 * remains).
 */
@Injectable()
export class ImportLifecycleService {
  private readonly logger = new Logger(ImportLifecycleService.name);

  constructor(
    @Inject(IMPORT_REPOSITORY) private readonly repo: ImportRepository,
    @Inject(IMPORT_STORAGE) private readonly storage: ImportStoragePort,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly imports: ImportStartService,
  ) {}

  /**
   * Re-enqueues the imports whose message was lost (`UPLOADED` for two minutes with no live lease) or whose lease ran
   * out (`SCANNING`/`PROCESSING`), once per two-minute window: the repository stamps each job in the same statement that
   * selects it, so a second run or a second instance finds nothing to take.
   */
  async recoverStalled(): Promise<{ enqueued: number }> {
    const now = this.clock.now();
    const age = await this.repo.oldestCheckpointAgeMs(now);
    importMetrics.checkpointAgeSeconds.set(age === null ? 0 : age / 1000);
    const jobs = await this.repo.claimRecoverable(now, RECOVERY_BATCH);
    let enqueued = 0;
    for (const job of jobs) {
      try {
        await this.queue.enqueue(job.id);
        enqueued++;
      } catch (error) {
        // the stamp keeps the job out of this window; the next window tries again
        this.logger.error({
          action: 'import.recovery_enqueue_failed',
          importId: job.id,
          error: (error as Error).name,
        });
      }
    }
    if (enqueued > 0) this.logger.log({ action: 'import.recovered', enqueued });
    return { enqueued };
  }

  /** `PENDING_UPLOAD` older than 24 hours becomes `EXPIRED`: the open upload is aborted and the event is written. */
  async expirePending(): Promise<{ expired: number }> {
    const jobs = await this.repo.findExpirable(
      this.clock.now(),
      IMPORT_LIMITS.purgePerRun,
    );
    let expired = 0;
    for (const job of jobs) {
      const done = await this.repo.transition({
        importId: job.id,
        shopId: job.shopId,
        from: 'PENDING_UPLOAD',
        to: 'EXPIRED',
        reason: 'abandoned',
        clearUploadHandle: true,
        now: this.clock.now(),
      });
      if (!done) continue; // completed, cancelled or expired by someone else meanwhile
      expired++;
      importMetrics.finished.add(1, { status: 'EXPIRED' });
      await this.imports.discard(job);
    }
    return { expired };
  }

  /**
   * Retention: the error report 30 days after the import finished (the record keeps `errorReport.available: false`),
   * the record, its history and its objects after 90 days. At most 500 jobs per run, oldest first, final jobs only.
   */
  async purge(): Promise<{ records: number; reports: number }> {
    const now = this.clock.now().getTime();
    let budget = IMPORT_LIMITS.purgePerRun;
    let records = 0;
    for (const job of await this.repo.findRecordPurgeable(
      new Date(now - IMPORT_LIMITS.recordRetentionMs),
      budget,
    )) {
      await this.storage.deletePrefix(prefixOf(job.shopId, job.id));
      if (await this.repo.deleteJob(job.id)) records++;
      budget--;
    }
    let reports = 0;
    if (budget > 0)
      for (const job of await this.repo.findReportPurgeable(
        new Date(now - IMPORT_LIMITS.reportRetentionMs),
        budget,
      )) {
        if (job.errorReportKey)
          await this.storage.deleteObject(job.errorReportKey);
        if (await this.repo.clearReportKey(job.id)) reports++;
      }
    if (records + reports > 0)
      this.logger.log({ action: 'import.purged', records, reports });
    return { records, reports };
  }

  /** `tenancy.shop_offboarding_started`: the shop's non-final imports are cancelled (a running one at its next safe point). */
  async cancelForShop(shopId: string): Promise<{ cancelled: number }> {
    let cancelled = 0;
    for (const job of await this.repo.nonFinalByShop(shopId)) {
      try {
        await this.imports.cancel(shopId, job.id, 'system');
        cancelled++;
      } catch (error) {
        // finished between the read and the cancel: nothing to do
        if (
          !(error instanceof ImportProblem) ||
          error.importCode !== 'import_not_cancellable'
        )
          throw error;
      }
    }
    return { cancelled };
  }

  /** `tenancy.shop_deleted`: every object under the shop's prefix first, then its rows and history. */
  async deleteForShop(shopId: string): Promise<{ jobs: number }> {
    await this.storage.deletePrefix(importShopPrefix(shopId));
    const jobs = await this.repo.deleteByShop(shopId);
    this.logger.log({ action: 'import.shop_purged', shopId, jobs });
    return { jobs };
  }

  /** Gauge source: age of the oldest running checkpoint. */
  checkpointAgeMs(): Promise<number | null> {
    return this.repo.oldestCheckpointAgeMs(this.clock.now());
  }
}
