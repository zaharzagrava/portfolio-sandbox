import { randomBytes } from 'node:crypto';

/** Mirrors `WIDGET_PUBLISHABLE_KEY` of the contract package (compared in the contract e2e). */
const PUBLISHABLE_KEY = /^pk_live_[A-Za-z0-9_-]{24}$/;

export const isPublishableKey = (value: unknown): value is string =>
  typeof value === 'string' && PUBLISHABLE_KEY.test(value);

/** `pk_live_` + 24 URL-safe characters (144 bits) from a secure source (FR-002). */
export const generatePublishableKey = (): string =>
  `pk_live_${randomBytes(18).toString('base64url')}`;

/** `wis_` + 256 random bits (FR-009). */
export const generateIdentitySecret = (): string =>
  `wis_${randomBytes(32).toString('base64url')}`;

export const overlapExpiry = (now: Date, overlapHours: number): Date =>
  new Date(now.getTime() + overlapHours * 3_600_000);

export type PreviousSecretState = 'none' | 'valid' | 'expired';

/** Decided from the injected clock at the moment of use (FR-010, AS-28): valid strictly before the expiry instant. */
export function previousSecretState(
  expiresAt: Date | null,
  now: Date,
): PreviousSecretState {
  if (expiresAt === null) return 'none';
  return now.getTime() < expiresAt.getTime() ? 'valid' : 'expired';
}
