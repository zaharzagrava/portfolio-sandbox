import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ragDocuments } from '../domain/knowledge-metrics';
import {
  DOCUMENT_REPOSITORY,
  OBJECT_STORE,
  TASK_PUBLISHER,
} from '../domain/ports';
import type {
  ByteRemoval,
  DocumentRepository,
  ObjectStore,
  TaskPublisher,
} from '../domain/ports';

const BATCH = 500;
const ABANDONED_UPLOAD_MS = 24 * 3_600_000;
const STALE_QUEUED_MS = 5 * 60_000;
const TOMBSTONE_DAYS = 30;

export interface SweepReport {
  abandonedUploads: number;
  requeued: number;
  leasesReleased: number;
  bytesRemoved: number;
  tombstonesPurged: number;
}

/**
 * The repair pass of `knowledge.sweep` (S47 FR-011, AS-42, research R-7): each step is a bounded conditional statement,
 * so a second or concurrent run changes nothing. Ages use the database clock (one source across instances).
 *  (a) uploads abandoned for 24 h → DELETED; (b) QUEUED for 5 min with no live task → touched and enqueued again;
 *  (c) expired processing leases → QUEUED and enqueued; (d) stored bytes of deleted documents removed (retried until
 *  they are); (e) tombstones older than 30 days purged.
 */
@Injectable()
export class SweepService {
  private readonly logger = new Logger(SweepService.name);

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(TASK_PUBLISHER) private readonly tasks: TaskPublisher,
    private readonly config: ApiConfigService,
  ) {}

  async run(): Promise<SweepReport> {
    const abandoned = await this.documents.expireAbandonedUploads(
      ABANDONED_UPLOAD_MS,
      BATCH,
    );
    const stale = await this.documents.requeueStale(STALE_QUEUED_MS, BATCH);
    const released = await this.documents.releaseExpiredLeases(BATCH);
    for (const id of [...stale, ...released])
      await this.tasks.enqueueIngest(id);

    const pending = await this.documents.pendingByteRemovals(BATCH);
    const bytesRemoved = await this.removeBytes(pending);
    const tombstonesPurged = await this.documents.purgeTombstones(
      TOMBSTONE_DAYS,
      BATCH,
    );

    const counts = await this.documents.countByStatus();
    for (const status of [
      'AWAITING_UPLOAD',
      'QUEUED',
      'PROCESSING',
      'READY',
      'FAILED',
      'DELETED',
    ])
      ragDocuments.set(counts[status] ?? 0, { status });

    return {
      abandonedUploads: abandoned.length,
      requeued: stale.length,
      leasesReleased: released.length,
      bytesRemoved,
      tombstonesPurged,
    };
  }

  /** Removes the object, then marks the row; a failure leaves the row pending for the next run. Never logs the key. */
  private async removeBytes(rows: ByteRemoval[]): Promise<number> {
    let removed = 0;
    for (const row of rows) {
      try {
        await this.store.delete(row.storageKey);
        await this.documents.markBytesRemoved(row.id);
        removed++;
      } catch (error) {
        this.logger.warn(
          `stored bytes of ${row.id} not removed: ${(error as Error).name}`,
        );
      }
    }
    return removed;
  }
}
