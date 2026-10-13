import type { Variants } from './media-urls';
import {
  LEASE_STUCK_MINUTES,
  PURGE_AFTER_DAYS,
  UPLOADED_STUCK_MINUTES,
  UPLOAD_SLOT_MINUTES,
} from './upload-policy';

/** The decision parts of the three maintenance jobs (S29 FR-062–FR-064). Pure: the caller passes `now`. */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Upload slots created before this instant expire (job `media.expire-pending-uploads`). */
export const expiryCutoff = (now: Date): Date =>
  new Date(now.getTime() - UPLOAD_SLOT_MINUTES * MINUTE);

/** What `media.requeue-stuck` re-sends: lost messages and workers that died holding the lease. */
export const stuckCutoffs = (
  now: Date,
): { uploadedBefore: Date; leaseExpiredBefore: Date; touchedBefore: Date } => ({
  uploadedBefore: new Date(now.getTime() - UPLOADED_STUCK_MINUTES * MINUTE),
  leaseExpiredBefore: new Date(now.getTime() - LEASE_STUCK_MINUTES * MINUTE),
  // A photo re-driven less than a minute ago is not sent again by the next run.
  touchedBefore: new Date(now.getTime() - MINUTE),
});

/** Rows that reached a terminal status before this instant are purged (job `media.purge`). */
export const purgeCutoff = (now: Date): Date =>
  new Date(now.getTime() - PURGE_AFTER_DAYS * DAY);

export const variantKeysOf = (variants: Variants | null): string[] =>
  variants ? Object.values(variants).map((v) => v.key) : [];

/** The variant objects of a purged photo that no live photo references (shared, content-addressed keys stay). */
export const unreferencedKeys = (
  variants: Variants | null,
  live: ReadonlySet<string>,
): string[] =>
  [...new Set(variantKeysOf(variants))].filter((key) => !live.has(key));
