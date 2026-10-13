import type { VideoFailureCode } from '@marketplace-sandbox/contracts';
import type { TaskStatus } from './dag';
import type { Rendition } from './hls';
import type { ProbeResult } from './probe-rules';
import type {
  StatusActorType,
  VideoContentType,
  VideoStatus,
  VideoVisibility,
} from './video-status';

/**
 * Ports of the video half of `media` (constitution I). Nothing here imports Nest, Sequelize or an SDK. The application
 * layer talks to these; `infra/` implements them (`pg-video-repository.ts`, `pg-video-task-repository.ts`,
 * `ffmpeg-transcoder.ts`).
 */

/** What `publish` stores in `Video.outputs`: keys are relative to the video's delivery prefix. */
export interface VideoOutputs {
  master: string;
  poster: string;
  sprite: string | null;
  renditions: {
    name: string;
    width: number;
    height: number;
    bandwidth: number;
    averageBandwidth: number;
    frameRate: number;
    codecs: string;
  }[];
}

export interface VideoRecord {
  id: string;
  shopId: string;
  uploaderId: string;
  title: string;
  visibility: VideoVisibility;
  status: VideoStatus;
  failureCode: VideoFailureCode | null;
  internalError: string | null;
  retryCount: number;
  sourceKey: string;
  uploadId: string | null;
  sizeBytes: number;
  contentType: VideoContentType;
  partSize: number;
  sessionExpiresAt: Date;
  shareToken: string | null;
  productId: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  outputs: VideoOutputs | null;
  objectsPurgedAt: Date | null;
  edgePurgedAt: Date | null;
  readyAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type VideoActor =
  { type: 'user'; id: string } | { type: 'system' } | { type: 'worker' };
export type { StatusActorType };

export interface TaskRecord {
  videoId: string;
  name: string;
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  claimedAttempt: number | null;
  leaseExpiresAt: Date | null;
  lastSentAt: Date | null;
  output: Record<string, unknown> | null;
  internalError: string | null;
  updatedAt: Date;
}

export type ClaimOutcome =
  | { outcome: 'claimed'; task: TaskRecord; video: VideoRecord }
  | { outcome: 'busy' }
  | { outcome: 'stale' }
  | { outcome: 'exhausted'; task: TaskRecord };

export type InsertUploadingResult =
  { ok: true; video: VideoRecord } | { ok: false; current: number };

export type RetryResult =
  | { ok: true; video: VideoRecord; ready: string[] }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_state'
        | 'not_retryable'
        | 'retry_limit'
        | 'source_purged';
      status?: VideoStatus;
    };

export type PatchResult =
  | { ok: true; video: VideoRecord }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'version_conflict'
        | 'product_video_limit'
        | 'upload_expired';
      currentVersion?: number;
    };

export interface ProgressRecord {
  stage: string;
  tasksDone: number;
  tasksTotal: number;
}

export interface ListFilter {
  shopId: string;
  limit: number;
  status: VideoStatus | null;
  after: { createdAt: Date; id: string } | null;
}

