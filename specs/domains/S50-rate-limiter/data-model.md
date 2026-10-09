# Data model: S50

The lib owns **no database table**. All state is in the shared Redis under the `rl:` prefix (the legacy `throttle:` prefix is abandoned and expires). Every item has an expiry (FR-011). One hash tag per decision: `{<policy>|<subject>}` (FR-013, AS-73).

## Stored items

| Item | Key | Fields | Expiry | Written by |
|---|---|---|---|---|
| Token bucket | `rl:{p\|s}:tb` (hash) | `tokens`, `ts` (store ms), `paused_until` | `ceil(limit/rate)` to full + 1 s; pause: until + 1 s | decision, refund, penalize |
| Sliding window | `rl:{p\|s}:sw:<index>` (string counters, current and previous) | count | 2 × `windowMs` | decision, refund |
| Concurrency | `rl:{p\|s}:cc` (sorted set, member = lease id, score = expiry ms) | — | 2 × lease length | acquire, release |
| Script digests | in-process only | sha per script | — | loader |

`reset(policy, subject)` deletes the subject's items. No scan, no `KEYS` (FR-011). Subjects never contain e-mails, tokens or API-key secrets (AS-52).

## In-process state (bounded)

| Structure | Bound | Notes |
|---|---|---|
| Fallback buckets | 50,000 subjects, LRU | token-bucket share of `limit / rate_limit_fallback_instances` |
| Fallback semaphores | same bound | concurrency policies in fail-open |
| Local leases | one per hot key, lifetime `rate_limit_lease_ttl_ms` (1 s) | only token bucket, cost 1, fraction set |
| Denial memo | one per key, `min(retryAfterMs, 1 s)` | |
| Breaker | one per process | closed / open-until / probing |
| Registry | policies + exempt routes | built at startup, immutable |

## Entities (types)

- **Policy** `{ name, algorithm: 'tokenBucket'|'slidingWindow'|'concurrency', limit, windowMs, key: 'ip'|'user'|'userOrIp'|'apiKey'|'shop'|'body.email'|'custom', failMode: 'open'|'closed', localLeaseFraction?, count?: 'failures-only', resetOnSuccess?, failureStatuses? }`. Validation (AS-69): name grammar `<area>.<name>[.<q>…]` in `[a-z0-9-]`; positive integer `limit`/`windowMs`; fraction in `(0, 0.5]` and only for token bucket; `failMode` present; `count` only with a key that can fail (and `failureStatuses` ⊆ 4xx/5xx); `custom` requires an extractor at the decorator; all offences reported together.
- **Subject** string `ip:…|user:…|key:…|shop:…|email:<32 hex>|custom:<≤128 or sha>`.
- **Decision** `{ allowed, policy, limit, remaining, retryAfterMs: number|null, resetMs, source: 'store'|'local-lease'|'fallback', reason?: 'limit-exceeded'|'store-unavailable'|'cost-exceeds-limit'|'paused' }`.
- **Lease** `{ id, expiresAtMs, release() }` (concurrency); release is idempotent and frees only its own id.
- **Pause**: the `paused_until` field above.

## State transitions

- Token bucket: `full ⇄ partial ⇄ empty`; `empty --penalize--> paused(until T) --T--> empty refilling`; a refund moves `partial → fuller` (≤ capacity); lowering `limit` clamps tokens on read (AS-83).
- Sliding window: count increments only on admission; refund decrements the current key (≥ 0); `reset` clears both keys.
- Concurrency: `free → leased → (release | expiry) → free`; double release is a no-op.
- Breaker: `closed --3 consecutive failures--> open(2 s) --expiry--> probing --success--> closed | --failure--> open`.
