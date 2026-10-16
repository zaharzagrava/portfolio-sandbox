import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  ImportCompleteRequest,
  ImportJob,
  ImportStartRequest,
  ImportStartResponse,
  ImportUploadState,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { sanitiseFileName } from '../domain/file-name';
import { IMPORT_LIMITS, importSourceKey } from '../domain/import-limits';
import { ImportProblem, importUnavailable } from '../domain/import-problems';
import { isFinalImportStatus } from '../domain/import-status';
import {
  IMPORT_PUBLISHER,
  IMPORT_QUEUE,
  IMPORT_REPOSITORY,
  IMPORT_STORAGE,
  type ImportJobRecord,
  type ImportPublisherPort,
  type ImportQueuePort,
  type ImportRepository,
  type ImportStoragePort,
} from '../domain/ports';
import { importMetrics } from './import-metrics';
import { toImportJob } from './import.view';

export interface CompleteResult {
  job: ImportJob;
  /** `true` for the call that won the transition (`202` + `Location`); `false` for a replay (`200`). */
  created: boolean;
}

const unquote = (etag: string) => etag.replace(/^"|"$/g, '');

/**
 * Start, upload state, complete and cancel of an import (S07 FR-001 to FR-007, FR-036, FR-039). Every status change is
 * a conditional transition: the store picks one winner, the loser re-reads and answers from the state that won. No
 * storage call happens inside a transaction, and the queue message goes out after the commit.
 */
@Injectable()
export class ImportStartService {
  private readonly logger = new Logger(ImportStartService.name);

  constructor(
    @Inject(IMPORT_REPOSITORY) private readonly repo: ImportRepository,
    @Inject(IMPORT_STORAGE) private readonly storage: ImportStoragePort,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueuePort,
    @Inject(IMPORT_PUBLISHER) private readonly live: ImportPublisherPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly limiter: RateLimiterService,
    @Optional() private readonly context?: RequestContext,
  ) {}

  private notFound(): ImportProblem {
    return new ImportProblem('import_not_found');
  }

  /** `start`: a limit check, one insert (slot + history), then the multipart upload outside any transaction. */
  async start(
    shopId: string,
    userId: string,
    body: ImportStartRequest,
  ): Promise<ImportStartResponse> {
    await this.checkStartLimit(shopId);
    const now = this.clock.now();
    const id = uuidv7();
    const inserted = await this.repo.insertPending({
      id,
      shopId,
      createdBy: userId,
      fileName: sanitiseFileName(body.fileName),
      sizeBytes: body.sizeBytes,
      storageKey: importSourceKey(shopId, id),
      now,
    });
    if (inserted.kind === 'cap')
      throw new ImportProblem('too_many_active_imports');
    const job = inserted.job;

    let handle: string;
    try {
      handle = (await this.storage.startUpload(job.storageKey)).uploadHandle;
    } catch (error) {
      this.logger.error({
        action: 'import.upload_init_failed',
        importId: job.id,
        error: (error as Error).name,
      });
      await this.compensate(job, 'upload_init_failed');
      throw importUnavailable();
    }
    if (!(await this.repo.setUploadHandle(job.id, shopId, handle, now))) {
      // cancelled or expired in between: the upload we just opened has no owner
      await this.storage.abortUpload(job.storageKey, handle);
      throw new ImportProblem('import_not_uploadable');
    }
    this.logger.log({
      action: 'import.started',
      importId: job.id,
      shopId,
      requestId: this.context?.requestId,
    });
    const urls = await this.signParts(job, handle, undefined);
    return {
      importId: job.id,
      status: 'PENDING_UPLOAD',
      partSize: IMPORT_LIMITS.partBytes,
      partCount: urls.count,
      parts: urls.parts,
      uploadExpiresAt: new Date(
        now.getTime() + IMPORT_LIMITS.uploadUrlTtlSec * 1000,
      ).toISOString(),
    };
  }

