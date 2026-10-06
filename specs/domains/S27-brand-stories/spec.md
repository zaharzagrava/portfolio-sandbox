# Feature Specification: S27 — Brand stories CMS (versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap)

**Feature Branch**: `S27-brand-stories` (spec directory only; no branch created)

**Created**: 2026-10-05

**Status**: Draft

**Domain**: `content` (capability S27 of `scripts/sdd/capabilities.tsv`)

**Input**: Write the specification for capability S27 — Brand stories CMS: versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap. Sources: `docs/showcase/sections/SD-05-cms-brand-stories.md`, `10-System-Design/04-web-platform-architectures.md` §5 (Content site / CMS), the constitution v3.1.0, `docs/architecture/domain-map.md` (`content`), and `docs/architecture/pattern-map.md` rows P0207, P0410, P0501 and P0904.

## Scope

**In scope**

- Brand staff (members of a shop) create stories, write one draft per locale, and see their drafts, versions and status.
- Rich-text and structured blocks are validated and sanitised when they are written, so a compromised brand account cannot inject script into the storefront (P0501).
- Publishing freezes all locale drafts into one immutable, numbered version (now, or at a future reveal time), with optimistic concurrency, idempotent replay and a scheduled-publish safety net.
- Archiving a story (take-down), reading version history, and restoring an old version into the drafts (rollback is a republish).
- The anonymous public read API served behind a CDN: cache headers, ETag and conditional requests, locale in the path with a fallback chain, `hreflang` data, and an origin read model (P0410).
- Cache invalidation by tag when a story changes: origin read model, CDN purge by cache tag, and a signed revalidation call to the Next.js front end (P0904).
- Signed, short-lived preview of draft content that bypasses every cache.
- A streamed sitemap index and child sitemaps for millions of URLs (P0207).
- The shop identity copy this capability needs (slug and status), kept from tenancy events (IX.7 R3), and purging of a deleted shop's stories.

**Out of scope (owner)**

- Shops, memberships, roles, permissions and shop status → S03. S27 uses S03's guard and events.
- Product data and prices → S05. S27 stores only product IDs in blocks and checks them at publish through S05's exported batch query.
- Identity, sessions and the `Firewall` → S01. Rate-limit mechanics → S50. Job scheduler → S49. Event envelope, outbox, consumers → S53. Cache toolkit and conditional-GET plumbing → S52. Problem+json, config, HTTP client → S54.
- The web pages that render a story (`/<locale>/brands/<shopSlug>/stories/<slug>`), the Next.js revalidation endpoint, the CSP of rendered pages, and the staff editor UI: no web capability owns them today (see `questions.md`). This spec defines the backend half only.
- Image upload and transformation (S29), a public "list a shop's stories" endpoint (a later R2 composition), comments, personalisation, A/B variants, story deletion (archive is the take-down), and a story's own tags or categories.

## User Scenarios & Testing *(mandatory)*

Notation: **S** is a shop, **E** a staff member of S with `products.write`, **V** a viewer of S (`products.read` only), **O** a member of another shop. The clock is frozen in tests. "Persisted state" always means the durable rows, the outbox rows and the origin cache entries, as the test plan asserts.

### User Story 1 — Write a story in several locales (Priority: P1)

E creates a story, writes one draft per locale (heading, rich text, image, product, quote and video blocks), and can reopen and keep editing it. Two editors never silently overwrite each other.

**Why this priority**: nothing else exists without stories and drafts, and unsafe or lost content is the main CMS failure.

**Independent Test**: create a story, save a draft in `en` and `uk`, read them back through the staff detail, and prove that malformed blocks, executable markup and stale edits are refused.

**Acceptance Scenarios**:

1. **AS-01** — **Given** shop S, **When** E sends `POST /shops/S/stories {slug:"inside-iphone-18", defaultLocale:"en"}`, **Then** `201` with `{id, shopId, slug, defaultLocale, status:"DRAFT", publishedVersion:null, scheduledAt:null, scheduleFailure:null, createdAt}`, one story row exists, one status-history row records the creation, and no event is emitted; an omitted `defaultLocale` is stored as `en`.
2. **AS-02** — **Given** shop S, **When** E sends a slug that is uppercase, shorter than 2 or longer than 81 characters, starts with `-`, or contains `_`, `/` or a space; or a `defaultLocale` that is not `xx` or `xx-XX`; or an unknown body property; or no body, **Then** each answers `400 validation_failed` listing the offending fields, and no row is created.
3. **AS-03** — **Given** S already has a story with slug `inside-iphone-18`, **When** E creates the same slug again, **Then** `409 slug_taken` and no row is added; **When** shop S2 creates the same slug, **Then** `201`; **When** 10 identical creates for a new slug run concurrently, **Then** exactly one `201` and nine `409 slug_taken`, and exactly one row exists. A slug is permanent: no endpoint changes it.
4. **AS-04** — **Given** S holds the maximum number of stories (limit 5,000, overridden to 3 in the test), **When** E creates another, **Then** `422 story_limit_reached {limit}` and no row is created; archived stories count.
5. **AS-05** — **Given** a story with no drafts, **When** E sends `PUT /shops/S/stories/ID/drafts/en {title, blocks, seo, expectedRevision:0}`, **Then** `200 {locale:"en", revision:1, title, blocks, seo, updatedAt}`; **When** E sends the same route with `expectedRevision:1`, **Then** `revision:2`; `GET /shops/S/stories/ID` returns every draft with its `locale`, `revision`, `title`, `blocks`, `seo`, `updatedAt`, plus `status`, `publishedVersion`, `scheduledAt` and `scheduleFailure`.
6. **AS-06** — **Given** a `richText` block whose HTML mixes allowed and hostile markup, **When** it is saved, **Then** the stored and returned HTML is sanitised against the allowlist (`p br strong em a ul ol li h2 h3 blockquote`; on `a` only `href` with `https:` and `rel`): a `<script>` element and its content, `javascript:` and `data:` links, `on*` attributes, `style`, `<iframe>`, `<img onerror=…>` are gone, and every remaining link carries `rel="noopener"`; for the input `<p>Titanium. <script>alert(1)</script><a href="javascript:x()">x</a><a href="https://apple.com" onclick="steal()">site</a></p>` the result contains `<a href="https://apple.com" rel="noopener">site</a>` and none of `script`, `javascript:`, `onclick`; sanitising the stored result again changes nothing.
7. **AS-07** — **Given** a title `<img src=x onerror=alert(1)>` and a quote text `"><b>`, **When** saved and read through any endpoint, **Then** both come back byte for byte as JSON strings (never HTML-escaped, never interpreted by the server), responses carry `Content-Type: application/json` and `X-Content-Type-Options: nosniff`, and `html` of `richText` blocks is the only field that ever carries server-produced markup. Clients render every other field as text.
8. **AS-08** — **Given** an existing draft at revision 3, **When** E saves a draft with each of these defects, **Then** each is refused, nothing is stored and the revision stays 3: `422 invalid_blocks {issues:[{path, code}]}` (at most 10 issues, never echoing the value) for an unknown block `type`, more than 200 blocks, heading `level` 4, `richText` over 20,000 characters, an `image` with an `http:` URL, no `alt`, an `alt` over 300 characters or non-positive `width`/`height`, a `product` with a non-UUID `productId`, a `video` whose parsed host is not exactly `www.youtube.com`, `player.vimeo.com` or `stream.marketplace.dev` (including `https://www.youtube.com.evil.example/x`, `https://www.youtube.com@evil.example/x`, credentials and non-default ports), a `seo.ogImage` that is not `https:`, a quote over 500 characters; `422 invalid_title` for an empty or over-200-character title; `422 payload_too_large` when the serialised draft exceeds 256 KiB; `413` for a request body over 1 MiB; `400 validation_failed` for a non-array `blocks`, a missing `expectedRevision`, or an unknown property.
9. **AS-09** — **Given** a draft at revision 1, **When** two editors send `PUT …/drafts/en` with `expectedRevision:1` at the same moment, **Then** exactly one `200` (revision 2) and one `409 revision_conflict {currentRevision:2}`, and the stored draft is the winner's; **When** a request carries `expectedRevision:1` after the draft reached 2, **Then** `409 revision_conflict`; **When** a new locale is saved with `expectedRevision:1`, or an existing locale with `0`, **Then** `409 revision_conflict`.
10. **AS-10** — **Given** a story with 20 locale drafts (the limit), **When** E saves a 21st locale, **Then** `422 locale_limit_reached {limit:20}`; **When** the path locale is not `xx` or `xx-XX` (for example `EN_us`, `e`, `english`), **Then** `400 validation_failed`; saving to an existing locale is unaffected by the limit.
11. **AS-11** — **Given** drafts `en` (default, revision 2) and `uk` (revision 4), **When** E sends `DELETE …/drafts/uk?expectedRevision=4`, **Then** `204` and the draft is gone; a wrong revision answers `409 revision_conflict`; an unknown locale answers `404 draft_not_found`; **When** E deletes `en`, **Then** `409 default_locale_required` and the draft stays.
12. **AS-12** — **Given** 7 stories of S in several statuses and 2 stories of S2, **When** E and V call `GET /shops/S/stories?limit=3&cursor=` and follow `nextCursor`, **Then** pages of 3, 3, 1 stories are returned newest first with no duplicate and no gap, never including S2's stories, `nextCursor` of the last page is `null`, and `status=PUBLISHED` filters by status; an invalid `limit` (0, 101, `abc`) or a malformed or tampered cursor answers `400 validation_failed`; **When** V calls `GET /shops/S/stories/ID` (which returns draft content), **Then** `403 permission_denied`.

