# Research: S37 share links

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted. Each entry is a decision the plan relies on. "Check" marks a fact the first task that depends on it must confirm in the running code (not assumed).

## R-1 Layering: ports in `domain/`, adapters in `infra/`
**Decision**: `LinkRepository`, `CodeSequence`, `ExistenceFilter`, `LinkCache`, `ClickPublisher`, `ClickStatsReader`, `DestinationReputation` as interfaces with injection tokens in `domain/ports.ts`; `Clock` from `@app/common/core/clock` (`CLOCK` token). `application/` injects tokens only. **Rationale**: pays D-6 (L1), lets e2e wrap one adapter with a failure/delay injector without mocking the project's own stores (VII.9). **Alternatives**: keep concrete classes and spy (rejected: hides wiring errors, L-015); a generic repository base (rejected: three stores with different semantics).

## R-2 Code scheme stays; failure modes become typed
**Decision**: keep `scramble`/`toBase62` (40-bit Feistel, 4 rounds, HMAC-SHA256 rounds). Add `CodeSpaceError` for numbers outside `[0, 2^40)` mapped to `503 code_generation_failed` after the retry budget (G22). Counter loss or key change shows up as a collision and is absorbed by the retry (R-3). **Rationale**: the maths already satisfies AS-05 (non-adjacency > 1,000, reversible, keyed); the defects are around it. **Alternatives**: random codes with retry (rejected: loses the P1109 pattern and the collision-free guarantee); 42 bits (impossible: 2^42 > 62^7, `questions.md` LOCAL).

## R-3 Create ordering and collision handling
**Decision** (per FR-005/007): validate → destination policy → reputation (2 s) → owner count reservation → obtain code (alias path: format and reserved check first, **no number is consumed**; generated path: next number) → `filter.add(code)` → conditional `PutItem` `attribute_not_exists(code)`. Generated collision: new number, ≤ 5 attempts, `link_code_collision_total`, then `503 code_generation_failed`. Alias collision: `409 alias_taken`. On any failure after the owner reservation, the reservation is released by a compensating conditional decrement (best effort; the reconcile in the rebuild job corrects drift, R-6). **Rationale**: the filter entry before the visible link is the only order that cannot hide a link (G9). **Check**: DynamoDB Local honours `ConditionExpression` on `PutItem` (used today).

## R-4 Redirect resolution and caching
**Decision**: `resolveRedirect(code, meta)` returns `{kind:'redirect', location, click} | {kind:'not_found'} | {kind:'gone'} | {kind:'unavailable', retryAfter:5}`. Cache entry stores the link row; a miss is a distinct sentinel (60 s); a store error throws out of the loader so `CacheService.getOrLoad` stores nothing (G10). **Check**: confirm in `cache.service.ts` that a throwing loader is not cached and that stale-while-error serves a stale entry (AS-34); if it does not, the cache wrapper in `infra/redis-link.cache.ts` adds it (≤ 24 h). Store timeout 500 ms through `AbortSignal` on the Dynamo `send`. Change/disable `invalidate`s the key in the same operation (FR-048, AS-55); claiming an alias invalidates a remembered miss (AS-23, exists today).
**Headers**: `302` `public, max-age=0, s-maxage=10`; `410` `public, s-maxage=60`; `404` `no-store`; `503` `Retry-After: 5`. `HEAD` is routed explicitly and never reaches the click path; other methods `405` (Nest `@All` is not used; a tiny method guard on the path).

