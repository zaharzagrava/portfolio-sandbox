/** A minted token is reused for this share of its lifetime (FR-070). */
const REUSE_SHARE = 0.8;

interface CacheKey {
  caller: string;
  audience: string;
  ttlSec: number;
}

const idOf = (key: CacheKey) =>
  JSON.stringify([key.caller, key.audience, key.ttlSec]);

interface Entry {
  token: string;
  mintedAt: number;
  reuseUntil: number;
}

/**
 * Process-local reuse of minted service tokens per `(caller, audience, ttl)`: a hot internal call path does not sign
 * a token per request, and no token is served after 80 % of its life (so the receiver always has time left). Pure:
 * callers pass `now`.
 */
export class ServiceTokenCache {
  private readonly entries = new Map<string, Entry>();

  /** The reusable token, if there is one; never mints (for callers whose minting is asynchronous). */
  peek(key: CacheKey, now: Date): string | undefined {
    const hit = this.entries.get(idOf(key));
    const t = now.getTime();
    return hit && t >= hit.mintedAt && t < hit.reuseUntil
      ? hit.token
      : undefined;
  }

  get(key: CacheKey, now: Date, mint: () => { token: string }): string {
    const reusable = this.peek(key, now);
    if (reusable) return reusable;
    const id = idOf(key);
    const t = now.getTime();
    const { token } = mint();
    this.entries.set(id, {
      token,
      mintedAt: t,
      reuseUntil: t + key.ttlSec * 1000 * REUSE_SHARE,
    });
    return token;
  }
}
