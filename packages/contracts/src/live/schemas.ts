import { z } from 'zod';

/** Live launch stream contracts (S23 spec "Provides"). Dates are ISO strings on the wire, comment times epoch milliseconds. */

export const LIVE_STATUSES = ['SCHEDULED', 'LIVE', 'ENDED'] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export const LIVE_REACTIONS = ['❤️', '🔥', '😂', '😮', '👏', '🛒'] as const;
export type LiveReaction = (typeof LIVE_REACTIONS)[number];

/** `code` vocabulary of the capability (snake case, the platform's problem documents) with the status of each. */
export const LIVE_ERROR_STATUS = {
  stream_not_found: 404,
  stream_ended: 409,
  stream_not_live: 409,
  user_muted: 403,
  comment_blocked: 422,
  client_id_reused: 422,
  live_unavailable: 503,
  gateway_full: 503,
  product_not_pinnable: 422,
  cannot_mute_staff: 422,
  comment_not_found: 404,
} as const;
export type LiveErrorCode = keyof typeof LIVE_ERROR_STATUS;

export const COMMENT_BLOCK_REASONS = ['link', 'policy'] as const;
export type CommentBlockReason = (typeof COMMENT_BLOCK_REASONS)[number];

export const MAX_COMMENT_CODE_POINTS = 200;
export const MAX_PIN_TEXT = 80;
export const MAX_PIN_STOCK = 1_000_000;
export const RECENT_COMMENTS = 50;
export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 200;

const iso = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const createLiveStreamRequestSchema = z
  .object({
    title: z.string().min(3).max(120),
    launchEventId: uuid.optional(),
  })
  .strict();
export type CreateLiveStreamRequest = z.infer<
  typeof createLiveStreamRequestSchema
>;

export const liveStreamSchema = z.object({
  id: uuid,
  shopId: uuid,
  title: z.string(),
  status: z.enum(LIVE_STATUSES),
  launchEventId: uuid.nullable(),
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  createdAt: iso,
});
export type LiveStreamDto = z.infer<typeof liveStreamSchema>;

export const pinRequestSchema = z
  .object({
    productId: uuid,
    text: z.string().min(1).max(MAX_PIN_TEXT),
    stockLeft: z.number().int().min(0).max(MAX_PIN_STOCK).optional(),
  })
  .strict();
export type PinRequest = z.infer<typeof pinRequestSchema>;

export const pinSchema = z.object({
  version: z.number().int().min(1),
  productId: uuid,
  productTitle: z.string(),
  text: z.string(),
  stockLeft: z.number().int().optional(),
  pinnedAt: iso,
});
export type LivePin = z.infer<typeof pinSchema>;

/** What a `pin` event carries after an unpin: the version that ordered it, no pin. */
export const unpinEventSchema = z.object({
  version: z.number().int().min(1),
  unpinned: z.literal(true),
});
export type LiveUnpinEvent = z.infer<typeof unpinEventSchema>;
export const livePinEventSchema = z.union([pinSchema, unpinEventSchema]);
export type LivePinEvent = z.infer<typeof livePinEventSchema>;

export const postCommentRequestSchema = z
  .object({
    text: z.string(),
    clientId: uuid.optional(),
  })
  .strict();
export type PostCommentRequest = z.infer<typeof postCommentRequestSchema>;

export const liveCommentSchema = z.object({
  id: uuid,
  streamId: uuid,
  authorId: uuid,
  authorName: z.string(),
  text: z.string(),
  at: z.number().int(),
  priority: z.literal(true).optional(),
});
export type LiveComment = z.infer<typeof liveCommentSchema>;

/** A comment as one viewer receives it in a window. */
export type LiveDeliveredComment = LiveComment & { mine?: true };

export const reactRequestSchema = z
  .object({
    reactions: z.record(z.string(), z.number()).superRefine((value, ctx) => {
      const keys = Object.keys(value);
      if (keys.length < 1 || keys.length > LIVE_REACTIONS.length)
        ctx.addIssue({ code: 'custom', message: 'between 1 and 6 emoji' });
      for (const key of keys) {
        if (!(LIVE_REACTIONS as readonly string[]).includes(key))
          ctx.addIssue({
            code: 'custom',
            message: 'unknown emoji',
            path: [key],
          });
        const count = value[key];
        if (!Number.isInteger(count) || count < 1 || count > 20)
          ctx.addIssue({
            code: 'custom',
            message: 'count must be an integer from 1 to 20',
            path: [key],
          });
      }
    }),
  })
  .strict();
export type ReactRequest = z.infer<typeof reactRequestSchema>;

export const liveSnapshotSchema = z.object({
  id: uuid,
  shopId: uuid,
  title: z.string(),
  status: z.enum(LIVE_STATUSES),
  launchEventId: uuid.nullable(),
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  pin: pinSchema.nullable(),
  /** Version of the last pin change (also after an unpin), so a client orders late `pin` events against it. */
  pinVersion: z.number().int().min(0),
  recent: z.array(liveCommentSchema),
  degraded: z.literal(true).optional(),
});
export type LiveSnapshotDto = z.infer<typeof liveSnapshotSchema>;

export const liveHistoryPageSchema = z.object({
  items: z.array(liveCommentSchema),
  nextCursor: z.string().nullable(),
});
export type LiveHistoryPage = z.infer<typeof liveHistoryPageSchema>;

export const liveHistoryQuerySchema = z
  .object({
    minute: z.string().regex(/^\d{12}$/),
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
    cursor: z.string().max(100).optional(),
  })
  .strict();

export const liveStatsSchema = z.object({
  second: z.number().int(),
  reactions: z.record(z.string(), z.number().int()),
  viewers: z.number().int(),
});
export type LiveStats = z.infer<typeof liveStatsSchema>;

/** Data of the event-connection frames (SSE event name → payload). */
export const liveSseSnapshotSchema = z.object({
  status: z.enum(LIVE_STATUSES),
  pin: pinSchema.nullable(),
  pinVersion: z.number().int().min(0),
  recent: z.array(liveCommentSchema),
});
export const liveSseCommentsSchema = z.object({
  items: z.array(
    liveCommentSchema.extend({ mine: z.literal(true).optional() }),
  ),
  rate: z.number().int(),
});
export type LiveSseSnapshot = z.infer<typeof liveSseSnapshotSchema>;
export type LiveSseComments = z.infer<typeof liveSseCommentsSchema>;

/** Payloads of the events on the event stream (`live.*`) and the outbox (`live.stream_*`). */
export const liveCommentPostedPayloadSchema = z.object({
  streamId: z.string(),
  commentId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  text: z.string(),
  at: z.number().int(),
  priority: z.literal(true).optional(),
});
export const liveCommentRemovedPayloadSchema = z.object({
  streamId: z.string(),
  commentId: z.string(),
  at: z.number().int(),
  reason: z.enum(['moderator', 'auto']),
  actorId: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
});
export const liveReactionsAggregatedPayloadSchema = z.object({
  streamId: z.string(),
  second: z.number().int(),
  reactions: z.record(z.string(), z.number().int()),
});
export const liveStreamStartedPayloadSchema = z.object({
  streamId: z.string(),
  shopId: z.string(),
  title: z.string(),
  launchEventId: z.string().nullable(),
  startedAt: iso,
});
export const liveStreamEndedPayloadSchema = z.object({
  streamId: z.string(),
  shopId: z.string(),
  endedAt: iso,
  durationSeconds: z.number().int().min(0),
});