## R-5 Idempotency: platform record, guard for the 400
**Decision**: `@Idempotent({ ttlSeconds: 86400 })` from `@app/infrastructure/idempotency`. The platform answers a missing or malformed key with `422 idempotency_key_required|invalid` and accepts only letters, digits, `_`, `-`; the spec (AS-02, FR-010) says `400 validation_failed` naming the header, length 8–128. A route guard (guards run before interceptors) validates presence and 8–128 length and throws the shared validation error; the platform's charset rule then still applies (a key with other characters gets the platform `422`; documented in `contracts/share-links-api.md`). `409 idempotency_in_flight`, `422 idempotency_key_reuse` and `Idempotency-Replayed: true` are the platform's. **Check**: replay header name and per-user scoping in `idempotency.interceptor.ts`; the 24 h expiry is tested with the frozen clock if the repository reads the clock, else by the repository's expiry column (AS-09). **Alternatives**: accept the platform's `422` and change AS-02 (rejected: spec says 400; changing a human-readable contract is not this plan's call); implement a private idempotency store (rejected: S54 supplies it).

## R-6 Link table: purge attribute, owner counter, byOwner
**Decision**: item `{code, ownerId, kind, destination, status, createdAt, updatedAt, expiresAt?, disabledAt?, purgeAtEpoch?}`; `TimeToLiveAttribute` moves from `expiresAtEpoch` to `purgeAtEpoch` (expiry or disable + 13 months, set at create for expiring links and at disable); `expiresAt` is stored as an ISO string and compared by the clock (`now >= expiresAt`), with `expiresAtEpoch` kept off the item. Owner counter: item `{code: "#owner#<ownerId>", activeCount}` in the same table; create does `TransactWriteItems` {Put link (condition not exists), Update counter `ADD activeCount 1` with `activeCount < :max`} — one atomic step for the limit (AS-12, III.6). Disable decrements in the same transaction as the status update. Expiry frees a place lazily and exactly: when the conditional increment fails (`activeCount >= max`), create recounts the owner's links from `byOwner` (status `ACTIVE` and `expiresAt` in the future, at most `max + 1` rows read), writes the true value with a conditional set on the old value, and retries the increment once; a still-full owner answers `422 link_limit_reached`. The rebuild job runs the same recount for owners whose counter drifted (compensation failures). `byOwner` GSI sort key becomes `createdAt#code` (`sk`) for a total order; keyset cursor encodes `(createdAt, code)` signed with the code key's derived HMAC subkey (tamper → `400 invalid_cursor`). **Check**: DynamoDB Local supports `TransactWriteItems`; the GSI change is expand-only (add `sk`, new index `byOwnerV2`, old kept until rows are backfilled by the job). **Alternatives**: count by query at create (rejected: racy and slow, AS-12 needs exactly-one-of-two); Redis counter (rejected: not in the link store, III.6).

## R-7 Click path and graceful drain
**Decision**: `ClickPublisher.publish(event)` returns void, adds the send promise to an in-flight set, retries ≤ 2 off the request path with 50/200 ms delays, increments `link_click_publish_failed_total` once on final failure and logs one warning with `code` and error class only. `OnApplicationShutdown` awaits the set for ≤ 5 s (FR-102, AS-37). The event is built by pure `buildClick(code, meta, now, uuidv7)` in `domain/` (AS-38, AS-39). Edge flag: header `x-edge-click-recorded: 1` plus `x-edge-credential` compared with `timingSafeEqual` to `share_link_edge_secret` (G14). **Check**: producer timeout settings in `kafka-producer.service.ts` (a hang must not hold the response; the publish is not awaited).

## R-8 Click consumer and exact counts
**Decision**: the consumer is a `Projector` (`name: 'link-clicks'`, `idempotency: 'natural'`, `handles: [{event: LinkClicked}]`) in `ShareLinksProjectorModule`. The framework validates and dead-letters malformed and unknown-version envelopes (S53); the consumer additionally rejects `ts` more than 5 minutes ahead by throwing the framework's non-retryable error class (**Check** `consumer-error-classification.ts` for the class name) so the message reaches the dead letter with a reason. Insert into `link_clicks` (ReplacingMergeTree, ordering `(code, ts, click_id)`). Statistics read `uniqExact(click_id)` grouped by `toStartOfMinute|Hour|Day(ts)` and by country from `link_clicks` (never from the summing view, which counts redelivered inserts, G17). `link_clicks_minute*` stay for S39 consumers but are not read by stats; a follow-up note removes them later (not in S37 scope; no other reader found: **Check** `grep link_clicks_minute`). Dedup at read time is bounded: range ≤ 30 days of one code. **Alternatives**: `FINAL` (rejected: slower and still wrong across partitions before merge in some settings); insert dedup token per batch (rejected: does not cover a redelivery in a different batch); inbox table (rejected: PostgreSQL write per click).
Consumer lag gauge: framework metric `consumer lag` re-exported as `link_click_consumer_lag` via the existing `consumer-lag.ts` hook (**Check** how it labels).

## R-9 Attribution lookup (R1)
**Decision**: `LinkAttributionService.resolveAttributions(codes)`: dedupe, drop malformed, `> 100` → `TooManyCodesError` (checked on the raw input length), `[]` → `{}`; one `BatchGetItem` (≤ 100 keys, with `ProjectionExpression` of `code, ownerId, status, expiresAt`); status derived through `link-state.ts` with the clock; store failure → `AttributionUnavailableError`. No cache (checkout volume is low, and a cache would add staleness to a money-adjacent read). Exported errors and the service from the barrel.

## R-10 Stats authorisation
**Decision**: stats, `PATCH`, disable load the link by `(code)` then require `ownerId` equality inside the repository call (`GetItem` with the owner compared in the adapter, returning `null` for a foreign link; the controller cannot see the difference), `404 link_not_found` with identical body (FR-083, AS-56). Conditional updates add `ownerId = :owner` to the `ConditionExpression`, so there is no window between check and write (III.4).

## R-11 Filter ready marker and rebuild
**Decision**: Redis key `share-links:bloom:ready` (no TTL) is set last by the rebuild; `ExistenceFilter.mightContain` returns `true` plus bumps `link_filter_bypassed_total` when the marker is absent or Redis errors. `add` always runs (also before ready) so new codes are in the filter once it becomes ready. Rebuild takes a lock `SET share-links:bloom:lock NX PX 600000` (second concurrent rebuild is a no-op, AS-33), deletes nothing, scans the table with `Scan` pages (rebuild runs rarely, off peak), adds codes, then sets the marker, then releases. S49 schedules it every 10 minutes as a cheap no-op when ready (the job checks the marker first; a daily forced run is out of scope). **Check** the bloom implementation exposes `add` for batches (`RedisBloomFilter.add([code])` today).

## R-12 Configuration validation
**Decision**: new keys in the joi schema (`api-config.service.ts`) and rules in `config-rules.ts` (existing mechanism, `config-rules.spec.ts` shows the shape): `share_link_code_key` ≥ 32 bytes, differs from `jwt_secret` and the ad click secret (name checked in `ads.service.ts`); `share_link_base_url` absolute https; `front_host` absolute https origin; `share_link_max_per_owner` positive integer (default 1000); `share_link_edge_secret` ≥ 32 bytes; `share_link_reserved_aliases` comma list (default 13 words, entries < 4 chars ignored). `share_link_secret` is removed from `share-link.service.ts`; it stays declared while `notifications-config.ts:43` and S36 still read it — sibling bullet for S36. The test config (`api-config.service.mock.ts`) gets valid values.

## R-13 SITE_URL equals `front_host`
**Decision**: the web app's `SITE_URL` (`packages/web/lib/config-parse.ts`) and the backend's `front_host` must name the same origin; the backend refuses to start on a non-https or path-bearing `front_host`, and the quickstart lists the equality as a deploy prerequisite with the one-line check. S37 sets no cookie; W02's `POST /api/attribution/ref` writes `__Host-ref` on the storefront origin, which only works because the short link lands on that origin with `?ref=<code>`.

## R-14 Edge worker
**Decision**: restructure `shortLinkRedirect` to: `cache.match` → if hit, answer and `waitUntil(sendClick)`; else fetch origin with `x-edge-click-recorded: 1` and `x-edge-credential: env.SHARE_LINK_EDGE_SECRET`; only if the origin status is `302` do `cache.put` and `sendClick`; everything else passes through. Click id `uuidv7` (small local implementation or the `uuid` package if already a dependency of `edge-be`; **Check** `packages/edge-be/package.json`); referer reduced to its origin by a copy of the pure function (the worker cannot import backend code; a parity test compares both implementations over the AS-39 table). Envelope `version: 1`, `occurredAt`. Cache lifetime comes from the origin's `s-maxage`.

## R-15 Rate limit and policy names
**Decision**: `rate-limit-policies.ts` in `marketing` declares `share-link.create` (tokenBucket, 20 per 60 s, `key: 'user'`, `failMode: 'closed'`) via `definePolicies('marketing', …)`, copied from the S25 pattern, and augments `PolicyNameRegistry`. `@RateLimit('share-link.create')` replaces `discussion.write`. Limiter store down → `503 rate_limiter_unavailable` (platform) on create only.

## R-16 Gap traceability

| Gap | Where in the plan |
|---|---|
| G1 | R-5, T30 |
| G2 | contracts, T33 |
| G3 | R-3, `alias-rules`, T12, T34 |
| G4 | R-3, T32 |
| G5 | R-12, T02 |
| G6 | `destination-policy`, reputation port, redirect re-check, T10, T26, T44 |
| G7 | R-6, T21 |
| G8 | R-15, T05 |
| G9 | R-3, R-11, T22, T53 |
| G10 | R-4, T23, T42 |
| G11 | R-6, `link-state`, T13, T41 |
| G12, G13 | R-4, T40, T43 |
| G14 | R-7, T45 |
| G15 | R-7, `click-meta`, T11, T50 |
| G16 | R-14, T70–T72 |
| G17 | R-8, T51 |
| G18 | R-6, T60 |
| G19 | R-8, R-10, T63 |
| G20 | R-6, R-10, T61 |
| G21 | R-12, T80 |
| G22 | R-2, T15, T24 |
| G23 | contracts, T01 |
| G24 | `link-errors`, T35 |
| G25 | five e2e files, T36, T47, T55, T65, T85 |
| L1–L7 | R-1, T20, T14, T40, T81, T82, T05/T84 |
