import {
  videoDeletedPayloadSchema,
  videoEventSchemas,
  videoFailedPayloadSchema,
  videoReadyPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * The three events video writes to the outbox (S30 contracts/events.md), in the transaction that changed the state.
 * They share the `media` aggregate type, hence the topic `media.events`; `aggregateId` is the videoId and the
 * aggregate version is the row's `version` after the change (`videoVersion`). Marked `carries: 'state'` like every
 * event of the topic: S32's coalescing consumer refuses a topic holding a delta.
 */
export const VideoReady = defineEvent(
  'video.ready',
  'media',
  1,
  videoReadyPayloadSchema,
  { carries: 'state' },
);
export const VideoFailed = defineEvent(
  'video.failed',
  'media',
  1,
  videoFailedPayloadSchema,
  { carries: 'state' },
);
export const VideoDeleted = defineEvent(
  'video.deleted',
  'media',
  1,
  videoDeletedPayloadSchema,
  { carries: 'state' },
);

export const videoEventDefinitions = {
  'video.ready': VideoReady,
  'video.failed': VideoFailed,
  'video.deleted': VideoDeleted,
} as const;

export { videoEventSchemas };
