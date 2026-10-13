import {
  MEDIA_ALLOWED_CONTENT_TYPES,
  MEDIA_MAX_BYTES,
} from '@marketplace-sandbox/contracts';

/** Limits and key shapes of the upload flow (S29 FR-002–FR-005, FR-012). Defaults from the notes; not contract. */
export const ALLOWED_CONTENT_TYPES = [...MEDIA_ALLOWED_CONTENT_TYPES];
export const MAX_ORIGINAL_BYTES = MEDIA_MAX_BYTES;
export const MAX_INPUT_PIXELS = 50_000_000;
export const MAX_GALLERY_PHOTOS = 20;
export const MAX_PENDING_UPLOADS = 50;
export const SIGNATURE_SECONDS = 600;
export const UPLOAD_SLOT_MINUTES = 60;
export const PURGE_AFTER_DAYS = 7;
export const LEASE_MINUTES = 5;
export const MAX_ATTEMPTS = 5;
export const UPLOADED_STUCK_MINUTES = 2;
export const LEASE_STUCK_MINUTES = 10;
export const ORIGINALS_PREFIX = 'media/originals/';
export const DERIVED_PREFIX = 'media/derived/';

export const originalKeyFor = (
  scope: { shopId: string } | { userId: string },
  uuid: string,
): string =>
  'shopId' in scope
    ? `${ORIGINALS_PREFIX}shops/${scope.shopId}/${uuid}`
    : `${ORIGINALS_PREFIX}users/${scope.userId}/${uuid}`;

/** A key a worker may act on: under the originals prefix, a two-level shape, no traversal. */
export const isOriginalKey = (key: string): boolean =>
  /^media\/originals\/(?:shops|users)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(
    key,
  );
