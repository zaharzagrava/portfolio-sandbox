# Research: S27 design decisions

Each entry: Decision / Rationale / Alternatives. No unknown from the spec remains open; questions.md defaults are accepted.

## R1 Deployment shape
- Decision: keep `content` as modules in `apps/api`, `apps/worker` (jobs) and `apps/projector` (consumers); the barrel exports Nest modules only.
- Rationale: I.6 needs a written reason for a new app; none exists. Closes D-8.
- Alternatives: dedicated "content" app — rejected, no different scaling profile (CDN absorbs reads).

## R2 Concurrency
- Decision: drafts use a `revision` column and `UPDATE … WHERE shopId AND storyId AND locale AND revision = $expected` (insert path for revision 0 uses a unique key and maps the violation to `revision_conflict`). Publish/schedule/archive/fire lock the `Story` row (`SELECT … FOR UPDATE` carrying `shopId`) inside one `TransactionRunner` unit, compare `expectedVersion` to `publishedVersion`, then write.
- Rationale: exactly one winner, gapless versions, status and last event cannot disagree (AS-83).
- Alternatives: advisory locks (hidden state), `max(version)+1` (today; no precondition).

## R3 Idempotency of publish
- Decision: platform `@Idempotent` (S54 facility, 24 h, scope per shop) on publish and schedule; replay, in-flight, reuse errors come from the toolkit.
- Alternatives: own table — rejected, duplicates a platform facility.

## R4 Network I/O ordering
- Decision: the S05 product check (2 s timeout) runs before opening the transaction; no Redis/CDN call inside a transaction; after commit the origin `DEL` is best-effort (error logged, counted, never fails the 200); correctness relies on the 60 s TTL and the consumer's second clear.
- Rationale: III.x no I/O in transactions; closes B10. Product check races (product deleted between check and commit) are accepted: the story is served, the front end composes (spec edge case).
- Alternatives: check inside the lock — rejected, holds a row lock across a network call.

## R5 Schedule
- Decision: `Story.scheduledAt` is an attribute; job key `story-publish:<id>:<scheduledAt>`; handler publishes only if `scheduledAt` equals the payload and `scheduledAt <= now` (clock port), under the row lock. Sweep (`stories.publish-due-sweep`, cron every minute, single-run) selects due rows `ORDER BY scheduledAt, id LIMIT 100 FOR UPDATE SKIP LOCKED` and runs the same publish routine. Permanent codes throw `NonRetryableJobError`; the handler records `scheduleFailure` and `story.schedule_failed` in one transaction; exhausted transient retries map to `publish_failed`.
- Rationale: a lost job delays ≤ 2 min (SC-002); SKIP LOCKED makes concurrent sweeps safe. Past schedules are refused so a stale job cannot fire early.
- Cancel: use the discriminated `JobsService.cancel` result; a stale job is a no-op regardless, cancel is hygiene.

## R6 Read model and single flight
- Decision: key `story:pub:<shopSlug>:<slug>` holding all locales of the published version (so fallback needs no second read), TTL 60 s, loaded through `CacheService.getOrLoad` (single flight, store-unavailable falls back to loader, per S52 `CacheUnavailable`). Visibility = `StoryShop.status = ACTIVE` ∧ `Story.status = PUBLISHED`, evaluated against the durable load, so a suspended shop is `404` within one TTL and at once after the consumer clears.
- Alternatives: per-locale keys (N reads on fallback), 1 h TTL (today; violates "within a minute").

## R7 HTTP caching
- Decision: `withEtag(body, '"<id>-v<version>-<locale>"')` + `buildCacheControl({ public, sMaxAge: 300, staleWhileRevalidate: 86400 })`; 404 problem+json carries `public, s-maxage=10`. `Cache-Tag` set by the controller on 200 only. `HEAD` handled by the same route.
- Rationale: S52 interceptor already answers 304 for list/weak/`*` and keeps handler headers; deletes the controller's `===` compare (C2).

