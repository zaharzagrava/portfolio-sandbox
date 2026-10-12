/** A closing shop is kept this long before the purge, so the owner can change their mind (FR-060). */
export const OFFBOARDING_GRACE_DAYS = 30;
export const OFFBOARDING_GRACE_MS = OFFBOARDING_GRACE_DAYS * 86_400_000;

/** Invites are kept this long after they expired, were revoked or accepted, then removed with their address. */
export const INVITE_RETENTION_MS = 30 * 86_400_000;
