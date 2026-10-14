import { z } from "zod";

export const CHAT_ERROR_CODES = [
  "validation_failed",
  "too_many_channels",
  "channel_not_found",
  "member_not_found",
  "message_not_found",
  "product_not_found",
  "forbidden",
  "permission_denied",
  "banned",
  "muted",
  "channel_archived",
  "product_archived",
  "invalid_transition",
  "channel_exists",
  "idempotency_conflict",
  "idempotency_key_reuse",
  "reply_target_invalid",
  "presence_unavailable",
] as const;
export const chatErrorCodeSchema = z.enum(CHAT_ERROR_CODES);
export type ChatErrorCode = z.infer<typeof chatErrorCodeSchema>;
