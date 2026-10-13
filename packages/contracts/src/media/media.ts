import { z } from "zod";

/**
 * S29 photos (specs/domains/S29-photos/contracts/media-api.md): the single source of truth for the request and response
 * bodies of the upload, read and batch routes. Used by the controllers (strict request parsing), the e2e specs and
 * W04. No original key, hash or decoder message appears in any of these.
 */

export const MEDIA_MAX_BYTES = 15_728_640;
export const MEDIA_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;
export const MEDIA_BATCH_MAX = 100;

export const mediaPurposeSchema = z.enum(["product", "review"]);
export type MediaPurpose = z.infer<typeof mediaPurposeSchema>;

export const mediaStatusSchema = z.enum([
  "PENDING_UPLOAD",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "REJECTED",
  "EXPIRED",
  "DELETED",
]);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

/** The closed vocabulary of AS-16; a decoder message never becomes a code. */
export const MEDIA_REJECT_CODES = [
  "not_an_image",
  "format_not_allowed",
  "multi_frame",
  "image_too_large",
  "size_invalid",
  "malware_detected",
  "processing_failed",
] as const;
export const mediaRejectCodeSchema = z.enum(MEDIA_REJECT_CODES);
export type MediaRejectCode = z.infer<typeof mediaRejectCodeSchema>;

/** FR-073: the stable `code` values of this capability's problem+json answers. */
export const mediaProblemCodes = [
  "validation_failed",
  "permission_denied",
  "shop_suspended",
  "shop_offboarding",
  "pending_uploads_limit",
  "upload_incomplete",
  "upload_expired",
  "media_not_found",
  "media_in_use",
  "media_busy",
  "media_not_attachable",
  "product_not_found",
  "product_archived",
  "version_conflict",
] as const;
export type MediaProblemCode = (typeof mediaProblemCodes)[number];

/** The route decides which purpose is valid (`review` on `/media/uploads`, `product` on the shop route). */
export const mediaUploadRequestSchema = z
  .object({ purpose: mediaPurposeSchema })
  .strict();
export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

export const mediaUploadResponseSchema = z
  .object({
    mediaId: z.uuid(),
    upload: z
      .object({
        url: z.string().min(1),
        fields: z.record(z.string(), z.string()),
        expiresAt: z.string().min(1),
      })
      .strict(),
    maxBytes: z.literal(MEDIA_MAX_BYTES),
    allowedContentTypes: z.tuple([
      z.literal("image/jpeg"),
      z.literal("image/png"),
      z.literal("image/webp"),
      z.literal("image/avif"),
    ]),
  })
  .strict();
export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;

export const mediaUrlsSchema = z
  .object({
    thumb: z.string().min(1),
    feed: z.string().min(1),
    full: z.string().min(1),
  })
  .strict();
export type MediaUrls = z.infer<typeof mediaUrlsSchema>;

export const mediaPublicSchema = z
  .object({
    id: z.uuid(),
    status: z.literal("READY"),
    purpose: mediaPurposeSchema,
    shopId: z.uuid().nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    urls: mediaUrlsSchema,
  })
  .strict();
export type MediaPublic = z.infer<typeof mediaPublicSchema>;

/** The uploader's (and, for shop photos, a member's) view: every non-`DELETED` status. */
export const mediaOwnerSchema = z
  .object({
    id: z.uuid(),
    status: mediaStatusSchema.exclude(["DELETED"]),
    purpose: mediaPurposeSchema,
    shopId: z.uuid().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    urls: mediaUrlsSchema.nullable(),
    rejectCode: mediaRejectCodeSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type MediaOwner = z.infer<typeof mediaOwnerSchema>;

export const mediaBatchItemSchema = mediaPublicSchema.nullable();
export type MediaBatchItem = z.infer<typeof mediaBatchItemSchema>;

/** `POST /media/:id/complete`: `202` while work is pending, `200` when finished. */
export const mediaCompleteResponseSchema = z
  .object({
    status: z.enum(["UPLOADED", "PROCESSING", "READY", "REJECTED"]),
    rejectCode: mediaRejectCodeSchema.optional(),
  })
  .strict();
export type MediaCompleteResponse = z.infer<typeof mediaCompleteResponseSchema>;
