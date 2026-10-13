/**
 * Link life cycle (FR-032, FR-050 - FR-053): `ACTIVE --disable--> DISABLED` (final); `EXPIRED` is derived when an
 * `ACTIVE` link reaches `now >= expiresAt` and is never stored. Pure: the instant is always passed in (AS-65).
 */
export type StoredStatus = 'ACTIVE' | 'DISABLED';
export type LinkState = StoredStatus | 'EXPIRED';
export type LinkAction = 'change' | 'disable';

export interface LinkStateInput {
  /** Rows written before S37 have no status and read as `ACTIVE`. */
  status?: StoredStatus;
  expiresAt?: string | null;
}

/** Records are kept 13 months after expiry or disable so a code is not recycled while old posts may carry it. */
export const RETENTION_MONTHS = 13;

export function isExpired(
  link: { expiresAt?: string | null },
  now: Date,
): boolean {
  return !!link.expiresAt && now.getTime() >= Date.parse(link.expiresAt);
}

export function linkStateOf(link: LinkStateInput, now: Date): LinkState {
  if (link.status === 'DISABLED') return 'DISABLED';
  return isExpired(link, now) ? 'EXPIRED' : 'ACTIVE';
}

/** Change and disable are allowed only from `ACTIVE` (an expired or disabled link is final). */
export function canTransition(state: LinkState, _action: LinkAction): boolean {
  return state === 'ACTIVE';
}

/** TTL attribute: (`expiresAt` or `disabledAt`) + 13 months, epoch seconds; none while the link is open-ended. */
export function purgeAtEpoch(link: {
  expiresAt?: string | null;
  disabledAt?: string;
}): number | undefined {
  const base = link.disabledAt ?? link.expiresAt;
  if (!base) return undefined;
  const date = new Date(base);
  date.setUTCMonth(date.getUTCMonth() + RETENTION_MONTHS);
  return Math.floor(date.getTime() / 1000);
}