## R8 Invalidation consumer
- Decision: `Projector` (S53) on `stories.events` with `idempotency: 'inbox'` semantics for the success record, but the processed record is written only after both targets succeed (AS-53); steps: origin DEL, CDN purge (chunks of 30, 3 in-call retries, full jitter, 5 s timeout via the resilient HTTP client), signed webhook; both targets always attempted, error rethrown after. CDN 4xx other than 429 → `PermanentError`. Attempts = 8. Payload validated with zod; invalid → `PermanentError` (DLQ with reason). Batch: tags de-duplicated over the whole delivered batch (AS-52). Webhook signature in `domain/revalidation-signature.ts`: `HMAC-SHA256("<ts>.<raw body>")`, timestamp from the clock port.
- Adapters: production requires `CDN_ZONE`, `CDN_TOKEN`, `REVALIDATE_SECRET`, `STORY_PREVIEW_SECRET` (config validation fails start-up, names the key, never the value); elsewhere logging adapters. The existing `infra/delivery-edge` port is reviewed for reuse of the CDN purge adapter; if its contract fits tags it is wrapped, otherwise a small `cdn-purger.ts` is added.

## R9 Shop identity
- Decision: `StoryShop(shopId PK, slug, status, shopVersion)` upsert `WHERE excluded.shopVersion > StoryShop.shopVersion`; `shop_status_changed` before `shop_created` creates the row with unknown slug allowed only if the event lacks it — to avoid a row without slug, status events for an unknown shop fetch once via R1 `getShopsByIds` (rule FR-062) and are otherwise parked by retry. `shop_deleted`: batched deletes (drafts, versions, transitions, stories by `shopId`, 500 rows per statement), then the copy row last so redelivery resumes; origin keys cleared by slug; tag `shop:<id>` purged through the invalidation path.
- Rationale: IX.7 R3; `ShopQueryService` import is the only tenancy dependency in write path.

## R10 Preview token
- Decision: HS256 pinned, `aud: story-preview`, claims `{sid, shop, loc, exp, iat}`, 30 min from the clock, key `STORY_PREVIEW_SECRET`. Verification errors collapse into one `404 story_not_found` with `Cache-Control: no-store`; logs never include the token (redaction test).
- Alternative: reuse session JWT — rejected (confusable).

## R11 Sitemap
- Decision: `Story.sitemapPosition bigint` from a Postgres sequence, assigned at first publish (`COALESCE`), never reused. Page *n* = positions `[n*2500+1, (n+1)*2500]`, keyset by `sitemapPosition` in batches of 1,000 joined with `StoryShop` for slug/status and the current version's locales. Index: `max(sitemapPosition)` over published rows (one indexed lookup, no count). Stream as an async generator piped through `Readable.from` with `pipeline`; first batch is read before headers are sent so a pre-stream failure is a 503; mid-stream failure destroys the socket; `close` aborts the generator.
- Alternatives: offset (forbidden III.10), pages by published rank (unstable AS-72).

## R12 Migrations
- Decision: expand first (additive columns/tables/sequence, `lock_timeout`), code switches, contract second (drop FK; replace status check removing `SCHEDULED`; migrate any `SCHEDULED` rows to their prior status plus `scheduledAt` in a batched backfill). Backfill `sitemapPosition` for already-published stories in keyset batches ordered by `createdAt, id`.

## R13 Rate limit
- Decision: `content.write.shop` (sliding window 120/min, key `shop`, fail closed) checked in the service layer like `asset-library`, so it holds in every app; reads and public routes exempt (public: `Firewall({anonymous:true})`, no `skipThrottle` shortcut but a generous IP policy is out of scope).

## R14 Video block hosts (S30)
- Decision: parse with `URL`; require `https:`, no username/password, default port, host exactly in the allowlist; for `stream.marketplace.dev` the path must match `^/p/<uuid>/master\.m3u8$`; `/u/` paths, any query and fragments are rejected so no signed credential is ever stored.
