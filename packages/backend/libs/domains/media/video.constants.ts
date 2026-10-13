/** The standard (non-FIFO) queue the transcoding workers consume; never given a `groupId` or `dedupeId` (L-001). */
export const VIDEO_QUEUE = 'video-transcode';

/** Injection token: the configured delivery host (`video_cdn_url`), the only host a client sees a video URL on. */
export const VIDEO_ORIGIN = Symbol('VIDEO_ORIGIN');

/** Injection token: the parent domain of the signed cookies (`video_cookie_domain`), or null when unset. */
export const VIDEO_COOKIE_DOMAIN = Symbol('VIDEO_COOKIE_DOMAIN');

/**
 * Injection token: `{ value }`, the length of every part but the last (64 MiB). A seam, not a setting: a test sets the
 * store's 5 MiB minimum so a multi-part upload can really be put to the object store.
 */
export const VIDEO_PART_SIZE = Symbol('VIDEO_PART_SIZE');

/**
 * Injection token: `{ timeoutMs(task, durationSec) }`, the time limit of a task (`max(600 s, 3 x duration)` for a
 * rendition, fixed for the rest). A seam, like `VIDEO_PART_SIZE`: a test shortens it so a hung encoder is killed in
 * seconds instead of minutes.
 */
export const VIDEO_TASK_LIMITS = Symbol('VIDEO_TASK_LIMITS');
export interface TaskLimits {
  timeoutMs(task: string, durationSec: number): number;
}

/** Body of a `video-transcode` message. */
export interface VideoTaskMessage {
  videoId: string;
  task: string;
}
