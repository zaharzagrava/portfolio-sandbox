import { z } from "zod";
import {
  videoFailureCodeSchema,
  videoRenditionSchema,
  videoVisibilitySchema,
} from "./video.ts";

/**
 * Payloads of the three events S30 writes to the outbox (`specs/domains/S30-video/contracts/events.md`). Each carries
 * `videoVersion` (the row's version after the change); none carries a URL, storage key, share token or upload id.
 */
const id = z.uuid();
const version = z.number().int().nonnegative();

export const videoReadyPayloadSchema = z.object({
  videoId: id,
  videoVersion: version,
  shopId: id,
  uploaderId: id,
  productId: id.nullable(),
  visibility: videoVisibilitySchema,
  durationSec: z.number().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  renditions: z.array(videoRenditionSchema),
  hasSprite: z.boolean(),
});

export const videoFailedPayloadSchema = z.object({
  videoId: id,
  videoVersion: version,
  shopId: id,
  uploaderId: id,
  failureCode: videoFailureCodeSchema,
});

export const videoDeletedPayloadSchema = z.object({
  videoId: id,
  videoVersion: version,
  shopId: id,
  productId: id.nullable(),
});

export const videoEventSchemas = {
  "video.ready": videoReadyPayloadSchema,
  "video.failed": videoFailedPayloadSchema,
  "video.deleted": videoDeletedPayloadSchema,
} as const;
