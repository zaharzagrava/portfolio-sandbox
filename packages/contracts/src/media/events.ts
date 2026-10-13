import { z } from "zod";
import { mediaPurposeSchema, mediaRejectCodeSchema } from "./media.ts";

/**
 * Payloads of the five events S29 writes to the outbox (`media.events`), exactly as in
 * `specs/domains/S29-photos/contracts/events.md`. The envelope and `defineEvent` live in the backend
 * (`libs/domains/media/domain/media-events.ts`). No event carries an original key, a decoder message or
 * the perceptual hash. Identifiers are UUIDs and versions are non-negative: consumers (S32) rely on the schema to
 * refuse a malformed event, so it is as strict as the data.
 */
const id = z.uuid();
const version = z.number().int().nonnegative();

const variantSchema = z.object({
  key: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const mediaReadyPayloadSchema = z.object({
  mediaId: id,
  mediaVersion: version,
  shopId: id.nullable(),
  uploaderId: id,
  purpose: mediaPurposeSchema,
  width: z.number().int(),
  height: z.number().int(),
  variants: z.object({
    thumb: variantSchema,
    feed: variantSchema,
    full: variantSchema,
  }),
  duplicateSuspected: z.boolean(),
});

export const mediaRejectedPayloadSchema = z.object({
  mediaId: id,
  mediaVersion: version,
  shopId: id.nullable(),
  uploaderId: id,
  purpose: mediaPurposeSchema,
  code: mediaRejectCodeSchema,
});

export const mediaDeletedPayloadSchema = z.object({
  mediaId: id,
  mediaVersion: version,
  shopId: id.nullable(),
  purpose: mediaPurposeSchema,
});

export const mediaGalleryChangedPayloadSchema = z.object({
  productId: id,
  shopId: id,
  mediaIds: z.array(id).max(20),
  galleryVersion: version,
});

export const mediaDuplicateSuspectedPayloadSchema = z.object({
  mediaId: id,
  shopId: id,
  matchedMediaId: id,
  matchedShopId: id,
  distance: z.number().int().min(0).max(3),
});

export const mediaEventSchemas = {
  "media.ready": mediaReadyPayloadSchema,
  "media.rejected": mediaRejectedPayloadSchema,
  "media.deleted": mediaDeletedPayloadSchema,
  "media.gallery_changed": mediaGalleryChangedPayloadSchema,
  "media.duplicate_suspected": mediaDuplicateSuspectedPayloadSchema,
} as const;
