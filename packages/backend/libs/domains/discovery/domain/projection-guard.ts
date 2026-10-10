import { assertNever } from '@app/common/core/assert-never';

/**
 * Per-source version guards of the search projection (FR-018, FR-019, AS-81). Every source compares only against its
 * own version; nothing here compares one source's version with another's.
 *
 * `applied`: newer, write it. `duplicate`: equal version, a harmless identical re-write. `stale`: older (or forbidden
 * after a tombstone), ignore and count.
 */
export type GuardOutcome = 'applied' | 'duplicate' | 'stale';

export const PRODUCT_EVENT_KINDS = [
  'created',
  'updated',
  'archived',
  'restored',
  'deleted',
] as const;
export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];

export interface StoredProduct {
  version: number;
  deleted: boolean;
}

export interface IncomingProduct {
  version: number;
  kind: ProductEventKind;
}

/** Applied and duplicate outcomes write; stale ones never do. */
export const shouldWrite = (outcome: GuardOutcome): boolean =>
  outcome !== 'stale';

const compare = (stored: number, incoming: number): GuardOutcome =>
  incoming > stored ? 'applied' : incoming === stored ? 'duplicate' : 'stale';

/** Whether an event kind may start a new life for a product whose latest state is a tombstone. */
const mayRecreate = (kind: ProductEventKind): boolean => {
  switch (kind) {
    case 'created':
      return true;
    case 'updated':
    case 'archived':
    case 'restored':
    case 'deleted':
      return false;
    default:
      return assertNever(kind);
  }
};

/** Product fields, guarded by `productVersion`, with the delete-tombstone rules (AS-23..26, AS-81). */
export function decideProduct(
  stored: StoredProduct | null,
  incoming: IncomingProduct,
): GuardOutcome {
  if (stored === null) return 'applied';
  if (!stored.deleted) return compare(stored.version, incoming.version);
  if (incoming.version < stored.version) return 'stale';
  if (incoming.version === stored.version)
    return incoming.kind === 'deleted' ? 'duplicate' : 'stale';
  if (incoming.kind === 'deleted') return 'applied';
  return mayRecreate(incoming.kind) ? 'applied' : 'stale';
}

const decideVersion = (
  stored: number | null,
  incoming: number,
): GuardOutcome => (stored === null ? 'applied' : compare(stored, incoming));

/** Image fields, guarded by `galleryVersion`. */
export const decideMedia = decideVersion;
/** Sponsored flag, guarded by `sponsorshipVersion`. */
export const decideSponsorship = decideVersion;
/** Popularity bucket, guarded by the computation time (`popularityAt`, epoch ms). */
export const decidePopularity = decideVersion;

export interface StoredShopState {
  shopVersion: number | null;
  /** epoch ms of the last applied event */
  lastEventAt: number;
}
export interface IncomingShopState {
  shopVersion: number | null;
  /** envelope time, epoch ms */
  occurredAt: number;
}

/**
 * Shop state: `shopVersion` when both sides carry one, else the envelope time against the stored `lastEventAt`
 * (offboarding events have no version).
 */
export function decideShopState(
  stored: StoredShopState | null,
  incoming: IncomingShopState,
): GuardOutcome {
  if (stored === null) return 'applied';
  if (stored.shopVersion !== null && incoming.shopVersion !== null)
    return compare(stored.shopVersion, incoming.shopVersion);
  return compare(stored.lastEventAt, incoming.occurredAt);
}