export interface VideoRepository {
  // ---- upload
  /** Per-shop advisory lock, quota check (10 `UPLOADING`), row and first history row, one transaction. */
  insertUploading(input: {
    id: string;
    shopId: string;
    uploaderId: string;
    title: string;
    visibility: VideoVisibility;
    contentType: VideoContentType;
    sizeBytes: number;
    productId: string | null;
    shareToken: string | null;
    sourceKey: string;
    partSize: number;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<InsertUploadingResult>;
  /** Conditional on `UPLOADING`. */
  setUploadId(id: string, uploadId: string): Promise<boolean>;
  /** `UPLOADING → UPLOADED`; null when it is not `UPLOADING` any more. */
  claimUploaded(
    id: string,
    actor: VideoActor,
    now: Date,
  ): Promise<VideoRecord | null>;
  /** `UPLOADING → EXPIRED` with its history row; `olderThan` limits it to sessions that ended before that instant. */
  expire(
    id: string,
    actor: VideoActor,
    now: Date,
    olderThan?: Date,
  ): Promise<VideoRecord | null>;
  /** `UPLOADED → PROCESSING`, the `probe` task `QUEUED`, history; null when it is not `UPLOADED`. */
  startProcessing(
    id: string,
    actor: VideoActor,
    now: Date,
  ): Promise<VideoRecord | null>;
  /** → `FAILED` from `UPLOADED` or `PROCESSING`: open tasks `CANCELLED`, history, `video.failed`. */
  fail(input: {
    id: string;
    from: VideoStatus[];
    code: VideoFailureCode;
    internalError: string | null;
    actor: VideoActor;
    now: Date;
  }): Promise<VideoRecord | null>;
  // ---- pipeline
  /**
   * `SELECT … FOR UPDATE` on the video row. Every transaction that touches a video and its tasks takes this lock FIRST
   * (then the task rows), so a delete (video, then tasks) and a completion (tasks, then video) cannot deadlock.
   */
  lock(id: string): Promise<VideoStatus | null>;
  /** Marks (or clears with null) the internal note of a row; not a visible change, no version bump. */
  setInternalError(id: string, note: string | null): Promise<void>;
  setProbe(
    id: string,
    probe: { durationSec: number; width: number; height: number },
  ): Promise<void>;
  /** Guarded `PROCESSING → READY` with every required task done; null when a delete (or anything else) won. */
  publish(input: {
    id: string;
    outputs: VideoOutputs;
    now: Date;
  }): Promise<VideoRecord | null>;
  // ---- reads
  find(id: string): Promise<VideoRecord | null>;
  findInShop(id: string, shopId: string): Promise<VideoRecord | null>;
  /** A `READY` video with whether its shop is suspended (own `VideoShopState` copy), for playback. */
  findPlayable(
    id: string,
  ): Promise<{ video: VideoRecord; suspended: boolean } | null>;
  list(filter: ListFilter): Promise<VideoRecord[]>;
  /** `READY` public videos of a product, newest first. */
  listPublicByProduct(productId: string, limit: number): Promise<VideoRecord[]>;
  shopSuspended(shopId: string): Promise<boolean>;
  // ---- management
  patch(input: {
    id: string;
    shopId: string;
    expectedVersion: number;
    title?: string;
    productId?: string | null;
    now: Date;
  }): Promise<PatchResult>;
  retry(input: {
    id: string;
    shopId: string;
    actor: VideoActor;
    now: Date;
  }): Promise<RetryResult>;
  /** Any status but `DELETED` → `DELETED`: history, open tasks `CANCELLED`, `video.deleted`. `shopId` null = any shop. */
  softDelete(input: {
    id: string;
    shopId: string | null;
    actor: VideoActor;
    now: Date;
  }): Promise<{ video: VideoRecord; previous: VideoStatus } | null>;
  // ---- consumers
  clearProduct(productId: string, shopId: string, now: Date): Promise<number>;
  /** Soft-deletes up to `limit` live videos of a shop (one `video.deleted` each); returns how many. */
  deleteShopBatch(shopId: string, limit: number, now: Date): Promise<number>;
  upsertShopState(input: {
    shopId: string;
    suspended: boolean;
    shopVersion: number;
    now: Date;
  }): Promise<void>;
  // ---- jobs
  listExpiredUploads(now: Date, limit: number): Promise<VideoRecord[]>;
  listStuckUploaded(before: Date, limit: number): Promise<VideoRecord[]>;
  listProcessingSince(before: Date, limit: number): Promise<VideoRecord[]>;
  /** `DELETED`/`EXPIRED`/week-old `FAILED` videos whose objects are not removed yet, and deleted public videos whose edge removal is still owed. */
  listPurgeable(input: {
    failedBefore: Date;
    limit: number;
  }): Promise<VideoRecord[]>;
  markObjectsPurged(id: string, now: Date): Promise<void>;
  markEdgePurged(id: string, now: Date): Promise<void>;
}

export interface TaskRepository {
  list(videoId: string): Promise<TaskRecord[]>;
  progress(videoId: string): Promise<ProgressRecord>;
  /** `progress` for many videos in one statement (the seller list). */
  progressMany(videoIds: string[]): Promise<Map<string, ProgressRecord>>;
  /** Stores the rest of the graph `PENDING` after `probe` (idempotent). */
  insertGraph(
    videoId: string,
    nodes: { name: string; deps: string[] }[],
    now: Date,
  ): Promise<void>;
  /** Under the video row lock: `PENDING` tasks whose dependencies finished → `QUEUED`; returns their names. */
  dispatchReady(videoId: string, now: Date): Promise<string[]>;
  claim(input: {
    videoId: string;
    name: string;
    now: Date;
    leaseUntil: Date;
    maxAttempts: number;
  }): Promise<ClaimOutcome>;
  heartbeat(input: {
    videoId: string;
    name: string;
    attempt: number;
    now: Date;
    leaseUntil: Date;
  }): Promise<boolean>;
  /** Fenced: `RUNNING` and `claimedAttempt = attempt` → `DONE`; false = this attempt lost. */
  complete(input: {
    videoId: string;
    name: string;
    attempt: number;
    output: Record<string, unknown>;
    now: Date;
  }): Promise<boolean>;
  /** `RUNNING → QUEUED` after a transient failure (message follows with a delay). */
  requeue(input: {
    videoId: string;
    name: string;
    attempt: number;
    internalError: string;
    now: Date;
    keepAttempt?: boolean;
  }): Promise<boolean>;
  /** Optional task out of attempts → `SKIPPED`. */
  skip(input: {
    videoId: string;
    name: string;
    attempt: number;
    internalError: string;
    now: Date;
  }): Promise<boolean>;
  /** `RUNNING → FAILED`. */
  failTask(input: {
    videoId: string;
    name: string;
    attempt: number;
    internalError: string;
    now: Date;
  }): Promise<boolean>;
  markSent(videoId: string, names: string[], now: Date): Promise<void>;
  /**
   * Takes the right to re-send a `QUEUED` task's message: true for exactly one caller while the task has not been sent
   * since `sentBefore` (the 1-minute guard that keeps repeated and concurrent sweeps to one message).
   */
  claimResend(input: {
    videoId: string;
    name: string;
    now: Date;
    sentBefore: Date;
  }): Promise<boolean>;
  // ---- sweep
  listLeaseExpired(
    now: Date,
    limit: number,
  ): Promise<{ videoId: string; name: string }[]>;
  /** `QUEUED` tasks untouched since `before` and not re-sent since `sentBefore`. */
  listQueuedStale(input: {
    before: Date;
    sentBefore: Date;
    limit: number;
  }): Promise<{ videoId: string; name: string }[]>;
  /** Moves an expired-lease `RUNNING` task back to `QUEUED`. */
  releaseExpired(videoId: string, name: string, now: Date): Promise<boolean>;
  /** `PROCESSING` videos with a `PENDING` task and nothing `QUEUED` or `RUNNING`: a fan-in whose last step was lost. */
  listIdleProcessing(limit: number): Promise<string[]>;
}

/** Everything one transaction can touch. */
export interface VideoTx {
  video: VideoRepository;
  tasks: TaskRepository;
}

export type RunVideoTx = <T>(fn: (tx: VideoTx) => Promise<T>) => Promise<T>;

export abstract class VideoStore {
  abstract readonly video: VideoRepository;
  abstract readonly tasks: TaskRepository;
  /** One database transaction (`TransactionRunner.run`); no storage, queue or R1 call inside `fn`. */
  abstract readonly tx: RunVideoTx;
}

// ---- observability

export type VideoMetricName =
  | 'video_task_total'
  | 'video_task_seconds'
  | 'video_upload_to_ready_seconds'
  | 'video_status_transitions_total'
  | 'video_stuck_recovered_total'
  | 'video_playback_total'
  | 'video_queue_age_seconds';

/** The nine instruments of AS-57 behind a port, so tests read what was counted. Labels are bounded outcomes only. */
export abstract class VideoMetrics {
  abstract inc(
    name: VideoMetricName,
    labels?: Record<string, string>,
    by?: number,
  ): void;
  abstract observe(
    name: VideoMetricName,
    value: number,
    labels?: Record<string, string>,
  ): void;
}

export interface VideoLogFields {
  videoId?: string;
  task?: string;
  attempt?: number;
  result?: string;
  requestId?: string;
  traceId?: string;
  [key: string]: unknown;
}

/** Structured task logs: fields come from the port, never from bytes, names, tokens or encoder text. */
export abstract class VideoLogger {
  abstract info(message: string, fields: VideoLogFields): void;
  abstract warn(message: string, fields: VideoLogFields): void;
  abstract error(message: string, fields: VideoLogFields): void;
}

// ---- encoder

/** What the adapter measured on a finished rendition: the numbers `package` writes into the master playlist. */
export interface RenditionResult {
  width: number;
  height: number;
  frameRate: number;
  codecs: string;
  /** Highest single-segment bitrate and the average, in bits per second. */
  peakBitrate: number;
  averageBitrate: number;
  segmentCount: number;
  /** File names written in `outDir` (playlist and segments). */
  files: string[];
}

export interface TranscodeContext {
  signal?: AbortSignal;
  timeoutMs: number;
}

/** The encoder behind a port: tests put a stub binary first on `PATH`; the adapter never builds a shell command. */
export abstract class TranscoderPort {
  abstract probe(file: string, ctx: TranscodeContext): Promise<ProbeResult>;
  abstract poster(
    input: { file: string; out: string; atSec: number },
    ctx: TranscodeContext,
  ): Promise<void>;
  abstract sprite(
    input: { file: string; outDir: string; durationSec: number },
    ctx: TranscodeContext,
  ): Promise<{ image: string; vtt: string; tiles: number }>;
  abstract rendition(
    input: {
      file: string;
      outDir: string;
      rendition: Rendition;
      /** Constant output frame rate from `outputFrameRate`. */
      fps: number;
      hasAudio: boolean;
    },
    ctx: TranscodeContext,
  ): Promise<RenditionResult>;
}
