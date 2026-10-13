import {
  mediaDeletedPayloadSchema,
  mediaDuplicateSuspectedPayloadSchema,
  mediaEventSchemas,
  mediaGalleryChangedPayloadSchema,
  mediaReadyPayloadSchema,
  mediaRejectedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * The five events `media` writes to the outbox (topic `media.events`, key = `aggregateId`), in the transaction that
 * changed the state (S29 FR-080). Payload schemas live in `packages/contracts` (`mediaEventSchemas`). The aggregate
 * version of a photo event is the row's `version` after the transition (`mediaVersion`); of `media.gallery_changed`,
 * the gallery version.
 */
export const MediaReady = defineEvent(
  'media.ready',
  'media',
  1,
  mediaReadyPayloadSchema,
  { carries: 'state' },
);
export const MediaRejected = defineEvent(
  'media.rejected',
  'media',
  1,
  mediaRejectedPayloadSchema,
  { carries: 'state' },
);
/*
 * Every event of the `media` aggregate type is marked `carries: 'state'`, deletions and suspicions included. The
 * projections framework refuses a coalescing consumer (S32's `search-media` reads this topic with `coalesce`) when any
 * event of the topic's aggregate type is a delta; a deletion is the terminal state of the photo, and a suspicion is an
 * advisory note that no coalescing consumer handles, so keeping only the newest event per aggregate loses nothing they use.
 */
export const MediaDeleted = defineEvent(
  'media.deleted',
  'media',
  1,
  mediaDeletedPayloadSchema,
  { carries: 'state' },
);
/** `aggregateId` is the product, not a photo. */
export const MediaGalleryChanged = defineEvent(
  'media.gallery_changed',
  'media',
  1,
  mediaGalleryChangedPayloadSchema,
  { carries: 'state' },
);
export const MediaDuplicateSuspected = defineEvent(
  'media.duplicate_suspected',
  'media',
  1,
  mediaDuplicateSuspectedPayloadSchema,
  { carries: 'state' },
);

export const mediaEventDefinitions = {
  'media.ready': MediaReady,
  'media.rejected': MediaRejected,
  'media.deleted': MediaDeleted,
  'media.gallery_changed': MediaGalleryChanged,
  'media.duplicate_suspected': MediaDuplicateSuspected,
} as const;

export { mediaEventSchemas };
