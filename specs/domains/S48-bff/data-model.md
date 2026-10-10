# Data Model: S48 BFF composition

The BFF owns **no table, model or migration** (X.8.1, AS-64). Everything below is a Redis record, an in-process structure, or a contract shape. Redis key prefixes are owned by this capability; none shares an instance policy with queue data (no `allkeys-*` eviction for `bff:sess:*`).

## Session store (Redis)

| Key | Value (encrypted unless noted) | TTL | Written by |
|---|---|---|---|
| `bff:sess:{sha256(cookie)}` | `SessionRecord` | `min(idleExp, absoluteExp) − now` | login, MFA success, refresh, touch (≤ 1/min) |
| `bff:mfa:{sha256(mfaCookie)}` | `PendingMfa` | 300 s | login with second factor |
| `bff:mfa-lock:{sha256(mfaCookie)}` | owner token (plain) | 10 s | MFA verify |
| `bff:refresh:{sha256(cookie)}` | owner token (plain) | 5 s | refresh holder |

### SessionRecord
| Field | Type | Rule |
|---|---|---|
| `v` | `1` | format version |
| `sessionId` | string | S01 session ID (for logout and revoke) |
| `user` | `{id, email \| null, role}` | `role` ∈ `USER SELLER MODERATOR ADMIN` (S01) |
| `accessToken` | string | S01 access token (ES256, 300 s); never leaves the server |
| `accessExp` | epoch ms | `issuedAt + expiresIn × 1000` |
| `refreshToken` | string | rotated at each refresh; presented at most once |
| `tokenVersion` | int ≥ 1 | +1 per successful refresh; guards the compare-and-set write |
| `createdAt`, `lastSeenAt` | epoch ms | `lastSeenAt` rewritten at most once per minute |
| `idleExp` | epoch ms | `lastSeenAt + 24 h` |
| `absoluteExp` | epoch ms | `createdAt + 30 d` |

State: `ACTIVE` = record present and not expired; `ENDED` = record absent (deleted at expiry, refresh rejection, store-write exhaustion, logout, relogin). `PENDING_MFA` is the separate `bff:mfa:*` key, never a session. Cookie value = 32 random bytes, base64url; the store never holds it.

Transitions (all conditional):
- `login` ok → `ACTIVE` (new cookie; old record deleted first; old identity session revoked best effort).
- `login` with second factor → `PendingMfa` created (new `__Host-bff-mfa`); no session.
- `mfa verify` ok → `ACTIVE`, `PendingMfa` deleted; wrong code → unchanged; spent/expired challenge → `PendingMfa` deleted.
- `use` → idle extension ≤ 1/min, never past `absoluteExp`; past either deadline → `ENDED`.
- `refresh` ok → `tokenVersion + 1` (compare-and-set); `401 invalid_refresh_token` → `ENDED`; transient failure → unchanged; 3 failed writes → `ENDED`.
- `logout` → `ENDED` (idempotent).

### PendingMfa
`{mfaToken, createdAt, clientIp}`; the challenge token is never sent to the browser. Expires 5 min after `createdAt`.

### Encoding
`kid "." nonce "." ciphertext "." tag`, all base64url; AES-256-GCM; AAD = the store key, so a record copied under another key fails to decrypt.

## Shaped-response cache (Redis)

`bff:cache:{endpoint}:{sha256(method + url)}` → validated upstream body (JSON) + `storedAt`. TTL `min(s-maxage, 30 s)`; written only for shared-cacheable endpoints that carried no identity and answered `public`/`s-maxage`. Never the source of truth (a miss or a Redis error means "call upstream").

## In-process structures (per instance, per request)

| Structure | Lifetime | Notes |
|---|---|---|
| `SectionDefinition` registry | static | name, `required`, `budgetMs`, `dependsOn`, `identity`, `sharedCache`, `anonymousId`, `applies`, `call`, `shape` |
| `SectionOutcome` | one page request | `ok` \| `skipped` \| `{code, retryable}`; also duration for `Server-Timing` |
| `BreakerState` per upstream | process | `{state, consecutiveFailures, windowStart, openedAt, probeInFlight}` |
| `ConcurrencyGate` per upstream; per page request | process; request | counters 100 / 12 |
| Loader set `{products, shops}` | one GraphQL request | created in the Apollo context; carries the request's credentials, deadline and abort signal |
| Trusted documents | startup | `Map<sha256, document>`; immutable |
| Single-flight map | process | key → promise; removed on settle |

## Contract shapes (in `packages/contracts/src/bff/`)

| Schema | Shape |
|---|---|
| `productPageResponseSchema` | `{product: productPublic, shop: {id,name,slug}\|null, recommendations: recommendationsResponse\|null, trending: trendingResponse\|null, flags: flagsBody\|null, chatUnread: chatUnreadPage\|null, discussions: boardPostsPage\|null, videos: productVideos\|null, pickup: pickupPage\|null, flashSale: flashSalePublic\|null, auction: auctionPublic\|null, errors: SectionError[]}` |
| `SectionError` | `{section: one of the ten optional names, code: one of 8, retryable: boolean}` (strict: no other keys) |
| `pageQuerySchema` | `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]` (both or neither), `radiusKm` int 1–100 default 10; strict |
| `sessionLoginRequestSchema` | `{email, password}` strict, body ≤ 16 KB |
| `sessionMfaRequestSchema` | `{code}` strict (string of the S02 code length bounds) |
| `sessionResponseSchema` | `{user: {id, email\|null, role}, expiresAt: ISO-8601}` |
| `mfaRequiredResponseSchema` | `{mfaRequired: true}` |
| GraphQL error codes | `QUERY_TOO_DEEP QUERY_TOO_COSTLY TOO_MANY_ROOT_FIELDS BAD_USER_INPUT INTROSPECTION_DISABLED PERSISTED_QUERY_NOT_FOUND UPSTREAM_* CIRCUIT_OPEN BUDGET_EXCEEDED` |
| Upstream schemas added only if missing | flags body (S38), `chatUnreadPageSchema` (S24), board posts page (S25), pickup page (S19), `flashSalePublicSchema` (S11), `auctionPublicSchema` (S21), `productVideosSchema` (S30) |

## Validation rules (where they live)

- Path `productId`: UUID (`400 validation_failed`, no upstream call).
- `X-Anonymous-Id`: `^[A-Za-z0-9_-]{8,64}$`, otherwise dropped silently (not an error).
- Both session cookie and `Authorization`: `400 ambiguous_credentials`.
- GraphQL `ids`: UUIDs, ≤ 50, `first` ≤ 50; request-level limits per FR-033.
- Configuration (`bff-config.ts`): upstream origin is an absolute `http(s)` URL with no path-embedded credentials; at least one session key of 32 bytes; allowed origins non-empty in production; budgets positive integers; the sum rule `pageDeadline ≥ productBudget`.
