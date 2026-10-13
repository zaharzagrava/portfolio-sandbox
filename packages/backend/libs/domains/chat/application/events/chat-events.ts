import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** Written by the ChatMessage INSERT trigger (migration 20261001260000) - for messages from Rust AND NestJS. */
export const ChatMessagePosted = defineEvent(
  'chat.message_posted',
  'chat',
  1,
  z.object({
    channelId: z.string(),
    messageId: z.string(),
    seq: z.number().int(),
    authorId: z.string(),
    preview: z.string(),
  }),
);

/**
 * A message the recipient has not read and is not online to see: published once per (recipient, channel) per
 * coalescing window, for whoever tells people about it (chat does not know who that is). The preview is the message's
 * own preview, never the author's name. `dedupeKey` is chat's idempotency key for the escalation: a retry of the same
 * escalation carries the same key.
 */
export const ChatMessageEscalated = defineEvent(
  'chat.message_escalated',
  'chat',
  1,
  z.object({
    recipientId: z.string(),
    channelId: z.string(),
    channelTitle: z.string(),
    preview: z.string(),
    dedupeKey: z.string(),
  }),
);
