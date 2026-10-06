import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** Written by the ChatMessage INSERT trigger (migration 20261001260000) - for messages from Rust AND NestJS. */
export const ChatMessagePosted = defineEvent('chat.message_posted', 'chat', 1, z.object({
  channelId: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  authorId: z.string(),
  preview: z.string(),
}));
