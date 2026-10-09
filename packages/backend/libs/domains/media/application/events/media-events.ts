import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** Written by the media Lambda (SQL outbox insert, same shape). Consumers: feed/discussions show the post, product gallery. */
export const MediaReady = defineEvent(
  'media.ready',
  'media',
  1,
  z.object({
    mediaId: z.string(),
    shopId: z.string().nullable(),
    purpose: z.string(),
    variants: z.record(
      z.string(),
      z.object({ key: z.string(), width: z.number(), height: z.number() }),
    ),
    possibleDuplicateOf: z.string().nullable(),
  }),
);
