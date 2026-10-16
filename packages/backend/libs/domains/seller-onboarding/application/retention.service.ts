import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext, TransactionRunner } from '@app/infrastructure/context';
import { correlate } from './log-line';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  APPLICATIONS,
  DOCUMENTS,
  REVIEW_TASKS,
  STATUS_HISTORY,
  type ApplicationRepository,
  type DocumentRepository,
  type ReviewTaskRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import type { ExtractionConfig } from '../domain/extraction-config';
import { EXTRACTION_CONFIG } from './extraction-config.token';
import './onboarding-documents.job-types';

/** The scheduled erasure of a deleted shop's onboarding records (S04 FR-050): unique per shop. */
export const eraseKey = (shopId: string) => `erase:${shopId}`;

/** A hop of the erase job; the scheduler refuses `runAt` more than 366 days ahead. */
const MAX_HOP_MS = 365 * 86_400_000;

/**
 * Retention (S04 FR-050, design 44 PII retention): raw KYC files go 30 days after the verification or rejection of
 * their round and at once when the shop is deleted; the sealed extracted fields stay for the record period and are then
 * erased with every other row of the shop. Everything here is idempotent. Storage calls never run inside a transaction:
 * each file is deleted, then marked purged, so a failure leaves that file unpurged for the retry and the files already
 * purged purged.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    @Inject(DOCUMENTS) private readonly documents: DocumentRepository,
    @Inject(REVIEW_TASKS) private readonly tasks: ReviewTaskRepository,
    @Inject(STATUS_HISTORY) private readonly history: StatusHistoryRepository,
    @Inject(EXTRACTION_CONFIG) private readonly config: ExtractionConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly storage: ObjectStorage,
    private readonly jobs: JobsService,
    @Optional() private readonly context?: RequestContext,
  ) {}

  /** The raw files of one round (`APPROVED`, `REJECTED`, `SUPERSEDED` documents). */
  async purgeRound(shopId: string, submissionNo: number): Promise<number> {
    return this.purge(
      await this.documents.listUnpurged({ shopId, submissionNo }),
      shopId,
    );
  }

  /** Every raw file of the shop, whatever the status (the shop is gone). */
  async purgeShop(shopId: string): Promise<number> {
    return this.purge(await this.documents.listUnpurged({ shopId }), shopId);
  }

  /**
   * `tenancy.shop_deleted`: raw files at once, open tasks cancelled, the record erasure scheduled
   * `recordRetentionDays` later. A shop without onboarding data is a no-op.
   */
  async shopDeleted(shopId: string): Promise<void> {
    if (!(await this.applications.find(shopId))) return;
    await this.purgeShop(shopId);
    await this.tasks.cancelForShop(shopId);
    const dueAt = new Date(
      this.clock.now().getTime() + this.config.recordRetentionDays * 86_400_000,
    );
    await this.scheduleErase(shopId, dueAt, eraseKey(shopId));
  }

  /**
   * Hard-deletes every onboarding, document, extraction, task and history row of the shop, in one transaction - but only
   * once `dueAt` has passed. S49 schedules at most 366 days ahead, so the job hops: an early run schedules the next hop
   * (at most a year on) and deletes nothing.
   */
  async erase(shopId: string, dueAt?: string): Promise<void> {
    const due = dueAt ? new Date(dueAt) : null;
    if (due && this.clock.now() < due) {
      const hop = this.hopAt(due);
      await this.scheduleErase(
        shopId,
        due,
        `${eraseKey(shopId)}:${hop.toISOString().slice(0, 10)}`,
      );
      return;
    }
    await this.transactions.run(async () => {
      await this.documents.erase(shopId);
      await this.history.erase(shopId);
      await this.applications.erase(shopId);
    });
  }

  /** The next run: the due time itself, or a year from now when that is further away than the scheduler allows. */
  private hopAt(due: Date): Date {
    return new Date(
      Math.min(due.getTime(), this.clock.now().getTime() + MAX_HOP_MS),
    );
  }

  private async scheduleErase(
    shopId: string,
    dueAt: Date,
    idempotencyKey: string,
  ): Promise<void> {
    await this.jobs.enqueue(
      'onboarding.erase-records',
      { shopId, dueAt: dueAt.toISOString() },
      { runAt: this.hopAt(dueAt), idempotencyKey },
    );
  }

  private async purge(
    files: Array<{ id: string; storageKey: string }>,
    shopId: string,
  ): Promise<number> {
    let purged = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await this.storage.delete(file.storageKey);
        await this.documents.markPurged(file.id, this.clock.now());
        purged++;
      } catch (error) {
        failed++;
        this.logger.warn(
          correlate(
            `could not purge document ${file.id} of shop ${shopId}: ${(error as Error).name}`,
            this.context,
          ),
        );
      }
    }
    // the job fails (and is retried) while any file is left; the ones already purged stay purged
    if (failed > 0)
      throw new Error(
        `${failed} of ${files.length} raw files could not be purged`,
      );
    return purged;
  }
}