**Edge cases for this story**: concurrent creates and concurrent draft saves (AS-03, AS-09); limits (AS-04, AS-08, AS-10); executable markup (AS-06, AS-07).

---

### User Story 2 — Publish a story and serve it from the edge (Priority: P1)

E publishes: all drafts are frozen into version N, the story goes live, readers get it through the CDN with cache headers that make the CDN do almost all the work, and a change is visible to everyone within a minute.

**Why this priority**: this is the product's reason to exist: launch pages that survive millions of views.

**Independent Test**: publish, read through the public API with and without `If-None-Match`, republish, and read again.

**Acceptance Scenarios**:

1. **AS-20** — **Given** a story with drafts `en` and `uk` whose products exist in S, **When** E sends `POST /shops/S/stories/ID/publish {expectedVersion:0}` with `Idempotency-Key: k1`, **Then** `200 {status:"PUBLISHED", version:1, locales:["en","uk"], publishedAt, scheduledAt:null}`; in one transaction one immutable version row per locale (title, blocks, seo as of that moment), the story's published pointer, `publishedAt`, `publishedBy = E`, a status-history row and a `story.published` outbox row are written; the drafts remain and stay editable; before this call the public story was `404`, after it `200`.
2. **AS-21** — **Given** version 1 is live, **When** E edits the `en` draft, **Then** the public story and ETag are unchanged and the staff detail shows the draft ahead of the live version; **When** E publishes with `expectedVersion:1`, **Then** `version:2`, the public body and ETag change, and version 1 is still readable and unchanged byte for byte.
3. **AS-22** — **Given** a draft set that cannot be published, **When** E publishes, **Then** nothing is written and no event is emitted: no drafts → `422 no_drafts`; no draft in the default locale → `422 default_locale_missing`; drafts identical to the live version's content → `409 nothing_to_publish`; a `product` block whose product does not exist, or belongs to another shop (the two cases are indistinguishable) → `422 unknown_product_reference {productIds}`, checked with one batch call to S05 (R1) with the shop filter; S05 failing or exceeding its 2-second timeout → `503 dependency_unavailable` with `Retry-After` and a generic `detail`; an archived product is accepted.
4. **AS-23** — **Given** the story has no published version, **When** two publishes with `expectedVersion:0` and different keys run at the same moment, **Then** exactly one `200 version:1` and one `409 version_conflict {currentVersion:1}`; exactly one set of version rows and one event exists; **When** a publish carries a stale `expectedVersion`, **Then** `409 version_conflict` and nothing changes; a missing `expectedVersion` answers `400 validation_failed`.
5. **AS-24** — **Given** AS-20 completed with key `k1`, **When** the same request is replayed with the same key and body, **Then** `200` with the original body byte for byte and `Idempotency-Replayed: true`, and no new version, event, status row or job; **When** the first request is still running, **Then** `409 idempotency_in_flight` with `Retry-After: 1`; **When** the same key is sent with a different body, **Then** `422 idempotency_key_reuse`; **When** the key is missing or malformed (not 8–128 characters of `[A-Za-z0-9_-]`), **Then** `422 idempotency_key_required` / `idempotency_key_invalid`; **When** the clock advances 24 hours and 1 second, **Then** the same key is a new request (answered by the normal rules, for example `409 version_conflict`). Keys are scoped per shop.
6. **AS-25** — **Given** a published story, **When** an anonymous client calls `GET /api/stories/apple/inside-iphone-18/en`, **Then** `200` with `{id, shopId, slug, version, locale, title, blocks, seo, canonical, alternates, publishedAt, preview:false}` and the headers `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<shopId>`, `ETag: "<id>-v<version>-<locale>"`, `Content-Language: <served locale>`; no `Vary: Accept-Language`, no `Set-Cookie`, no per-user value anywhere; `product` blocks carry only the product ID; `HEAD` returns the same headers and no body.
7. **AS-26** — **Given** AS-25, **When** the client repeats the call with `If-None-Match` equal to the ETag (also as one of several comma-separated values, as a weak `W/"…"` form, or as `*`), **Then** `304` with an empty body and the same `ETag`, `Cache-Control` and `Cache-Tag`; with a different value `200`; **When** the story is republished, **Then** the old ETag no longer matches and the answer is `200` with a new ETag.
8. **AS-27** — **Given** a version with locales `en` (default), `uk`, and `pt-BR`, **When** the requested locale is `uk`, `UK`, `uk-UA`, `uk-ua`, `fr`, `en-GB`, `pt`, `pt-BR`, `pt-br`, **Then** the served locale is respectively `uk`, `uk`, `uk`, `uk`, `en`, `en`, `en`, `pt-BR`, `pt-BR` (exact, case-insensitive, then language, then the story default; never across regions), `Content-Language` is the served locale, and the body's `locale` equals it; **When** the path locale is not `xx` or `xx-XX`, **Then** `400 validation_failed`. The server never reads `Accept-Language` or a cookie.
9. **AS-28** — **Given** a version with locales `en` (default) and `uk` of story `inside-iphone-18` of shop `apple`, **When** it is read in any locale, **Then** `alternates` is exactly `[{locale:"en", href}, {locale:"uk", href}, {locale:"x-default", href}]` with absolute `https` hrefs `<front host>/<locale>/brands/apple/stories/inside-iphone-18` (`x-default` pointing at the default locale), and `canonical` is the served locale's href, so a request served by fallback names the URL that actually owns the content.
10. **AS-29** — **Given** an unknown shop slug, an unknown story slug, a story that is only a draft, an archived story, and a story of a suspended shop, **When** each is read, **Then** every answer is `404 story_not_found` with the same `type`, `title`, `status` and `detail` (existence is not revealed), `Cache-Control: public, s-maxage=10`, and no `Cache-Tag`; a shop slug that was freed by a deleted shop and re-registered shows only the new shop's stories.
11. **AS-30** — **Given** a published story and a cold origin cache, **When** 50 readers request it at the same moment, **Then** all get `200` and at most one durable read is made (single flight); the origin cache entry holds every locale of the published version and expires within 60 seconds; a second read makes no durable read; **When** the origin cache is wiped, **Then** the next read still answers `200` from the durable store (fallback path); **When** the origin cache is unreachable, **Then** reads still answer `200` from the durable store, the fallback counter increases and an alert-worthy log line is written.
12. **AS-31** — **Given** version 2 drops the `uk` draft (deleted before publishing), **When** `GET …/uk` is read, **Then** it is served by fallback in `en`, `alternates` lists only `en` and `x-default`, and the `uk` URL is no longer in the sitemap.

