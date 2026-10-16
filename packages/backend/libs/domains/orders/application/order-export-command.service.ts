import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  OrderExport,
  OrderExportDownload,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import {
  ExportAlreadyActiveError,
  ExportExpiredError,
  ExportNotCancellableError,
  ExportNotFoundError,
  ExportNotReadyError,
} from '../domain/export-errors';
import {
  EXPORT_FILES,
  EXPORT_JOBS,
  EXPORT_LIVE,
  EXPORT_QUEUE,
  type ExportFilesPort,
  type ExportJobsPort,
  type ExportLivePort,
  type ExportQueuePort,
} from '../domain/export-ports';
import { EXPORT_CONFIG, type ExportConfig } from '../domain/export-config';
import {
  exportDownloadsCounter,
  exportFinishedCounter,
} from '../domain/export-metrics';
import { toOrderExport } from './order-export.view';

/** Start, cancel and download of an export (S12 FR-001 to FR-010). */
@Injectable()
export class OrderExportCommandService {
  private readonly logger = new Logger(OrderExportCommandService.name);

  constructor(
    @Inject(EXPORT_JOBS) private readonly jobs: ExportJobsPort,
    @Inject(EXPORT_QUEUE) private readonly queue: ExportQueuePort,
    @Inject(EXPORT_LIVE) private readonly live: ExportLivePort,
    @Inject(EXPORT_FILES) private readonly files: ExportFilesPort,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly context?: RequestContext,
  ) {}

  /**
   * Creates the job (one `QUEUED|RUNNING` export per shop is enforced by the store) and, after the commit, its queue
   * message. A message lost between the two is re-sent by the recovery job after the unclaimed window.
   */
  async start(shopId: string, userId: string): Promise<OrderExport> {
    const created = await this.jobs.createWithActiveGuard({
      shopId,
      createdBy: userId,
      now: this.clock.now(),
    });
    if (created.kind === 'active')
      throw new ExportAlreadyActiveError(created.activeExportId);
    try {
      await this.queue.enqueue(created.job.id);
    } catch (error) {
      this.logger.error(
        `order_export_enqueue_failed exportId=${created.job.id}: ${(error as Error).name}`,
      );
    }
    return toOrderExport(created.job);
  }

  /** `QUEUED|RUNNING` becomes `CANCELLED`; cancelling a cancelled export is a no-op; a finished one is refused. */
  async cancel(
    shopId: string,
    exportId: string,
    userId: string,
  ): Promise<OrderExport> {
    const job = await this.jobs.findByShop(shopId, exportId);
    if (!job) throw new ExportNotFoundError();
    if (job.status === 'CANCELLED') return toOrderExport(job);
    if (job.status !== 'QUEUED' && job.status !== 'RUNNING')
      throw new ExportNotCancellableError();
    const cancelled = await this.jobs.cancel({
      shopId,
      exportId,
      actor: userId,
      reason: 'cancelled_by_user',
      now: this.clock.now(),
    });
    if (cancelled) {
      exportFinishedCounter.add(1, { status: 'CANCELLED' });
      this.live.publish(exportId, { type: 'cancelled' });
      return toOrderExport(cancelled);
    }
    // Lost a race with completion, failure or another cancel: answer from the state that won.
    const current = await this.jobs.findByShop(shopId, exportId);
    if (!current) throw new ExportNotFoundError();
    if (current.status === 'CANCELLED') return toOrderExport(current);
    throw new ExportNotCancellableError();
  }

  /** A ten-minute link for a `DONE` export; the audit line carries who fetched it and never the link. */
  async download(
    shopId: string,
    exportId: string,
    userId: string,
  ): Promise<OrderExportDownload> {
    const job = await this.jobs.findByShop(shopId, exportId);
    if (!job) throw new ExportNotFoundError();
    if (job.status === 'EXPIRED') throw new ExportExpiredError();
    if (job.status !== 'DONE' || !job.fileKey) throw new ExportNotReadyError();
    const now = this.clock.now();
    if (job.expiresAt && job.expiresAt.getTime() <= now.getTime())
      throw new ExportExpiredError();
    const url = await this.files.presign({
      key: job.fileKey,
      fileName: `orders-${job.id}.csv`,
      ttlSec: this.config.linkTtlSec,
    });
    exportDownloadsCounter.add();
    this.logger.log({
      event: 'order_export_downloaded',
      requestId: this.context?.requestId,
      exportId: job.id,
      shopId,
      userId,
    });
    return {
      url,
      expiresAt: new Date(
        now.getTime() + this.config.linkTtlSec * 1000,
      ).toISOString(),
    };
  }
}