  private async checkStartLimit(shopId: string): Promise<void> {
    const decision = await this.limiter.check(
      'catalog-sync.import-start.shop',
      shopId,
    );
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError();
    throw new Domain_RateLimitedError(
      Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000)),
    );
  }

  /** The job was created but its upload could not be opened: close it so it does not hold a slot for a day. */
  private async compensate(
    job: ImportJobRecord,
    reason: string,
  ): Promise<void> {
    await this.repo.transition({
      importId: job.id,
      shopId: job.shopId,
      from: 'PENDING_UPLOAD',
      to: 'CANCELLED',
      reason,
      now: this.clock.now(),
    });
  }

  private async signParts(
    job: ImportJobRecord,
    handle: string,
    only: Set<number> | undefined,
  ): Promise<{
    count: number;
    parts: Array<{ partNumber: number; url: string }>;
  }> {
    const count = Math.ceil(job.sizeBytes / IMPORT_LIMITS.partBytes);
    const parts: Array<{ partNumber: number; url: string }> = [];
    for (let n = 1; n <= count; n++) {
      if (only && !only.has(n)) continue;
      const length =
        n < count
          ? IMPORT_LIMITS.partBytes
          : job.sizeBytes - (count - 1) * IMPORT_LIMITS.partBytes;
      parts.push({
        partNumber: n,
        url: await this.storage.signPart(job.storageKey, handle, n, length),
      });
    }
    return { count, parts };
  }

  /** `GET …/upload`: which parts storage holds, and fresh URLs for the rest. */
  async uploadState(
    shopId: string,
    importId: string,
  ): Promise<ImportUploadState> {
    const job = await this.repo.findForShop(shopId, importId);
    if (!job) throw this.notFound();
    if (job.status !== 'PENDING_UPLOAD' || !job.uploadHandle)
      throw new ImportProblem('import_not_uploadable');
    const held =
      (await this.storage.listParts(job.storageKey, job.uploadHandle)) ?? [];
    const have = new Map(held.map((p) => [p.partNumber, p]));
    const count = Math.ceil(job.sizeBytes / IMPORT_LIMITS.partBytes);
    const missing = new Set<number>();
    for (let n = 1; n <= count; n++) if (!have.has(n)) missing.add(n);
    const signed = await this.signParts(job, job.uploadHandle, missing);
    return {
      importId: job.id,
      partSize: IMPORT_LIMITS.partBytes,
      partCount: count,
      uploaded: [...have.values()]
        .filter((p) => p.partNumber >= 1 && p.partNumber <= count)
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({
          partNumber: p.partNumber,
          etag: p.etag,
          sizeBytes: p.size,
        })),
      missing: signed.parts,
      uploadExpiresAt: new Date(
        job.createdAt.getTime() + IMPORT_LIMITS.uploadUrlTtlSec * 1000,
      ).toISOString(),
    };
  }

  /** `POST …/complete` (D-10): validate, win the transition, assemble, check the size, enqueue after commit. */
  async complete(
    shopId: string,
    importId: string,
    body: ImportCompleteRequest,
  ): Promise<CompleteResult> {
    const job = await this.repo.findForShop(shopId, importId);
    if (!job) throw this.notFound();
    if (job.status !== 'PENDING_UPLOAD') return this.replay(job);
    await this.validateParts(job, body);

    const won = await this.repo.transition({
      importId,
      shopId,
      from: 'PENDING_UPLOAD',
      to: 'UPLOADED',
      now: this.clock.now(),
    });
    if (!won) {
      const current = await this.repo.findForShop(shopId, importId);
      if (!current) throw this.notFound();
      return this.replay(current);
    }

    try {
      await this.storage.completeUpload(
        job.storageKey,
        job.uploadHandle!,
        body.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );
      const size = await this.storage.headSize(job.storageKey);
      if (size !== job.sizeBytes) {
        await this.failUploaded(won, 'size_mismatch');
        throw new ImportProblem('size_mismatch');
      }
    } catch (error) {
      if (error instanceof ImportProblem) throw error;
      this.logger.error({
        action: 'import.complete_failed',
        importId,
        error: (error as Error).name,
      });
      await this.failUploaded(won, 'internal_error');
      throw importUnavailable();
    }

    // The message follows the commit. A crash or a queue failure here leaves an UPLOADED job with a stamp, which the
    // recovery job re-enqueues after two minutes (AS-40).
    const now = this.clock.now();
    await this.repo.stampEnqueued(importId, now);
    try {
      await this.queue.enqueue(importId);
    } catch (error) {
      this.logger.error({
        action: 'import.enqueue_failed',
        importId,
        error: (error as Error).name,
      });
    }
    const stamped = (await this.repo.findForShop(shopId, importId)) ?? won;
    return {
      job: toImportJob(stamped, await this.repo.history(importId)),
      created: true,
    };
  }

  private async replay(job: ImportJobRecord): Promise<CompleteResult> {
    if (job.status === 'CANCELLED' || job.status === 'EXPIRED')
      throw new ImportProblem('import_not_completable');
    return {
      job: toImportJob(job, await this.repo.history(job.id)),
      created: false,
    };
  }

  /** Every part `1..n` once, in order, with the ETag storage holds; anything else is `invalid_parts` and changes nothing. */
  private async validateParts(
    job: ImportJobRecord,
    body: ImportCompleteRequest,
  ): Promise<void> {
    const invalid = () => new ImportProblem('invalid_parts');
    const count = Math.ceil(job.sizeBytes / IMPORT_LIMITS.partBytes);
    const listed = body.parts;
    if (listed.length !== count) throw invalid();
    if (!job.uploadHandle) throw invalid();
    const held = await this.storage.listParts(job.storageKey, job.uploadHandle);
    if (!held) throw invalid();
    const etags = new Map(held.map((p) => [p.partNumber, unquote(p.etag)]));
    listed.forEach((part, index) => {
      if (part.partNumber !== index + 1) throw invalid();
      if (part.etag === '' || etags.get(part.partNumber) !== unquote(part.etag))
        throw invalid();
    });
  }

  /** `UPLOADED -> FAILED` for a file that cannot be used; the object and the upload are cleaned after the commit. */
  private async failUploaded(
    job: ImportJobRecord,
    code: 'size_mismatch' | 'internal_error',
  ): Promise<void> {
    const failed = await this.repo.transition({
      importId: job.id,
      shopId: job.shopId,
      from: 'UPLOADED',
      to: 'FAILED',
      failure: { code },
      clearUploadHandle: true,
      now: this.clock.now(),
    });
    if (failed) {
      importMetrics.finished.add(1, { status: 'FAILED' });
      this.live.publish(job.id, { type: 'failed', code });
    }
    await this.storage.deleteObject(job.storageKey).catch(() => undefined);
    if (job.uploadHandle)
      await this.storage
        .abortUpload(job.storageKey, job.uploadHandle)
        .catch(() => undefined);
  }

  /**
   * `POST …/cancel`: `PENDING_UPLOAD` and `UPLOADED` become `CANCELLED` at once (the upload is aborted, the file
   * deleted, a queued message becomes a no-op); a running import is marked and stops at its next safe point; a repeat on
   * `CANCELLED` answers `200`; a finished import is `409`.
   */
  async cancel(
    shopId: string,
    importId: string,
    userId: string,
  ): Promise<ImportJob> {
    const job = await this.repo.findForShop(shopId, importId);
    if (!job) throw this.notFound();
    if (job.status === 'CANCELLED') return this.view(job);
    if (isFinalImportStatus(job.status))
      throw new ImportProblem('import_not_cancellable');

    if (job.status === 'SCANNING' || job.status === 'PROCESSING') {
      const marked = await this.repo.requestCancel(
        shopId,
        importId,
        this.clock.now(),
      );
      if (marked) return this.view(marked);
      // finished between the read and the mark
      const current = await this.repo.findForShop(shopId, importId);
      if (current?.status === 'CANCELLED') return this.view(current);
      throw new ImportProblem('import_not_cancellable');
    }

    const cancelled = await this.repo.transition({
      importId,
      shopId,
      from: job.status,
      to: 'CANCELLED',
      reason: 'cancelled_by_user',
      clearUploadHandle: true,
      now: this.clock.now(),
    });
    if (!cancelled) {
      // lost a race with complete (or another cancel): answer from the state that won
      const current = await this.repo.findForShop(shopId, importId);
      if (current?.status === 'CANCELLED') return this.view(current);
      throw new ImportProblem('import_not_cancellable');
    }
    this.logger.log({ action: 'import.cancelled', importId, shopId, userId });
    importMetrics.finished.add(1, { status: 'CANCELLED' });
    this.live.publish(importId, { type: 'cancelled' });
    await this.discard(job);
    return this.view(cancelled);
  }

  /** Aborts the open upload and deletes the stored file; both tolerate "already gone" (L-016). */
  async discard(job: ImportJobRecord): Promise<void> {
    if (job.uploadHandle)
      await this.storage
        .abortUpload(job.storageKey, job.uploadHandle)
        .catch((error: unknown) =>
          this.logger.warn({
            action: 'import.abort_failed',
            importId: job.id,
            error: (error as Error).name,
          }),
        );
    await this.storage.deleteObject(job.storageKey).catch((error: unknown) =>
      this.logger.warn({
        action: 'import.delete_failed',
        importId: job.id,
        error: (error as Error).name,
      }),
    );
  }

  private async view(job: ImportJobRecord): Promise<ImportJob> {
    return toImportJob(job, await this.repo.history(job.id));
  }
}