**Edge cases for this story**: concurrent publish (AS-23), replay, in-flight and different-body replay (AS-24), illegal or unpublishable states (AS-22), cache fallback (AS-30).

---

### User Story 3 — Schedule a story for its reveal time (Priority: P1)

E schedules a story to go live at a future time. The reveal happens within a minute of the scheduled time, exactly once, even if workers restart, jobs are lost or duplicated, or the schedule is changed.

**Why this priority**: launch reveals are time-critical; going live early, late or twice is a business failure.

**Independent Test**: schedule, advance the clock, run the job, and check the public endpoint, the version rows and the events.

**Acceptance Scenarios**:

1. **AS-40** — **Given** a draft-only story, **When** E sends `POST …/publish {expectedVersion:0, at:"<T>"}` with `T` one hour ahead and an `Idempotency-Key`, **Then** `200 {status:"DRAFT", version:null, scheduledAt:T}`; `status` is unchanged, `scheduledAt` and `scheduledBy` are stored, one delayed job exists for exactly `T` with the key `story-publish:<id>:<T>`, a status-history row records the schedule, no version row and no event exist, and the public story is still `404`.
2. **AS-41** — **Given** AS-40 and an edit to the `en` draft after scheduling, **When** the clock reaches `T` and the job runs, **Then** version 1 is published from the drafts as they are at that moment (including the edit), `scheduledAt` becomes `null`, `publishedAt` equals the clock at the run, `publishedBy` is the user who scheduled, one `story.published` event is recorded, and the public story is `200`; **When** the job is delivered before `T`, **Then** it publishes nothing.
3. **AS-42** — **Given** a schedule for `T1`, **When** E reschedules to `T2`, **Then** a second job exists and `scheduledAt = T2`; **When** the `T1` job runs, **Then** it is a no-op (no version, no event, `scheduledAt` still `T2`); **When** the `T2` job runs, **Then** it publishes; **When** E sends `DELETE …/schedule` before `T2`, **Then** `204`, `scheduledAt` is `null`, and the `T2` job is a no-op; **When** E cancels a story with no schedule, **Then** `409 not_scheduled`.
4. **AS-43** — **Given** the clock at `now`, **When** E sends `at` in the past or equal to now, **Then** `422 schedule_in_past`; `at` more than 365 days ahead → `422 schedule_too_far`; `at` that is not ISO-8601 with an offset → `400 validation_failed`; **When** `at` is omitted, **Then** the story is published immediately (AS-20); in every refused case nothing changes and no job is created.
5. **AS-44** — **Given** a schedule at `T`, **When** the same job is delivered twice at the same moment, **Then** exactly one version and one event exist; **When** E publishes now before `T`, **Then** `scheduledAt` is cleared by that publish and the `T` job later does nothing.
6. **AS-45** — **Given** version 1 is live, **When** E schedules version 2 for `T`, **Then** the status stays `PUBLISHED`, the public story keeps serving version 1 until `T`, and at `T` serves version 2 (a scheduled republish never takes the live story offline).
7. **AS-46** — **Given** a schedule at `T` whose job was lost (never delivered), **When** the clock is `T` + 2 minutes and the due-schedule sweep runs, **Then** the story is published once; **When** two sweeps run concurrently, **Then** exactly one version exists; a story whose schedule was cancelled between the sweep's read and its update is not published; a story not yet due is untouched; a sweep run twice in the same minute changes nothing the second time.
8. **AS-47** — **Given** a schedule at `T` and a state in which publishing is impossible at `T` — a referenced product no longer exists (`unknown_product_reference`), the default-locale draft was deleted (`default_locale_missing`), all drafts removed (`no_drafts`), drafts identical to the live version (`nothing_to_publish`), or the shop is not `ACTIVE` (`shop_not_active`) — **When** the job runs, **Then** the failure is permanent and not retried: nothing is published, `scheduledAt` is cleared, `scheduleFailure {at, code}` is visible in the staff detail, a `story.schedule_failed` event `{storyId, shopId, scheduledAt, code}` is recorded and the failure counter increases; **When** a transient error occurs instead (store timeout, S05 unavailable), **Then** the job is retried by the scheduler with backoff, the schedule is kept and nothing is recorded as failed until the retries are exhausted, after which it is treated as a permanent failure with code `publish_failed`; the next successful publish or schedule clears `scheduleFailure`.

**Edge cases for this story**: stale job (AS-42), lost job (AS-46), duplicate delivery (AS-44), early delivery (AS-41), past or too-far time (AS-43), failure at fire time (AS-47).

---

### User Story 4 — Every cache layer is invalidated by tag (Priority: P1)

When a story is published or archived, the origin read model, the CDN and the Next.js route cache all stop serving the old version, by tag, without anyone listing URLs.

**Why this priority**: edits must go live within a minute; a cache that serves stale launch content (or serves an archived story) is the main failure of an edge-cached CMS.

**Independent Test**: publish, deliver the event, and check the order of the origin clear, the CDN purge and the signed webhook.

**Acceptance Scenarios**:

1. **AS-50** — **Given** a publish, archive or schedule failure, **When** the transaction commits, **Then** the matching event (`story.published`, `story.archived`, `story.schedule_failed`) was recorded in the outbox in that same transaction, on topic `stories.events` keyed by `storyId` with envelope `{eventId, type, version, occurredAt, aggregateId}`; **When** the transaction rolls back (for example `409`), **Then** no event exists; **When** the message bus is down at publish time, **Then** the publish still answers `200` and the event is relayed later.
2. **AS-51** — **Given** a `story.published` event, **When** the invalidation consumer handles it, **Then** it acts in this order: (1) deletes the story's origin cache entry, (2) purges the CDN by tags `story:<storyId>` and `shop:<shopId>`, (3) calls the front end's revalidation endpoint with body `{"tags":["story:<id>","shop:<shopId>"],"eventId":"<eventId>"}` and headers `X-Revalidate-Timestamp: <unix seconds from the clock>` and `X-Revalidate-Signature: <hex HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret>`; a receiver that recomputes the signature gets a match, a changed body or a timestamp older than 5 minutes does not.
3. **AS-52** — **Given** 100 events for 40 distinct stories of 3 shops handled in one batch, **When** they are processed, **Then** the CDN receives 43 distinct tags exactly once each, in calls of at most 30 tags (two calls), and the front end receives one signed call per 30 tags at most.
4. **AS-53** — **Given** an event that was handled successfully, **When** the same event (same `eventId`) is delivered again, **Then** no second purge and no second webhook call are made (idempotent consumer: the processed `eventId` is recorded only after both targets succeeded).
5. **AS-54** — **Given** the CDN API answers `5xx`, `429` or times out (5-second timeout), **When** the event is handled, **Then** the call is retried at most 3 times with exponential backoff and full jitter inside the call; the front-end webhook is still attempted; the message then fails and is redelivered with backoff, a redelivery repeats only what is idempotent (purges), and the counter `story_cache_purge_total{target, result}` counts each attempt; a CDN `4xx` other than `429` (bad credentials) is permanent: dead-lettered at once with an alert-worthy log line; after 8 failed deliveries any message is dead-lettered; a failure in one target never prevents the attempt at the other.
6. **AS-55** — **Given** an event payload that is missing `storyId` or `shopId`, has a wrong type, or an unknown event `version`, **When** it is delivered, **Then** it is dead-lettered with a reason, and no purge, no webhook and no cache deletion happens.
7. **AS-56** — **Given** `story.published` for version 2 is delivered after `story.archived` (out of order), **When** both are handled in that order, **Then** each purges its tags and the final public answer follows the durable state (archived → `404`), because cache content is never built from event payloads, only from the durable store.
8. **AS-57** — **Given** a reader that raced with a publish and left the old version in the origin cache after the commit, **When** the invalidation consumer runs, **Then** it clears the entry again before purging the CDN, so the next origin read after the purge returns the new version; in any case an origin entry expires within 60 seconds.
9. **AS-58** — **Given** `tenancy.shop_status_changed` moves S to `SUSPENDED` (and later back to `ACTIVE`), **When** it is handled, **Then** the origin entries of all stories of S are deleted, the tag `shop:<shopId>` is purged and revalidated, S's public stories answer `404` after the suspension and `200` again after reinstatement; the same event delivered twice or out of order by `shopVersion` changes nothing further (AS-97).
10. **AS-59** — **Given** no CDN credentials or no revalidation secret in a non-production environment, **When** a story is published, **Then** logging adapters record the tags and the call and nothing leaves the process; **When** the application starts in production without them, **Then** startup fails with a configuration error naming the missing key (no secret value).

**Edge cases for this story**: out-of-order and duplicate events (AS-53, AS-56), poison messages (AS-55), CDN failure (AS-54), cache race (AS-57), chunking (AS-52).

---

### User Story 5 — Preview a draft before it is live (Priority: P2)

E gets a short-lived link to see the draft of one locale exactly as readers would, bypassing every cache.

**Why this priority**: editors must check content before the reveal; it is secondary to publishing itself.

**Independent Test**: mint a token, read the preview, edit the draft, read again, and try the rejection cases.

**Acceptance Scenarios**:

1. **AS-60** — **Given** a draft in `en`, **When** E sends `POST /shops/S/stories/ID/preview-token {locale:"en"}`, **Then** `200 {token, expiresAt: now + 30 minutes}`; the token is bound to the story, the shop and the locale, carries the audience `story-preview`, is signed with a key dedicated to previews (never the session key) with the algorithm pinned, and expires after 30 minutes; V answers `403 permission_denied`; a locale without a draft answers `404 draft_not_found`; a story of another shop answers `404 story_not_found`.
2. **AS-61** — **Given** a token, **When** a client calls `GET /api/stories/preview` with the header `X-Preview-Token: <token>`, **Then** `200` with the same shape as AS-25 but `version:null`, `preview:true`, `alternates:[]` and the current draft content (title, sanitised blocks, seo), the headers `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`, and no `ETag` and no `Cache-Tag`; **When** E edits the draft and the call is repeated, **Then** the new draft is shown at once; it works for a story that was never published.
3. **AS-62** — **Given** each of: no header, a malformed token, a forged signature, an expired token (clock +31 minutes), a token with another audience or signed with the session key, a token with `alg: none`, a valid token in the query string instead of the header, a token whose story, locale draft or shop no longer exists, a token of a shop that is not `ACTIVE`, **When** the call is made, **Then** every answer is the same `404 story_not_found` problem with `Cache-Control: no-store`, and no log line contains the token.

**Edge cases for this story**: forged, expired and mis-addressed tokens (AS-62); a stolen link outlives nothing longer than 30 minutes.

---

### User Story 6 — Search engines find every published story (Priority: P2)

Crawlers read a sitemap index and child sitemaps listing every published story URL in every locale with `hreflang` alternates, however many stories exist.

**Why this priority**: SEO is the reason stories exist; secondary to serving them.

**Independent Test**: publish stories across several pages, fetch the index and each child, and check size limits, stability and streaming.

**Acceptance Scenarios**:

1. **AS-70** — **Given** published stories whose highest sitemap position is 5,001 (page capacity 2,500 stories), **When** a crawler calls `GET /api/sitemaps/stories.xml`, **Then** `200 application/xml` with a `<sitemapindex>` of exactly 3 `<sitemap><loc>` entries `<backend host>/api/sitemaps/stories-0.xml` … `stories-2.xml`, `Cache-Control: public, s-maxage=3600`; with no published story at all it lists one (empty) child.
2. **AS-71** — **Given** published stories with 1, 2 and 20 locales, **When** a child sitemap is fetched, **Then** it is well-formed XML with one `<url>` per story and served locale: `<loc>` `<front host>/<locale>/brands/<shopSlug>/stories/<slug>`, `<lastmod>` the publish time of the current version, and one `xhtml:link rel="alternate"` per locale plus `x-default`, all values XML-escaped (a host or URL containing `&`, `<`, `'` or `"` never breaks the document); DRAFT, ARCHIVED and suspended-shop stories are absent; a file never has more than 50,000 `<url>` entries or 50 MB (a page holds at most 2,500 stories, the locale cap being 20).
3. **AS-72** — **Given** stories at positions 1–5 (page capacity 2 in the test), **When** story 1 is archived and story 6 is published, **Then** stories 2–5 stay on the same pages (a story's position is allocated once at its first publish and never changes or is reused): page 0 lists only story 2, page 1 lists 3 and 4, page 2 lists 5 and the new story at position 6.
4. **AS-73** — **Given** `stories-abc.xml`, `stories--1.xml`, `stories-1.5.xml`, `stories-99999999999999999999.xml`, or a page beyond the last, **When** requested, **Then** `404 not_found`; a valid page with no published story answers `200` with an empty `<urlset>`.
5. **AS-74** — **Given** 5,000 published stories in one page (cap raised in the test), **When** a slow client reads 1 KB at a time, **Then** rows are read in batches of at most 1,000 and at most 2 batches are buffered ahead of the client at any moment (backpressure), and no read uses an offset; **When** the client disconnects after the first chunk, **Then** reading stops within one batch, no error is thrown to the process, and `story_sitemap_aborted_total` increases.
6. **AS-75** — **Given** the durable store fails on the second batch, **When** the page is streamed, **Then** the connection is terminated abnormally (a client sees an incomplete response, never a cleanly ended document that is silently truncated), the failure is logged with a generic message; **Given** it fails before the first batch, **Then** `503` problem+json with `Retry-After` and a generic `detail`.

**Edge cases for this story**: size limits (AS-71), stability (AS-72), bad page numbers (AS-73), backpressure and abort (AS-74), failure mid-stream (AS-75).

---

### User Story 7 — Take a story down, read history, roll back (Priority: P2)

E archives a story (it disappears everywhere), looks through the versions, and rolls back by restoring an old version into the drafts and publishing it.

**Why this priority**: take-down and rollback are what make publishing safe to do.

**Independent Test**: archive and republish a story; list versions; restore and publish version 1.

**Acceptance Scenarios**:

1. **AS-80** — **Given** a published story (version 2) with a pending schedule, **When** E sends `POST …/archive`, **Then** `200 {status:"ARCHIVED"}`, the pending schedule is cleared, a `story.archived` event `{storyId, shopId, shopSlug, slug, version:2}` and a status-history row are recorded in one transaction, the origin entry is deleted at once, the public story is `404`, and all versions and drafts remain; the invalidation consumer purges `story:<id>` and `shop:<shopId>`.
2. **AS-81** — **Given** an archived story, **When** E publishes with `expectedVersion:2`, **Then** `version:3`, status `PUBLISHED`, the public story is back, and its sitemap position is unchanged.
3. **AS-82** — **Given** the transition table below, **When** E archives a `DRAFT` or `ARCHIVED` story, **Then** `409 invalid_transition {status}`; **When** E cancels a schedule on a story with none, **Then** `409 not_scheduled`; the allowed moves succeed; no illegal call changes a row, history or event.
4. **AS-83** — **Given** a published story, **When** a publish (`expectedVersion` current) and an archive run at the same moment, **Then** both are serialised: the final status matches the last recorded event (`story.published` → `PUBLISHED`, `story.archived` → `ARCHIVED`), no status/event mismatch is possible, and version numbers stay gapless.
5. **AS-84** — **Given** versions 1–3, **When** E calls `GET …/versions?limit=2&cursor=` and then `GET …/versions/2`, **Then** the list is newest first `{version, locales, publishedAt, publishedBy}` with `nextCursor`, and the detail returns every locale's frozen `title`, `blocks`, `seo`; an unknown version answers `404 version_not_found`; a version never changes after later draft edits or later publishes.
6. **AS-85** — **Given** version 3 is live and drafts differ, **When** E sends `POST …/versions/1/restore`, **Then** `200` with the staff detail: the drafts now equal version 1's locales (locales not in version 1 are removed from the drafts), draft revisions advanced, the live version, status and schedule untouched, no event; **When** E then publishes with `expectedVersion:3`, **Then** version 4 has version 1's content and versions 1–3 are intact; restoring an unknown version answers `404 version_not_found`.

---

### User Story 8 — Tenant isolation, lifecycle and operations (Priority: P1)

Staff only ever touch their own shop's stories, the shop's lifecycle is respected, and operators can see what the system does.

**Why this priority**: cross-tenant leaks, content of deleted shops, and silent cache failures are the costliest defects.

**Independent Test**: call every staff route as an outsider, a viewer and a suspended shop; deliver tenancy events duplicated and out of order.

**Acceptance Scenarios**:

1. **AS-90** — **Given** every staff route (`POST/GET /shops/S/stories`, detail, draft `PUT`/`DELETE`, publish, schedule `DELETE`, archive, versions, version detail, restore, preview-token), **When** it is called without a session or with an invalid one, **Then** `401` problem+json and no state change.
2. **AS-91** — **Given** V (`products.read`), **When** V calls a read of the list, **Then** `200`; **When** V calls any mutation, the story detail, a version detail or preview-token, **Then** `403 permission_denied`; **When** a non-member of S calls any route under `/shops/S/…`, **Then** `404 shop_not_found` (S03's guard, identical for an unknown shop).
3. **AS-92** — **Given** E is a member of S only and story X belongs to S2, **When** E calls each staff route as `/shops/S/stories/X/…` (every method above), **Then** each answers `404 story_not_found` with the same body as for a random unknown story ID, and S2's rows, events and cache entries are unchanged; a malformed story ID answers `400 validation_failed`; E's list never contains X.
4. **AS-93** — **Given** S is `SUSPENDED`, **When** E calls a story mutation, **Then** `403 shop_suspended`; **Given** S is `DELETING`, **Then** `409 shop_offboarding`; **Given** S is purged, **Then** `404 shop_not_found` (S03's status gate); nothing changes in any case.
5. **AS-94** — **Given** the staff write rate (120 per minute per shop, fail closed), **When** E (or any member) sends the 121st mutation in the window, **Then** `429` problem+json with `Retry-After`, no state change; shop S2 is unaffected; reads and the public endpoints are not limited by it; a limiter outage refuses writes with `503` rather than allowing them.
6. **AS-95** — **Given** a forced durable-store failure during publish, **When** E publishes, **Then** a 5xx problem+json with a generic `detail` (no SQL, stack, table or host name), the version rows, pointer, history and outbox are all absent (one transaction), and `requestId` is in the body; every error response of this capability is `application/problem+json`.
7. **AS-96** — **Given** publishes, scheduled runs, purges and sitemap streams, **When** they happen, **Then** structured logs carry `requestId`, `storyId`, `shopId`, `version` and the outcome, never draft content, never tokens or secrets; metrics exist: `story_publish_total{result}`, `story_schedule_fired_total{result}`, `story_cache_purge_total{target,result}`, `story_cache_purge_lag_seconds` (event `occurredAt` to purge completion), `story_read_origin_total{source=cache|durable|fallback}`, `story_sitemap_aborted_total`; a purge lag above 60 seconds or a dead-lettered invalidation produces an alert-worthy log line.
8. **AS-97** — **Given** the shop identity copy (slug, status, `shopVersion`) fed by `tenancy.shop_created`, `tenancy.shop_updated`, `tenancy.shop_status_changed`, **When** each is consumed, **Then** the copy is created or updated; an event with a `shopVersion` not greater than the stored one is ignored (older, duplicate); `shop_status_changed` arriving before `shop_created` creates the copy and the later older `shop_created` does not regress it; an invalid payload (missing `shopId`, bad type, unknown version) is dead-lettered without a write; replaying the whole topic into an empty copy rebuilds the same state; the copy is never written back to tenancy.
9. **AS-98** — **Given** `tenancy.shop_deleted {shopId}`, **When** it is consumed, **Then** all stories, drafts, versions, history, pending jobs' targets and the shop copy of that shop are deleted in bounded batches, origin entries are cleared and `shop:<shopId>` is purged; delivering it twice, or a failure half-way followed by a redelivery, ends in the same empty state; stories of other shops are untouched; the old slug can be re-registered without exposing old content.
10. **AS-99** — **Given** the strict static checks, **Then** `content` reads no `Shop` table or `ShopModel` (shop identity comes from the copy, R3, and from `ShopQueryService.getShopsByIds`, R1), no table of this domain has a foreign key to another owner's table, every query on story data carries the shop in its predicate, the domain barrel exports no model, projector or consumer implementation, and `pnpm --dir packages/backend check:table-ownership --strict` reports no `content` line.

**Edge cases for this story**: IDOR (AS-92), status gates (AS-93), rate limit (AS-94), duplicate and out-of-order events (AS-97), deleted shop (AS-98).

---

### Edge Cases

- A scheduled time inside the same minute as the sweep, a clock moved backwards, or a job delivered long after its time: the job publishes if and only if `scheduledAt` still matches and is due (AS-41, AS-42, AS-46).
- A product block referring to a product deleted after publish: the story stays served; the front end composes product data and handles a missing product (R2, outside this capability).
- A story with the maximum number of blocks and locales stays within the 256 KiB per-draft limit and the sitemap caps (AS-08, AS-71).
- Two replicas serve the same story: every replica reads the same durable truth; no per-replica cache can outlive 60 seconds (AS-30, AS-57).

### Status model

| Current status | Operation | Result | Conditions |
|---|---|---|---|
| `DRAFT` | publish now | `PUBLISHED` (version +1) | drafts valid (AS-22) |
| `DRAFT` / `ARCHIVED` / `PUBLISHED` | schedule `at` | same status, `scheduledAt = at` | future time ≤ 365 days; replaces any earlier schedule |
| any with a schedule | cancel schedule | same status, `scheduledAt = null` | else `409 not_scheduled` |
| any with a schedule | schedule fires | `PUBLISHED` (version +1) or schedule cleared with `scheduleFailure` | `scheduledAt` still equals the job's |
| `PUBLISHED` | publish now | `PUBLISHED` (version +1) | `expectedVersion` current |
| `ARCHIVED` | publish now | `PUBLISHED` (version +1) | `expectedVersion` current |
| `PUBLISHED` | archive | `ARCHIVED`, schedule cleared | else `409 invalid_transition` |
| `DRAFT` / `ARCHIVED` | archive | refused | `409 invalid_transition` |

Every transition is a conditional update that must affect exactly one row, with a history row in the same transaction.

## Requirements *(mandatory)*

### Functional Requirements

**Stories and drafts**

- **FR-001**: Staff with `products.write` MUST be able to create a story with a slug unique within the shop and a default locale; the slug and default locale are fixed for the story's life; a duplicate slug MUST answer `409 slug_taken`, also under concurrency; a shop MUST NOT exceed 5,000 stories (AS-01–AS-04).
- **FR-002**: Drafts MUST be stored per locale with a revision counter; every draft write and delete MUST carry `expectedRevision` and be refused with `409 revision_conflict` when it is not the current revision, so concurrent editors cannot overwrite each other (AS-05, AS-09, AS-11).
- **FR-003**: A story MUST NOT have more than 20 locales, 200 blocks per draft, a title over 200 characters, a draft over 256 KiB serialised, or a request body over 1 MiB (AS-08, AS-10).
- **FR-004**: Block types MUST be exactly `heading` (level 2 or 3), `richText`, `image`, `product`, `quote`, `video`; every block MUST be validated on save; URLs MUST be `https`; video hosts MUST be matched exactly on the parsed host against the allowlist (AS-08).
- **FR-005**: Rich text MUST be sanitised on write against a fixed allowlist, idempotently; plain-text fields MUST be stored and returned verbatim and clients MUST render them as text; responses MUST carry `X-Content-Type-Options: nosniff` (AS-06, AS-07; pattern P0501).
- **FR-006**: Staff MUST be able to list a shop's stories (keyset pagination, newest first, status filter), read one story with all its drafts, and delete a non-default draft (AS-11, AS-12).

**Publish, versions and schedule**

- **FR-010**: Publishing MUST freeze every locale draft into one immutable version row set under a new gapless version number, flip the published pointer, record the publishing user and a history row, and record `story.published`, all in one transaction (AS-20, AS-21).
- **FR-011**: A publish MUST be refused, with nothing written, when there are no drafts, the default-locale draft is missing, the drafts equal the live content, or a `product` block references a product that is not in the same shop (checked in one batch through S05, R1) (AS-22).
- **FR-012**: Publish and schedule MUST carry `expectedVersion`; publish, schedule, archive and the scheduled fire MUST serialise per story so that concurrent requests produce exactly one success and `409 version_conflict` for the rest (AS-23, AS-83).
- **FR-013**: `POST …/publish` MUST require an `Idempotency-Key` with the platform contract: replay returns the stored status and body with `Idempotency-Replayed: true`, in flight `409`, different body `422`, 24-hour TTL, scoped per shop (AS-24).
- **FR-014**: A schedule time MUST be in the future and at most 365 days ahead; the story's status MUST NOT change when it is scheduled; a scheduled republish MUST NOT take the live version offline (AS-40, AS-43, AS-45).
- **FR-015**: A scheduled publish MUST create exactly one delayed job per schedule, keyed by story and time; the job MUST publish only if the story's `scheduledAt` still equals the job's and is due, publish the drafts as they are at that moment, and be a no-op otherwise (AS-41, AS-42, AS-44).
- **FR-016**: A due-schedule sweep MUST run at least every minute as a single-run, idempotent job and publish any story whose schedule is due and unprocessed, so that a lost job delays a reveal by at most 2 minutes (AS-46).
- **FR-017**: A permanent failure at fire time MUST clear the schedule, record `scheduleFailure {at, code}` and emit `story.schedule_failed`; transient failures MUST be retried by the scheduler before being treated as permanent (AS-47).
- **FR-018**: Staff MUST be able to archive a published story (clears the schedule, emits `story.archived`), cancel a schedule, list and read versions, and restore a version into the drafts; illegal moves answer `409` per the status model (AS-80–AS-85).

**Public read and cache semantics**

- **FR-020**: The public story MUST be served anonymously at `GET /api/stories/<shopSlug>/<slug>/<locale>` (and `HEAD`), locale in the path; the locale MUST be resolved by the chain exact (case-insensitive) → language → story default, never from `Accept-Language` or cookies (AS-25, AS-27; pattern P0904 / notes §5 i18n).
- **FR-021**: Success responses MUST carry `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<shopId>`, a strong `ETag` of `"<id>-v<version>-<locale>"` and `Content-Language`; `404` MUST carry `public, s-maxage=10` and no tag; no public response MUST vary by user (AS-25, AS-29; pattern P0410).
- **FR-022**: Conditional requests MUST be answered `304` without a body when `If-None-Match` matches (list, weak and `*` forms), repeating the validators (AS-26).
- **FR-023**: Each response MUST include `canonical` and `alternates` with one entry per locale of the served version plus `x-default` (AS-28).
- **FR-024**: A story MUST be publicly visible only when it is `PUBLISHED` and its shop copy is `ACTIVE`; drafts, archived stories and suspended shops' stories MUST answer an identical `404` (AS-29, AS-58).
- **FR-025**: The origin MUST serve from a read model of the published version with every locale, filled from the durable store on a miss with at most one concurrent fill per story, every entry expiring within 60 seconds; the store being empty or unreachable MUST NOT fail reads (AS-30; pattern P0410, constitution III.9).

**Invalidation**

- **FR-030**: Publish, archive and a failed scheduled publish MUST record their event in the same transaction as the change; events MUST carry `{storyId, shopId, shopSlug, slug, version, …}` as listed under Provides (AS-50).
- **FR-031**: The invalidation consumer MUST, in order, clear the origin entry, purge the CDN by tags `story:<id>` and `shop:<shopId>`, and call the front-end revalidation endpoint with the signed timestamped body of AS-51, batching and de-duplicating tags (CDN calls ≤ 30 tags) (AS-51, AS-52; pattern P0904).
- **FR-032**: The consumer MUST be idempotent per `eventId`, validate its payload, retry only idempotent calls with bounded backoff and jitter, treat non-retryable CDN errors as permanent, dead-letter poison messages, and never skip a target because the other failed (AS-53–AS-56).
- **FR-033**: The consumer MUST clear the origin entry again before the CDN purge so a racing read cannot re-cache the old version after the purge; content MUST never be built from event payloads (AS-56, AS-57).
- **FR-034**: Outside production, absent CDN or revalidation credentials MUST select logging adapters; production MUST refuse to start without them (AS-59).

**Preview**

- **FR-040**: Preview tokens MUST be minted only by staff with `products.write`, bound to story, shop and locale, signed with a dedicated key and pinned algorithm, audience-restricted, valid 30 minutes, and sent in a header, never in a URL (AS-60, AS-61).
- **FR-041**: Preview responses MUST show the current draft, be `private, no-store`, `noindex` and `no-referrer`, and every invalid, expired or mis-addressed token MUST answer the same uncacheable `404` (AS-61, AS-62).

**Sitemap**

- **FR-050**: `GET /api/sitemaps/stories.xml` MUST list one child per page; `GET /api/sitemaps/stories-<n>.xml` MUST list `<url>` entries per published story and locale with `lastmod` and `hreflang` alternates (including `x-default`), escaped, absent for non-public stories, with at most 50,000 URLs and 50 MB per file (AS-70, AS-71; pattern P0207).
- **FR-051**: A story's sitemap page MUST be decided by a position allocated once at its first publish and never changed or reused; reading a page MUST NOT use an offset or a full count (AS-72).
- **FR-052**: A page MUST be streamed in keyset batches of at most 1,000 rows with backpressure, constant memory, early termination on client abort, and an abnormal connection termination (never a clean end) when the store fails mid-stream (AS-73–AS-75).

**Isolation, lifecycle, operations**

- **FR-060**: Every staff route MUST require a session and S03's shop guard with `products.read` (list) or `products.write` (everything else, including draft detail, versions and preview-token); every query on story data MUST put `shopId` in its predicate; a story of another shop MUST answer an indistinguishable `404 story_not_found` (AS-90–AS-92; constitution III.4).
- **FR-061**: Staff mutations MUST be rate limited per shop (120 per minute, fail closed) with `429` and `Retry-After` (AS-94).
- **FR-062**: Shop identity (slug, status, version) MUST come from a copy owned by this capability, kept by version-guarded, idempotent, validated consumers of tenancy events (R3, IX.8); a single missing copy on the write path MAY be fetched once through S03's exported batch query (R1); stories MUST NOT read tenancy tables, hold a foreign key to them or import their models (AS-97, AS-99).
- **FR-063**: On `tenancy.shop_deleted` all of the shop's content MUST be deleted idempotently in bounded batches (AS-98).
- **FR-064**: Every error MUST be RFC 9457 problem+json from the single global filter, 5xx with a generic `detail` (AS-95); every outbound call (S05, S03, CDN, front end, DB, cache) MUST have an explicit timeout.
- **FR-065**: The logs and metrics of AS-96 MUST exist, and logs MUST NOT contain draft content, tokens or secrets.
- **FR-066**: Responses MUST be explicit DTOs validated by contract schemas in `packages/contracts`; models are never serialised (constitution V.1, V.2).

### Key Entities *(include if feature involves data)*

- **Story**: a shop's editorial page: `id`, `shopId`, `slug` (unique per shop, permanent), `defaultLocale`, `status` (`DRAFT`, `PUBLISHED`, `ARCHIVED`), `publishedVersion`, `publishedAt`, `scheduledAt`, `scheduledBy`, `scheduleFailure`, sitemap position. Owned by `content`.
- **StoryDraft**: the editable content of one locale of a story: `title`, `blocks`, `seo`, `revision`, `updatedAt`.
- **StoryVersion**: the immutable snapshot of one locale at one publish: `storyId`, `version`, `locale`, `title`, `blocks`, `seo`, `publishedAt`, `publishedBy`.
- **StoryTransition**: one history row per status or schedule change: `storyId`, `from`, `to`, `action`, `actor`, `occurredAt`.
- **ShopRef**: this capability's copy of a shop's public identity: `shopId`, `slug`, `status`, `shopVersion`, built from tenancy events (R3). Read-only for everything but its consumer.
- **Block**: a typed content unit (`heading`, `richText`, `image`, `product`, `quote`, `video`) inside a draft or version.
- **Origin read model and tags** (derived, never the source of truth): the per-story cache of the published version; the cache tags `story:<id>` and `shop:<id>`.
- **Preview token** (stateless): a signed 30-minute grant to read one locale's draft.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A published, archived or rescheduled change is visible to every reader within 60 seconds in 100% of runs (origin entries expire within 60 s; purge runs right after the commit's event) (AS-30, AS-51, AS-57).
- **SC-002**: A scheduled story is live within 60 seconds of its scheduled time when the job runs, and within 2 minutes when the job is lost, never earlier than its time, and exactly once in 100% of runs including duplicated and concurrent deliveries (AS-41, AS-44, AS-46).
- **SC-003**: At least 99% of story views are answered by the CDN, and the origin, answering from its read model, sustains 2,000 requests per second with p99 below 50 ms (load script, an operations artifact).
- **SC-004**: Zero draft, archived, scheduled-but-not-due or suspended-shop content is returned by any anonymous request across all scenarios (AS-29, AS-31, AS-58, AS-62).
- **SC-005**: 100% of a corpus of hostile rich-text inputs is neutralised, and no served block contains executable markup (AS-06, AS-07).
- **SC-006**: Twenty concurrent identical creates, draft saves, publishes or schedule fires always yield exactly one success and a consistent state (AS-03, AS-09, AS-23, AS-44).
- **SC-007**: Every sitemap file holds at most 50,000 URLs, memory use stays flat from 10 to 50,000 stories per file, and a crawler never receives a silently truncated document (AS-71, AS-74, AS-75).
- **SC-008**: Zero cross-shop reads or writes succeed across every staff route (AS-92).
- **SC-009**: A duplicate request, event or job produces 0 duplicate versions, events, purges or webhook calls (AS-24, AS-44, AS-53).

## Cross-capability contracts

**Provides** (exact names; exported from `@app/domains/content` unless it is an HTTP endpoint or an event):

- **HTTP endpoints** (under `/api`, problem+json errors, zod schemas in `packages/contracts`: `storyAdminSchema`, `storyListItemSchema`, `storyDraftSchema`, `publicStorySchema`, `storyVersionSchema`, `storyVersionListItemSchema`, `previewTokenSchema`, `pageSchema(…)` = `{items, nextCursor}`):
  - Staff, `ShopScoped`: `POST /shops/:shopId/stories {slug, defaultLocale?}` → `201 storyAdminSchema`; `GET /shops/:shopId/stories?status&limit=1..100&cursor` (`products.read`) → page of `storyListItemSchema`; `GET /shops/:shopId/stories/:storyId` → `storyAdminSchema` with `drafts`; `PUT /shops/:shopId/stories/:storyId/drafts/:locale {title, blocks, seo?, expectedRevision}` → `200 storyDraftSchema`; `DELETE …/drafts/:locale?expectedRevision` → `204`; `POST …/publish {expectedVersion, at?}` with `Idempotency-Key` → `200 {status, version, locales, publishedAt, scheduledAt}`; `DELETE …/schedule` → `204`; `POST …/archive` → `200 {status}`; `GET …/versions?limit&cursor`, `GET …/versions/:version`, `POST …/versions/:version/restore`; `POST …/preview-token {locale}` → `200 {token, expiresAt}`. Permissions `products.read` / `products.write` (S03 names). Rate policy `content.write.shop`.
  - Public, anonymous, `Firewall({anonymous:true})`: `GET|HEAD /stories/:shopSlug/:slug/:locale` → `publicStorySchema` `{id, shopId, slug, version, locale, title, blocks, seo, canonical, alternates:[{locale, href}], publishedAt, preview}`; `GET /stories/preview` with header `X-Preview-Token`; `GET /sitemaps/stories.xml`; `GET /sitemaps/stories-:page.xml`. **Consumers: the web capability that renders `/<locale>/brands/<shopSlug>/stories/<slug>` (not assigned yet, see `questions.md`), the staff editor UI (not assigned), search engines, the CDN.**
- **Cache contract for the CDN and front end**: tags `story:<storyId>` and `shop:<shopId>`; header names `Cache-Tag`, `Cache-Control`, `ETag`; locale in the path; no `Vary`.
- **Outbound revalidation call** to `<front host>/api/revalidate`: `POST` JSON `{tags: string[], eventId: string}`, headers `X-Revalidate-Timestamp` (unix seconds) and `X-Revalidate-Signature` (hex HMAC-SHA256 over `"<timestamp>.<raw body>"` with the shared secret); the receiver MUST reject timestamps older than 5 minutes and treat the call as idempotent. **Consumer: the web capability that owns the revalidation route (unassigned).**
- **Events** (outbox → topic `stories.events`, key `storyId`; envelope `{eventId, type, version, occurredAt, aggregateId}`): `story.published` v1 `{storyId, shopId, shopSlug, slug, version, locales}`; `story.archived` v1 `{storyId, shopId, shopSlug, slug, version}`; `story.schedule_failed` v1 `{storyId, shopId, scheduledAt, code}`. **Consumers: this capability's invalidation consumer; S28 may use `story.schedule_failed` to alert staff (not required).**
- **R1 exports**: none. The module exports no service for other domains.
- **Scheduled jobs registered with S49**: `stories.publish` (payload `{storyId, scheduledAt}`, key `story-publish:<storyId>:<scheduledAt>`, concurrency 5), `stories.publish-due-sweep` (every minute, single-run).
- **Metrics and logs**: those of AS-96.

**Requires** (owner, exact shape assumed):

- **S03** (`tenancy`): `ShopScoped(permission)` guard with the status gate and permissions `products.read`, `products.write`; `ShopQueryService.getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (R1, ≤ 500; fields used `id`, `slug`, `status: "ACTIVE" | "SUSPENDED" | "DELETING" | "DELETED"`, `shopVersion`); events on the tenancy topic keyed by `shopId` (R3): `tenancy.shop_created` v1 `{shopId, ownerId, name, slug, plan, region, shopVersion}`, `tenancy.shop_updated` v1 `{shopId, name, slug, shopVersion}`, `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}`, `tenancy.shop_deleted` v1 `{shopId}`; a shop slug is immutable while the shop exists.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], opts?: {shopId: ShopId}): Promise<Map<ProductId, ProductDto>>` (R1, ≤ 500, one statement, other shops' IDs absent when `shopId` is given); only presence is used.
- **S01** (`identity`): `Firewall({ anonymous?: boolean })`, `@User()`, `AuthenticatedUser = {id, role, sessionId, amr}`.
- **S49** (`infrastructure`): enqueue with `runAt` and an idempotency key, handler registration with concurrency, retry with exponential backoff, a way for a handler to signal a permanent (non-retryable) failure, and a single-run cron facility.
- **S50** (`infrastructure`): policy `content.write.shop` (120 per minute per shop, fail closed), `429` with `Retry-After`.
- **S52** (`infrastructure`): conditional-GET handling for a caller-supplied strong ETag (list, weak and `*` forms), and a cache-aside helper with TTL and single flight.
- **S53** (`infrastructure`): `defineEvent` and the outbox append inside the caller's transaction, keyed relay to Kafka, consumer framework with inbox/processed-events, zod payload validation, retry with backoff and dead-lettering, projector deployment through `apps/projector`.
- **S54** (`infrastructure`): problem+json filter, request context, resilient HTTP client with timeouts, config validation at startup, metrics and logging; the platform idempotency-key facility with the V.6 contract (header `Idempotency-Replayed`, `409 idempotency_in_flight`, `422 idempotency_key_reuse`, 24-hour TTL).
- **Clock**: an injected clock port (publish times, schedule checks, preview expiry, revalidation timestamp).
- **Configuration**: a dedicated preview signing secret, the revalidation shared secret, CDN zone and token, front and backend host names.
- **Contracts package**: the schemas listed under Provides.

## Assumptions

- Every default below is also a line in `questions.md`.
- **Locale in the path**: `GET /api/stories/<shopSlug>/<slug>/<locale>`, because notes §5 requires the locale in the path for cacheability and the CDN must not fragment by `Accept-Language`. A request for an unavailable locale is served by the fallback chain with `canonical` naming the owning URL; the CDN cache key space per story is bounded by tag purges, not by the locale count.
- **`SCHEDULED` is not a status.** A schedule is a separate attribute (`scheduledAt`), so a scheduled republish never hides a live story. The existing database check value `ARCHIVED` is kept and used for take-down.
- **Publish needs `expectedVersion` and an `Idempotency-Key`; draft writes need `expectedRevision`.** Replays and editor races are normal for a CMS used by teams, and neither can be solved by the client without these.
- **Drafts at fire time**: a scheduled publish freezes the drafts as they are when it runs, so editors may correct a story until the reveal; the sanity checks run again then.
- **Tags**: publish and archive purge `story:<id>` and `shop:<shopId>`, both at the CDN and in Next.js; the shop tag lets a brand's index page refresh when a story is added.
- **Origin cache TTL is 60 seconds** (not an hour): it bounds staleness even when an invalidation is lost, and costs the durable store one read per story per minute per replica, far below the 2,000 requests per second target.
- **Negative answers are cached for 10 seconds** at the CDN: long enough to blunt scans, short enough not to delay a reveal.
- **Page capacity is 2,500 stories** so that even a story in 20 locales keeps a file under the 50,000-URL protocol limit.
- **Permissions**: S03's existing `products.read` and `products.write` are reused; no new permission is introduced. Reading draft content needs `products.write`.
- **Staleness accepted for shop identity (R3)**: a shop suspension reaches the public story within 10 seconds of the event; slugs do not change while a shop exists.
- **Limits** (5,000 stories per shop, 20 locales, 200 blocks, 256 KiB per draft, 1 MiB body, 365-day schedule horizon, 30-minute preview, 8 deliveries before dead-lettering) are configuration defaults.
- **Product data in a story** is only an ID; prices and availability are composed by the front end at render time (R2) and are not part of this capability's cache.
- **Out of scope for v1**: story deletion, a public list of a shop's stories, image hosting rules beyond `https`, version retention limits (all versions are kept until the shop is deleted), the shop-export contribution (S03 has not defined a shape for other domains' data).
