import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { EXPORT_CONFIG, type ExportConfig } from '../domain/export-config';
import { MAX_EXPORT_DELIVERIES } from '../domain/export-failure';
import { exportFinishedCounter } from '../domain/export-metrics';
import {
  EXPORT_FILES,
  EXPORT_JOBS,
  EXPORT_LIVE,
  EXPORT_QUEUE,
  type ExportFilesPort,
  type ExportJobRecord,
  type ExportJobsPort,
  type ExportLivePort,
  type ExportQueuePort,
} from '../domain/export-ports';

export interface RecoveryResult {
  /** Running exports whose lease lapsed and that went back to `QUEUED`. */
  requeued: number;
  /** Running exports whose lease lapsed at the last attempt and that ended `FAILED`. */
  failed: number;
  /** Queued exports that waited too long for a worker and got their message again. */
  resent: number;
}

/** How many rows one pass looks at; the next pass takes the rest. */
const PASS_LIMIT = 200;
const DAY_MS = 86_400_000;

/**
 * Recovery, expiry, purge and the effects of shop events on exports (S12 FR-022 to FR-027). Every step is one
 * conditional statement, so two instances running at once change each export once, and none of them throws on the
 * condition it repairs: a failure is logged and the next pass tries again (L-016).
 */
@Injectable()
export class OrderExportMaintenanceService {
  private readonly logger = new Logger(OrderExportMaintenanceService.name);

  constructor(
    @Inject(EXPORT_JOBS) private readonly jobs: ExportJobsPort,
    @Inject(EXPORT_FILES) private readonly files: ExportFilesPort,
    @Inject(EXPORT_QUEUE) private readonly queue: ExportQueuePort,
    @Inject(EXPORT_LIVE) private readonly live: ExportLivePort,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * A running export whose lease lapsed goes back to `QUEUED` and gets a message, or ends `FAILED attempts_exhausted`
   * at the last attempt (no message); a queued export no worker took for `unclaimedSec` gets its message again.
   */
  async recoverStalled(): Promise<RecoveryResult> {
    const result: RecoveryResult = { requeued: 0, failed: 0, resent: 0 };
    const now = this.clock.now();

    for (const job of await this.safely(
      () => this.jobs.findExpiredLeases(now, PASS_LIMIT),
      [] as ExportJobRecord[],
    )) {
      await this.safely(async () => {
        if (job.attempt >= MAX_EXPORT_DELIVERIES) {
          const failed = await this.jobs.finish({
            exportId: job.id,
            leaseHolder: null,
            to: 'FAILED',
            failureCode: 'attempts_exhausted',
            rowsWritten: job.rowsWritten,
            bytesWritten: job.bytesWritten,
            now,
            reason: 'attempts_exhausted',
          });
          if (!failed) return;
          result.failed += 1;
          this.live.publish(job.id, {
            type: 'failed',
            code: 'attempts_exhausted',
          });
          await this.removeAttemptObjects(job);
          return;
        }
        const requeued = await this.jobs.requeue({
          exportId: job.id,
          leaseHolder: null,
          reason: 'lease_expired',
          restoreAttempt: false,
          now,
        });
        if (!requeued) return;
        result.requeued += 1;
        await this.removeAttemptObjects(job);
        await this.queue.enqueue(job.id);
      }, undefined);
    }

    const olderThan = new Date(now.getTime() - this.config.unclaimedSec * 1000);
    for (const job of await this.safely(
      () => this.jobs.findUnclaimed(olderThan, PASS_LIMIT),
      [] as ExportJobRecord[],
    )) {
      await this.safely(async () => {
        if (!(await this.jobs.claimResend(job.id, olderThan, now))) return;
        await this.queue.enqueue(job.id);
        result.resent += 1;
      }, undefined);
    }
    return result;
  }

  /**
   * A finished file older than `fileRetentionDays` is deleted, and only then does the export move `DONE → EXPIRED`
   * (so a refused delete leaves it `DONE` and the next run tries again).
   */
  async expireExports(): Promise<{ expired: number }> {
    const now = this.clock.now();
    const cutoff = new Date(
      now.getTime() - this.config.fileRetentionDays * DAY_MS,
    );
    let expired = 0;
    for (const job of await this.safely(
      () => this.jobs.findDoneBefore(cutoff, PASS_LIMIT),
      [] as ExportJobRecord[],
    )) {
      try {
        await this.removeAllObjects(`exports/${job.shopId}/${job.id}/`);
        if (job.fileKey) await this.files.delete(job.fileKey);
      } catch (error) {
        this.logger.warn(
          `order_export_expiry_delete_failed: ${(error as Error).name}`,
        );
        continue;
      }
      if (await this.safely(() => this.jobs.markExpired(job.id, now), false))
        expired += 1;
    }
    return { expired };
  }

  /** Records finished over `recordRetentionDays` ago go with their history and any file still there. */
  async purgeExports(): Promise<{ purged: number }> {
    const now = this.clock.now();
    const cutoff = new Date(
      now.getTime() - this.config.recordRetentionDays * DAY_MS,
    );
    let purged = 0;
    for (const job of await this.safely(
      () => this.jobs.findFinishedBefore(cutoff, PASS_LIMIT),
      [] as ExportJobRecord[],
    )) {
      try {
        await this.removeAllObjects(`exports/${job.shopId}/${job.id}/`);
        if (job.fileKey) await this.files.delete(job.fileKey);
        if (await this.jobs.purge(job.id)) purged += 1;
      } catch (error) {
        this.logger.warn(`order_export_purge_failed: ${(error as Error).name}`);
      }
    }
    return { purged };
  }

  /** `tenancy.shop_offboarding_started` / the first step of `shop_deleted`: the shop's queued and running exports end. */
  async cancelForShop(shopId: string, reason: string): Promise<number> {
    let cancelled = 0;
    for (const job of await this.jobs.findActiveByShop(shopId)) {
      const done = await this.jobs.cancel({
        shopId,
        exportId: job.id,
        actor: null,
        reason,
        now: this.clock.now(),
      });
      if (!done) continue;
      cancelled += 1;
      exportFinishedCounter.add(1, { status: 'CANCELLED' });
      this.live.publish(job.id, { type: 'cancelled' });
    }
    return cancelled;
  }

  /**
   * `tenancy.shop_deleted`: active exports are cancelled, every file of the shop is deleted, then the rows and their
   * history in bounded chunks. Safe to run again after a crash or a second delivery; a failure reaches the caller so the
   * event is delivered again.
   */
  async deleteShop(shopId: string): Promise<void> {
    await this.cancelForShop(shopId, 'shop_deleted');
    await this.removeAllObjects(`exports/${shopId}/`);
    await this.jobs.deleteByShop(shopId);
    await this.removeAllObjects(`exports/${shopId}/`); // a worker that finished while the rows went
  }

  private async removeAllObjects(prefix: string): Promise<void> {
    for (const key of await this.files.list(prefix))
      await this.files.delete(key);
  }

  /** Removes every attempt object of an export that has no file of its own (a dead worker's leftover). */
  private async removeAttemptObjects(job: ExportJobRecord): Promise<void> {
    const prefix = `exports/${job.shopId}/${job.id}/`;
    for (const key of await this.files.list(prefix))
      if (key !== job.fileKey) await this.files.delete(key);
  }

  private async safely<T>(step: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await step();
    } catch (error) {
      this.logger.warn(
        `order_export_recovery_step_failed: ${(error as Error).name}`,
      );
      return fallback;
    }
  }
}
