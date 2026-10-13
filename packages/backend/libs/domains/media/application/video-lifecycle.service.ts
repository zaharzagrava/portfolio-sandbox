import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { VideoMetrics, VideoStore } from '../domain/video-ports';

/** At most this many videos per run of a job (S30 R-17): a bounded batch, the next run takes the rest. */
export const JOB_BATCH = 200;

const SYSTEM = { type: 'system' } as const;

/**
 * `media.video-expire-uploads` (S30 A7, AS-49): an upload nobody finished within its 24 hours becomes `EXPIRED` and its
 * multipart upload is aborted. The row moves first, in its own transaction; the storage call follows outside any
 * transaction and a failure of it is only logged (the purge aborts it again). A second or concurrent run finds nothing
 * left in `UPLOADING` to change.
 */
@Injectable()
export class VideoLifecycleService {
  private readonly logger = new Logger(VideoLifecycleService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly storage: ObjectStorage,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async expireUploads(): Promise<number> {
    const now = this.clock.now();
    const due = await this.store.video.listExpiredUploads(now, JOB_BATCH);
    let expired = 0;
    for (const video of due) {
      const moved = await this.store.tx(({ video: repo }) =>
        repo.expire(video.id, SYSTEM, now, now),
      );
      if (!moved) continue; // another run got there first
      expired++;
      this.metrics.inc('video_status_transitions_total', {
        from: 'UPLOADING',
        to: 'EXPIRED',
      });
      if (video.uploadId)
        await this.storage
          .abortMultipartUpload(video.sourceKey, video.uploadId, {
            timeoutMs: 10_000,
          })
          .catch((e: Error) =>
            this.logger.warn(
              `could not abort a multipart upload (the purge will): ${e.message}`,
              undefined,
              { videoId: video.id },
            ),
          );
    }
    return expired;
  }
}
