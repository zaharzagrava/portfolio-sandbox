import { z } from "zod";

/**
 * S30 product video HTTP contract (specs/domains/S30-video/contracts/video-api.md). Request schemas are strict; the
 * responses never carry a storage location, an upload identifier or encoder output.
 */
export const VIDEO_MAX_SIZE_BYTES = 21_474_836_480;
export const VIDEO_MIN_SIZE_BYTES = 1024;

export const videoContentTypeSchema = z.enum([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
export const videoVisibilitySchema = z.enum(["public", "unlisted"]);
export const videoStatusSchema = z.enum([
  "UPLOADING",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "FAILED",
  "EXPIRED",
  "DELETED",
]);
export type VideoStatus = z.infer<typeof videoStatusSchema>;

export const videoRetryableFailureCodes = [
  "transcode_failed",
  "task_timeout",
  "storage_unavailable",
  "processing_timeout",
] as const;
export const videoPermanentFailureCodes = [
  "not_a_video",
  "no_video_stream",
  "duration_exceeded",
  "duration_too_short",
  "resolution_exceeded",
  "source_size_mismatch",
] as const;
export const videoFailureCodeSchema = z.enum([
  ...videoRetryableFailureCodes,
  ...videoPermanentFailureCodes,
]);
export type VideoFailureCode = z.infer<typeof videoFailureCodeSchema>;

const partNumber = z.number().int().min(1);

export const videoStartRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .min(VIDEO_MIN_SIZE_BYTES)
    .max(VIDEO_MAX_SIZE_BYTES),
  contentType: videoContentTypeSchema,
  visibility: videoVisibilitySchema,
  productId: z.uuid().optional(),
});
export type VideoStartRequest = z.infer<typeof videoStartRequestSchema>;

export const videoPartSchema = z.object({
  partNumber,
  url: z.url(),
  contentLength: z.number().int().positive(),
});

export const videoStartResponseSchema = z.object({
  videoId: z.uuid(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: z.string(),
  visibility: videoVisibilitySchema,
  shareToken: z.string().nullable(),
  parts: z.array(videoPartSchema),
});
export type VideoStartResponse = z.infer<typeof videoStartResponseSchema>;

export const videoUploadStateSchema = z.object({
  status: z.literal("UPLOADING"),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  uploadedParts: z.array(
    z.object({ partNumber, size: z.number().int().nonnegative() }),
  ),
  missingParts: z.array(partNumber),
  parts: z.array(videoPartSchema),
  expiresAt: z.string(),
});
export type VideoUploadState = z.infer<typeof videoUploadStateSchema>;

export const videoCompleteRequestSchema = z.strictObject({
  parts: z
    .array(z.strictObject({ partNumber, etag: z.string().min(1).max(256) }))
    .min(1)
    .refine(
      (parts) =>
        parts.every(
          (p, i) => i === 0 || p.partNumber > parts[i - 1].partNumber,
        ),
      { message: "parts must be strictly ascending by partNumber" },
    ),
});
export type VideoCompleteRequest = z.infer<typeof videoCompleteRequestSchema>;

export const videoCompleteResponseSchema = z.object({
  status: z.enum(["PROCESSING", "READY", "FAILED"]),
  failureCode: videoFailureCodeSchema.optional(),
});
export type VideoCompleteResponse = z.infer<typeof videoCompleteResponseSchema>;

export const videoRenditionSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const videoOwnerSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  visibility: videoVisibilitySchema,
  status: videoStatusSchema,
  failureCode: videoFailureCodeSchema.nullable(),
  retryable: z.boolean(),
  productId: z.uuid().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  renditions: z.array(videoRenditionSchema),
  progress: z.object({
    stage: z.string(),
    tasksDone: z.number().int().nonnegative(),
    tasksTotal: z.number().int().nonnegative(),
  }),
  posterUrl: z.url().nullable(),
  spriteUrl: z.url().nullable(),
  shareToken: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VideoOwner = z.infer<typeof videoOwnerSchema>;

export const videoListSchema = z.object({
  items: z.array(videoOwnerSchema),
  nextCursor: z.string().nullable(),
});
export type VideoList = z.infer<typeof videoListSchema>;

/** Query of `GET /shops/:shopId/videos`: `limit` 1–50 (default 20), an opaque `cursor`, an optional `status`. */
export const videoListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
  status: videoStatusSchema.optional(),
});
export type VideoListQuery = z.infer<typeof videoListQuerySchema>;

export const videoPatchRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  productId: z.uuid().nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
});
export type VideoPatchRequest = z.infer<typeof videoPatchRequestSchema>;

/** S30 `GET /videos/:id/playback` (AS-31, AS-32). `expiresAt` is null for public videos. */
export const videoPlaybackSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  masterUrl: z.url(),
  posterUrl: z.url().nullable(),
  /** The server always sends null or a URL; absence is tolerated for older parsers. */
  spriteUrl: z.url().nullable().optional(),
  durationSec: z.number().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  renditions: z.array(videoRenditionSchema),
  expiresAt: z.string().nullable(),
});
export type VideoPlayback = z.infer<typeof videoPlaybackSchema>;

/** S30 `GET /products/:productId/videos` (AS-38); also the BFF's upstream schema (S48). */
export const productVideosSchema = z.object({
  items: z.array(
    z.object({
      videoId: z.string(),
      title: z.string(),
      posterUrl: z.url().nullable(),
      durationSec: z.number().nonnegative(),
    }),
  ),
});
export type ProductVideos = z.infer<typeof productVideosSchema>;

/** `code` of every problem+json the video routes answer (video-api.md, "Problem codes"). */
export const videoProblemCodes = [
  "validation_failed",
  "invalid_cursor",
  "permission_denied",
  "shop_suspended",
  "video_not_found",
  "product_not_found",
  "shop_offboarding",
  "product_archived",
  "pending_uploads_limit",
  "upload_incomplete",
  "upload_closed",
  "upload_expired",
  "version_conflict",
  "product_video_limit",
  "not_retryable",
  "retry_limit",
  "source_purged",
  "invalid_state",
  "parts_mismatch",
  "rate_limited",
  "storage_unavailable",
  "service_unavailable",
] as const;
export type VideoProblemCode = (typeof videoProblemCodes)[number];
