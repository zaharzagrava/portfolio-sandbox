/**
 * Constants of S31 (spec Assumptions). The request limits repeat `packages/contracts/src/asset-library/limits.ts`
 * because the domain layer imports nothing but itself; the e2e specs assert both agree at the boundaries.
 */
export const LIMITS = {
  /** chunks per prepare / per commit */
  prepareMaxChunks: 5_000,
  commitMaxChunks: 15_000,
  chunkMaxBytes: 16 * 1024 * 1024,
  fileMaxBytes: 50 * 1024 * 1024 * 1024,
  pathMaxLength: 1_000,
  segmentMaxLength: 255,
  /** seconds */
  uploadPermissionSec: 900,
  manifestUrlSec: 600,
  shareGrantSec: 120,
  buyerGrantSec: 600,
  idempotencyTtlSec: 24 * 3600,
  /** pages */
  listDefault: 50,
  listMax: 100,
  journalDefault: 500,
  journalMax: 1_000,
  manifestDefault: 1_000,
  manifestMax: 2_000,
  /** share links */
  shareMaxHours: 720,
  shareMaxDownloads: 10_000,
  /** storage calls, milliseconds (FR-014) */
  headTimeoutMs: 5_000,
  deleteTimeoutMs: 10_000,
  openTimeoutMs: 10_000,
  idleStreamMs: 30_000,
} as const;
