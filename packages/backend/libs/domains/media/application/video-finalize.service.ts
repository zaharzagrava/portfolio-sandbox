import { Inject, Injectable, Logger } from '@nestjs/common';
import type { VideoCompleteResponse } from '@marketplace-sandbox/contracts';
import { AppError } from '@app/common/errors/error.types';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  ObjectStorage,
  type StoredPart,
} from '@app/infrastructure/storage/object-storage.port';
import { storageUnavailable, uploadExpired } from '../domain/video-errors';
import { STORAGE_ASSEMBLE_TIMEOUT_MS } from '../domain/video-limits';
import {
  VideoMetrics,
  VideoStore,
  type VideoRecord,
} from '../domain/video-ports';
import { VIDEO_QUEUE } from '../video.constants';
import { messageAttributes } from './video-messages';

const SYSTEM = { type: 'system' } as const;

/** Written on an `UPLOADED` row when assembly failed, so the next `complete` drives at once instead of waiting. */
export const ASSEMBLY_FAILED = 'assembly_failed';

/** What a finished or running video tells the seller who asks to complete it again; `null` for the states that continue. */
export function completeAnswer(
  video: VideoRecord,
): VideoCompleteResponse | null {
  switch (video.status) {
    case 'PROCESSING':
      return { status: 'PROCESSING' };
    case 'READY':
      return { status: 'READY' };
    case 'FAILED':
      return {
        status: 'FAILED',
        ...(video.failureCode && { failureCode: video.failureCode }),
      };
    case 'EXPIRED':
      throw uploadExpired();
    default:
      return null; // UPLOADING and UPLOADED continue
  }
}

/**
 * The second half of `complete` (S30 R-5), shared by the API and the sweep: assemble the source once (if it is not
 * assembled), check its size, move `UPLOADED → PROCESSING` with the `probe` task, and only then send the first message.
 * Idempotent: it heads the source first, so driving it again after a half failure never fails on a multipart upload that
 * is already complete (L-016). No storage or queue call runs inside a transaction.
 */
@Injectable()
export class VideoFinalizeService {
  private readonly logger = new Logger(VideoFinalizeService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async finalize(
    video: VideoRecord,
    stored: StoredPart[] | null,
    uploaderId: string | null,
    trace: Record<string, string> = {},
  ): Promise<VideoCompleteResponse> {
    const id = video.id;
    try {
      let head = await this.storage.head(video.sourceKey, {
        timeoutMs: STORAGE_ASSEMBLE_TIMEOUT_MS,
      });
      if (!head) {
        const parts =
          stored ??
          (await this.storage.listParts(video.sourceKey, video.uploadId ?? '', {
            timeoutMs: STORAGE_ASSEMBLE_TIMEOUT_MS,
          }));
        if (parts)
          await this.storage.completeMultipartUpload(
            video.sourceKey,
            video.uploadId!,
            parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
            { timeoutMs: STORAGE_ASSEMBLE_TIMEOUT_MS },
          );
        head = await this.storage.head(video.sourceKey, {
          timeoutMs: STORAGE_ASSEMBLE_TIMEOUT_MS,
        });
      }
      if (!head) throw new Error('the source is missing after assembly');
      if (head.size !== video.sizeBytes) return await this.sizeMismatch(video);
    } catch (error) {
      // our own domain errors pass through; a raw network error (it has a `code` too, e.g. ECONNRESET) is a storage fault
      if (error instanceof AppError) throw error;
      this.logger.warn(
        `could not assemble the upload: ${(error as Error).message}`,
        undefined,
        { videoId: id },
      );
      await this.store.video
        .setInternalError(id, ASSEMBLY_FAILED)
        .catch(() => undefined);
      throw storageUnavailable();
    }

    const actor = uploaderId
      ? ({ type: 'user', id: uploaderId } as const)
      : SYSTEM;
    const started = await this.store.tx(({ video: repo }) =>
      repo.startProcessing(id, actor, this.clock.now()),
    );
    if (started) {
      this.metrics.inc('video_status_transitions_total', {
        from: 'UPLOADED',
        to: 'PROCESSING',
      });
      await this.sendProbe(id, trace);
    }
    const current = await this.store.video.find(id);
    return (current && completeAnswer(current)) ?? { status: 'PROCESSING' };
  }

  private async sizeMismatch(
    video: VideoRecord,
  ): Promise<VideoCompleteResponse> {
    const failed = await this.store.tx(({ video: repo }) =>
      repo.fail({
        id: video.id,
        from: ['UPLOADED'],
        code: 'source_size_mismatch',
        internalError:
          'the assembled source size differs from the declared size',
        actor: SYSTEM,
        now: this.clock.now(),
      }),
    );
    if (failed) {
      this.metrics.inc('video_status_transitions_total', {
        from: 'UPLOADED',
        to: 'FAILED',
      });
      await this.storage
        .delete(video.sourceKey)
        .catch((e: Error) =>
          this.logger.warn(
            `could not delete a mismatched source: ${e.message}`,
          ),
        );
    }
    return { status: 'FAILED', failureCode: 'source_size_mismatch' };
  }

  /** After commit: a lost message is recovered by `media.video-requeue-stuck`, so a failure here is only logged. */
  private async sendProbe(
    videoId: string,
    trace: Record<string, string>,
  ): Promise<void> {
    try {
      await this.queue.enqueue(
        VIDEO_QUEUE,
        { videoId, task: 'probe' },
        { attributes: messageAttributes(this.clock, trace) },
      );
    } catch (error) {
      this.logger.error(
        `could not enqueue the probe task; the sweep will: ${(error as Error).message}`,
        undefined,
        { videoId },
      );
    }
  }
}
