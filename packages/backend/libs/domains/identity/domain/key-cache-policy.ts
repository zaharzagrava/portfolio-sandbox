const KEY_SET_TTL_MS = 300_000;
const FORCED_RELOAD_COOLDOWN_MS = 30_000;
const KID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * When the in-process key set may be reloaded (A21): every 300 s, and early for an unknown `kid` at most once per
 * 30 s, so a flood of forged `kid`s cannot turn into a flood of database reads. Pure: callers pass `now`.
 */
export class KeyCachePolicy {
  private loadedAt?: number;
  private lastForced?: number;

  loaded(now: Date): void {
    this.loadedAt = now.getTime();
  }

  needsRefresh(now: Date): boolean {
    return (
      this.loadedAt === undefined ||
      now.getTime() - this.loadedAt >= KEY_SET_TTL_MS
    );
  }

  /** Records the reload when it is allowed. */
  mayForceReload(kid: string, now: Date): boolean {
    if (!KID_FORMAT.test(kid)) return false;
    if (
      this.lastForced !== undefined &&
      now.getTime() - this.lastForced < FORCED_RELOAD_COOLDOWN_MS
    )
      return false;
    this.lastForced = now.getTime();
    return true;
  }

  /** Test and cache-invalidation hook. */
  reset(): void {
    this.loadedAt = undefined;
  }
}
