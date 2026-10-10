/** Idle lifetime of one refresh token (FR-034). */
export const REFRESH_IDLE_SEC = 30 * 86_400;
/** Absolute lifetime of a session, however often it is refreshed (FR-034). */
export const SESSION_ABSOLUTE_SEC = 90 * 86_400;
/** Active sessions per user; the oldest is revoked on overflow (FR-036). */
export const MAX_ACTIVE_SESSIONS = 20;
/** Access token lifetime (FR-021). */
export const ACCESS_TOKEN_TTL_SEC = 300;

export const epochSec = (date: Date): number =>
  Math.floor(date.getTime() / 1000);

/** Expiry of a refresh token issued at `now` for a session that ends at `absoluteExpiry` (epoch seconds). */
export const refreshExpiry = (now: Date, absoluteExpiry: number): number =>
  Math.min(epochSec(now) + REFRESH_IDLE_SEC, absoluteExpiry);
