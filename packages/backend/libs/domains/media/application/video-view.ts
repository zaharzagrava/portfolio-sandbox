import type { VideoOwner, VideoPlayback } from '@marketplace-sandbox/contracts';
import { deliveryPrefix, deliveryUrl } from '../domain/delivery-paths';
import { MAX_VIDEO_RETRIES } from '../domain/task-limits';
import { isRetryable } from '../domain/video-errors';
import type { ProgressRecord, VideoRecord } from '../domain/video-ports';

/**
 * Explicit mappers from a row to what a caller may see (S30 R-14, FR-003, FR-044). A whitelist: nothing here reads
 * `sourceKey`, `uploadId`, `internalError` or the encoder's text, so no response can carry them (AS-36, AS-42).
 */

const urlOf = (video: VideoRecord, origin: string, relative: string | null) =>
  relative
    ? deliveryUrl(
        origin,
        `${deliveryPrefix(video.visibility, video.id)}${relative}`,
      )
    : null;

const renditionsOf = (video: VideoRecord) =>
  (video.outputs?.renditions ?? []).map((r) => ({
    name: r.name,
    width: r.width,
    height: r.height,
  }));

/** Whether the seller's retry would be accepted for this row (status and code; the limit is checked by the store). */
export const isRetryableVideo = (video: VideoRecord): boolean =>
  video.status === 'FAILED' &&
  isRetryable(video.failureCode) &&
  video.objectsPurgedAt === null &&
  video.retryCount < MAX_VIDEO_RETRIES;

export function toOwnerView(
  video: VideoRecord,
  progress: ProgressRecord,
  origin: string,
): VideoOwner {
  return {
    id: video.id,
    title: video.title,
    visibility: video.visibility,
    status: video.status,
    failureCode: video.failureCode,
    retryable: isRetryableVideo(video),
    productId: video.productId,
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    renditions: renditionsOf(video),
    progress:
      video.status === 'READY'
        ? {
            stage: 'finished',
            tasksDone: progress.tasksTotal,
            tasksTotal: progress.tasksTotal,
          }
        : progress,
    posterUrl: urlOf(video, origin, video.outputs?.poster ?? null),
    spriteUrl: urlOf(video, origin, video.outputs?.sprite ?? null),
    shareToken: video.visibility === 'unlisted' ? video.shareToken : null,
    version: video.version,
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
  };
}

/** Playback answer for a `READY` video; the caller has already decided the video may be seen. */
export function toPlayback(
  video: VideoRecord,
  origin: string,
  expiresAt: Date | null,
): VideoPlayback {
  const outputs = video.outputs!;
  return {
    videoId: video.id,
    title: video.title,
    masterUrl: urlOf(video, origin, outputs.master)!,
    posterUrl: urlOf(video, origin, outputs.poster),
    spriteUrl: urlOf(video, origin, outputs.sprite),
    durationSec: video.durationSec ?? 0,
    width: video.width ?? 1,
    height: video.height ?? 1,
    renditions: renditionsOf(video),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}
