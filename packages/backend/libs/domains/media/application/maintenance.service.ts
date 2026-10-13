import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  expiryCutoff,
  purgeCutoff,
  stuckCutoffs,
  unreferencedKeys,
  variantKeysOf,
} from '../domain/lifecycle-rules';
import { MediaStore } from '../domain/ports';
import { MEDIA_QUEUE } from '../media.constants';

export const EXPIRE_BATCH = 200;
export const REQUEUE_BATCH = 100;
export const PURGE_BATCH = 200;

/**
 * The three single-run jobs (S29 FR-062–FR-064; S49 gives the single-run lease). Each is bounded, idempotent and does
 * its storage and queue calls outside any database transaction: a failed call leaves the row for the next run.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly store: MediaStore,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `PENDING_UPLOAD` older than 60 minutes → `EXPIRED`; the object, if the browser ever sent one, is deleted. */
  async expirePendingUploads(): Promise<number> {
    const now = this.clock.now();
    const expired = await this.store.tx(({ media }) =>
      media.expirePending(expiryCutoff(now), now, EXPIRE_BATCH),
    );
    for (const media of expired)
      await this.storage
        .delete(media.originalKey)
        .catch((error: Error) =>
          this.logger.warn(
            `could not delete an expired original: ${error.message}`,
          ),
        );
    return expired.length;
  }

  /** Lost messages and dead workers: one new queue message per stuck photo, at most 100 per run, no FIFO options. */
  async requeueStuck(): Promise<number> {
    const now = this.clock.now();
    const stuck = await this.store.media.findStuck({
      ...stuckCutoffs(now),
      limit: REQUEUE_BATCH,
    });
    if (stuck.length === 0) return 0;
    const result = await this.queue.enqueueBatch(
      MEDIA_QUEUE,
      stuck.map((media) => ({
        body: { mediaId: media.id, originalKey: media.originalKey },
      })),
    );
    const failed = new Set(result.failed.map((f) => f.index));
    await this.store.media.touch(
      stuck.filter((_, index) => !failed.has(index)).map((m) => m.id),
      now,
    );
    return result.sent;
  }

  /** Terminal rows older than 7 days: originals, variants no live photo uses, then the rows and their history. */
  async purge(): Promise<number> {
    const now = this.clock.now();
    const batch = await this.store.media.findPurgeable(
      purgeCutoff(now),
      PURGE_BATCH,
    );
    if (batch.length === 0) return 0;
    const live = await this.store.media.liveVariantKeys(
      [...new Set(batch.flatMap((m) => variantKeysOf(m.variants)))],
      batch.map((m) => m.id),
    );
    let purged = 0;
    for (const media of batch) {
      try {
        await this.storage.delete(media.originalKey);
        for (const key of unreferencedKeys(media.variants, live))
          await this.storage.delete(key);
        const removed = await this.store.tx(({ media: repo }) =>
          repo.purge(media.id),
        );
        if (removed) purged += 1;
      } catch (error) {
        // The row stays; the next run tries again, and the other photos of this run are not held back.
        this.logger.warn(
          `purge of one photo failed and will be retried: ${(error as Error).message}`,
        );
      }
    }
    return purged;
  }
}
