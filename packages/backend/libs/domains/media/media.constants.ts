/** The standard (non-FIFO) queue the media-processing Lambda consumes; never given a `groupId` (L-001). */
export const MEDIA_QUEUE = 'media-processing';

/** Injection token: the configured media origin (`media_cdn_url`), the only host a client ever sees a photo URL on. */
export const MEDIA_ORIGIN = Symbol('MEDIA_ORIGIN');
