import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** `live.events`, key = streamId. Consumers: Dynamo history, async moderation. */
export const LiveCommentPosted = defineEvent('live.comment_posted', 'live', 1, z.object({
  streamId: z.string(),
  commentId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  text: z.string(),
  at: z.number().int(),
}));

export const LiveCommentRemoved = defineEvent('live.comment_removed', 'live', 1, z.object({
  streamId: z.string(),
  commentId: z.string(),
  at: z.number().int(),
  reason: z.string(),
}));
