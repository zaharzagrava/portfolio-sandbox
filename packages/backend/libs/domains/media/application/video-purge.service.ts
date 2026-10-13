import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { DeliveryEdge } from '@app/infrastructure/delivery-edge';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { PUBLIC_PREFIX, videoKeyPrefixes } from '../domain/delivery-paths';
import { VideoStore, type VideoRecord } from '../domain/video-ports';
import { JOB_BATCH } from './video-lifecycle.service';

/** A `FAILED` video keeps its source this long so the seller can retry it (S30 AS-52). */
const FAILED_RETENTION_MS = 7 * 24 * 3600 * 1000;
const STORAGE_TIMEOUT_MS = 20_000;
/** Objects removed per storage call; a prefix is emptied by looping until it reports none left. */
const DELETE_PAGE = 1000;

/**
 * `media.video-purge` (S30 D5, AS-52): removes the objects of `DELETED`, `EXPIRED` and week-old `FAILED` videos (never a
 * `READY` video's), asks the edge cache to forget a deleted public video's path, and records both. A missing object is
 * not an error. A failing storage or edge call for one video is logged and leaves that video for the next run, it never
 * stops the others (L-016). Idempotent and bounded (200 videos per run).
 */
@Injectable()
export class VideoPurgeService {
  private readonly logger = new Logger(VideoPurgeService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly storage: ObjectStorage,
    private readonly edge: DeliveryEdge,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async purge(): Promise<{ purged: number; edge: number }> {
    const now = this.clock.now();
    const due = await this.store.video.listPurgeable({
      failedBefore: new Date(now.getTime() - FAILED_RETENTION_MS),
      limit: JOB_BATCH,
    });
    let purged = 0;
    let edge = 0;
    for (const video of due) {
      if (!video.objectsPurgedAt) {
        try {
          await this.removeObjects(video);
          await this.store.video.markObjectsPurged(video.id, this.clock.now());
          purged++;
        } catch (error) {
          this.logger.warn(
            `could not remove the objects of a video; the next run will: ${(error as Error).message}`,
            undefined,
            { videoId: video.id },
          );
          continue;
        }
      }
      if (
        video.status === 'DELETED' &&
        video.visibility === 'public' &&
        !video.edgePurgedAt
      ) {
        try {
          await this.edge.invalidate([`/${PUBLIC_PREFIX}${video.id}/*`]);
          await this.store.video.markEdgePurged(video.id, this.clock.now());
          edge++;
        } catch (error) {
          // The objects are gone either way; the request is repeated on the next run.
          this.logger.warn(
            `edge cache removal failed; the next run repeats it: ${(error as Error).message}`,
            undefined,
            { videoId: video.id },
          );
        }
      }
    }
    return { purged, edge };
  }

  private async removeObjects(video: VideoRecord): Promise<void> {
    // An upload that never completed still holds parts in storage: abort it (a missing upload is fine).
    if (video.uploadId && video.status !== 'FAILED')
      await this.storage
        .abortMultipartUpload(video.sourceKey, video.uploadId, {
          timeoutMs: STORAGE_TIMEOUT_MS,
        })
        .catch((error: { name?: string }) => {
          if (error?.name !== 'NoSuchUpload') throw error;
        });
    for (const prefix of videoKeyPrefixes(video.id))
      while (
        (await this.storage.deletePrefix(prefix, {
          limit: DELETE_PAGE,
          timeoutMs: STORAGE_TIMEOUT_MS,
        })) === DELETE_PAGE
      );
    // A video from before the new layout keeps its source where it was written.
    await this.storage.delete(video.sourceKey);
  }
}
