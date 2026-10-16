---

description: "Task list for S27 — Brand stories CMS (domain `content`)"
---

# Tasks: S27 — Brand stories CMS (domain `content`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/interfaces.md`, `quickstart.md`.

**Tests**: Required (constitution VII, `test-plan.md`). Test-first: for each test-plan row the failing test task comes before the code task. Backend e2e specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>` from `packages/backend`; unit specs with `pnpm jest libs/domains/content/domain`.

**Path shorthand**: `CD/` = `packages/backend/libs/domains/content/`; `CT/` = `packages/contracts/src/stories/`; `MIG/` = `packages/backend/migrations/`.

**Rules for every task**: time only from the platform clock (no `Date`/`new Date()` in `CD/domain/`, no `now()` in SQL); transactions only through `TransactionRunner.run` / `@Transactional`, never a new `sequelize.transaction`; every SQL statement carries `shopId` in its predicate; no import of `ShopModel`, `ShopMembershipModel`, `MembershipService`, `ProductModel` anywhere (use `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`, `ProductQueryService`); every outbound call has a timeout; errors are problem+json with a `code`; never edit a `*.reviewed.json`; never use git checkout/restore/reset/stash/clean; never add a task or command that runs a fresh-stack, standalone-boot, journey/browser or test_doctor check (deferred to the final checkpoint).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Create living-spec page `docs/spec/capabilities/S27-brand-stories.md` (rules and behaviors for drafts, publish, public read, schedule, invalidation, preview, sitemap, lifecycle, tenancy/ops), each rule with `[proof: S27 AS-nn]` pointing at the e2e files of `test-plan.md` and `[code: …]` at real paths of `CD/`; run `python3 scripts/livespec/check.py`; create no `*.reviewed.json`
- [X] T002 [P] Create zod schemas in `CT/` (`story.ts` = `storyAdminSchema`, `storyListItemSchema`, `storyDraftSchema`; `public.ts` = `publicStorySchema`; `version.ts` = `storyVersionSchema`, `storyVersionListItemSchema`; `preview.ts` = `previewTokenSchema`; `events.ts` = payloads of `story.published|archived|schedule_failed` v1; `index.ts`) and export `pageSchema(…)` use exactly as in `specs/domains/S27-brand-stories/contracts/interfaces.md`; error codes listed there (A8, FR-066)
- [X] T003 [P] Add config keys validated at boot in `CD/` config module: `STORY_PREVIEW_SECRET`, `REVALIDATE_SECRET`, `REVALIDATE_URL`, `CDN_ZONE`, `CDN_TOKEN`, `FRONT_HOST`, `BACKEND_HOST` (production start-up fails naming a missing key; logging adapters outside production) and limits with defaults: 5,000 stories/shop, 20 locales, 200 blocks, 256 KiB draft, 1 MiB body, 365-day schedule horizon, 2,500 sitemap page capacity, 30-minute preview TTL (D4, AS-59, FR-034)
- [X] T004 [P] Confirm `fast-check` and `sanitize-html` are dev/runtime dependencies of `packages/backend`; add `fast-check` to `packages/backend/package.json` if absent
- [X] T005 [P] Declare rate policy `content.write.shop` (120/min per shop, fail closed) in `CD/rate-limit-policies.ts` and register it with the S50 registry (C6, AS-94)

---

## Phase 2: Foundational (blocks every story)

**Purpose**: pure domain core, ports, schema, shop copy and guard. Gaps G2, G3, A4, A5, D6, D-6, D-12, ownership FK.

### Unit tests first (pure logic, table-driven `it.each`)

- [X] T006 [P] Write failing `CD/domain/blocks.spec.ts`: every block schema (`heading{level 2|3,text}`, `richText{html}`, `image{url,alt,width,height}`, `product{productId}`, `quote{text,cite?}`, `video{url}`), `Seo{description?,ogImage?}` https-only, exact parsed-host video rule (`www.youtube.com`, `player.vimeo.com`, `stream.marketplace.dev`; reject userinfo/port tricks/suffix hosts), S30 rule: `stream.marketplace.dev` accepts only `/p/<videoId>/master.m3u8` with no query or credential and rejects any `/u/` path; sanitiser table (script, `javascript:`, `on*`, `rel="noopener"`) plus `fast-check` property: sanitising is idempotent and output never contains script, `javascript:` or `on*` (AS-06, AS-08, A4, A5, G3)
- [X] T007 [P] Write failing `CD/domain/locale-chain.spec.ts`: full fallback table (exact → language → default locale → none; never `available[0]`), malformed locale refused (AS-27, C3, G3)
- [X] T008 [P] Write failing `CD/domain/story-input.spec.ts`: slug `^[a-z0-9][a-z0-9-]{1,80}$` and locale (`xx` or `xx-XX`) format tables, unknown property refusal (AS-02, AS-10)
- [X] T009 [P] Write failing `CD/domain/story-status.spec.ts`: transition table `DRAFT→PUBLISHED`, `PUBLISHED→PUBLISHED`, `PUBLISHED→ARCHIVED`, `ARCHIVED→PUBLISHED`, all others `invalid_transition`, with `assertNever`; schedule never changes status (AS-82)
- [X] T010 [P] Write failing `CD/domain/schedule-rules.spec.ts`: past, equal-to-now (`schedule_in_past`), beyond horizon (`schedule_too_far`), bad format, due check never earlier than `scheduledAt` (AS-43)
- [X] T011 [P] Write failing `CD/domain/etag.spec.ts`: `If-None-Match` list, weak `W/`, `*` matching on the `"<id>-v<version>-<locale>"` tag via the S52 matcher (AS-26)
- [X] T012 [P] Write failing `CD/domain/sitemap-position.spec.ts`: position → page with capacity 2,500, page-number parsing (`^\d{1,9}$`, `1.5`, huge, zero, leading zeros), ≤ 50,000 URLs per page at the 20-locale cap (AS-70, AS-72, AS-73)
- [X] T013 [P] Write failing `CD/domain/sitemap-xml.spec.ts`: XML escaping, `xhtml:link` `hreflang` alternates with `x-default`, `lastmod`, shared alternate builder also used by the public body (AS-28, AS-71)
- [X] T014 [P] Write failing `CD/domain/revalidation-signature.spec.ts`: `HMAC-SHA256("<timestamp>.<raw body>")` hex, tamper, wrong secret, age over 5 minutes (AS-51)

### Domain code

- [X] T015 [P] Implement `CD/domain/limits.ts` and `CD/domain/errors.ts` (typed domain errors mapped to problem+json codes: `slug_taken`, `story_limit_reached`, `revision_conflict`, `version_conflict`, `nothing_to_publish`, `no_drafts`, `default_locale_missing`, `default_locale_required`, `invalid_blocks`, `invalid_title`, `payload_too_large`, `locale_limit_reached`, `schedule_in_past`, `schedule_too_far`, `not_scheduled`, `invalid_transition`, `unknown_product_reference`, `story_not_found`, `draft_not_found`, `version_not_found`, `dependency_unavailable`)
- [X] T016 Implement `CD/domain/blocks.ts` (rewrite of the draft: parsed-host video rule, `/p/` vs `/u/` rule, https `Seo.ogImage`, sanitiser options, idempotent sanitise) until T006 passes
- [X] T017 [P] Implement `CD/domain/locale-chain.ts` (move `localeChain` out of blocks) until T007 passes
- [X] T018 [P] Implement `CD/domain/story-input.ts` until T008 passes
- [X] T019 [P] Implement `CD/domain/story-status.ts` until T009 passes
- [X] T020 [P] Implement `CD/domain/schedule-rules.ts` (takes `now` as argument) until T010 passes
- [X] T021 [P] Implement `CD/domain/etag.ts` (id-version-locale tag builder + delegation to toolkit matcher) until T011 passes
- [X] T022 [P] Implement `CD/domain/sitemap-position.ts` until T012 passes
- [X] T023 [P] Implement `CD/domain/sitemap-xml.ts` until T013 passes
- [X] T024 [P] Implement `CD/domain/revalidation-signature.ts` until T014 passes
- [X] T025 Define `CD/domain/ports.ts` tokens and interfaces: `STORY_REPOSITORY`, `DRAFT_REPOSITORY`, `VERSION_REPOSITORY`, `TRANSITION_REPOSITORY`, `SHOP_COPY_REPOSITORY`, `SITEMAP_READER`, `READ_MODEL` (get/put/del), `CDN_PURGER`, `REVALIDATION_CLIENT`, `PRODUCT_REFERENCE_CHECKER`, `SHOP_LOOKUP`, `CLOCK`, `PREVIEW_SIGNER` (D-6, G2)

### Schema

- [X] T026 Add expand migration in `MIG/` (with `lock_timeout`): `StoryDraft.revision int not null default 0`; `Story.scheduledBy uuid null`, `Story.scheduleFailure jsonb null` `{at, code}`, `Story.sitemapPosition bigint null` from sequence `story_sitemap_position_seq` (unique where not null; index where `status='PUBLISHED'`); `StoryVersion.publishedAt`, `StoryVersion.publishedBy uuid`; indexes `(shopId, createdAt desc, id desc)` on `Story`, partial `(scheduledAt, id)` where `scheduledAt is not null`, `(shopId, storyId)` on `StoryDraft`, `(shopId, storyId, version desc)` on `StoryVersion`; drop the foreign key `Story.shopId → "Shop"("id")` (plain uuid column)
- [X] T027 Add migration in `MIG/` creating `StoryTransition` (`id`, `shopId`, `storyId`, `from`, `to`, `action` ∈ `create|publish|schedule|cancel_schedule|fire|fire_failed|archive`, `actor uuid null`, `occurredAt`; PK `id`; index `(shopId, storyId, occurredAt)`) and `StoryShop` (`shopId` PK, `slug`, `status` ∈ `ACTIVE|SUSPENDED|DELETING|DELETED`, `shopVersion bigint`; unique `slug` where status ≠ `DELETED`)
- [X] T028 Add contract-step migration in `MIG/` (separate, after code stops writing it) dropping `SCHEDULED` from the `Story.status` check, converting any existing `SCHEDULED` rows to their prior status plus `scheduledAt` (B4)
- [X] T029 Register `Story`, `StoryDraft`, `StoryVersion`, `StoryTransition`, `StoryShop` as `domain:content` in `packages/backend/db/ownership.ts`; update Sequelize models in `CD/infra/` for the new columns and tables and the model registry (`check:model-registry`)

### Shop copy and guard (D6, C5, A7 partly)

- [X] T030 [P] Write failing `CD/story-tenancy.e2e-spec.ts` cases for AS-97 (shop copy apply, `shopVersion` guard, duplicate delivery, out-of-order, invalid payload dead-lettered, replay) and AS-98 (`shop_deleted` purge of stories/drafts/versions/history/read model, idempotent, resumable in bounded batches); seed shops only via shared fixtures/events, no `ShopModel`
- [X] T031 Implement `CD/infra/shop-copy.repository.ts` (`SHOP_COPY_REPOSITORY`), `CD/infra/shop-copy.consumer.ts` (consumes `tenancy.shop_created|shop_updated|shop_status_changed|shop_deleted` through the S53 consumer framework with inbox, schema validation, `natural` idempotency, `shopVersion` guard, DLQ) and `CD/application/shop-copy.service.ts` (bounded-batch purge on delete) until the AS-97/AS-98 cases pass
- [X] T032 [P] Implement `CD/infra/shop-lookup.adapter.ts` (`SHOP_LOOKUP`) over `ShopQueryService.getShopsByIds` with 2 s timeout for the single write-path lookup (D-12, G6); apply `ShopScoped(permission)` from `@app/domains/tenancy` on every staff route (S03 follow-up: `403 shop_suspended` / `409 shop_offboarding` on write permissions, viewer excluded from writes)

**Checkpoint**: `pnpm jest libs/domains/content/domain` green; AS-97/AS-98 cases green.

---

## Phase 3: User Story 1 — Write a story in several locales (P1) 🎯 MVP

**Goal**: staff create stories, save per-locale drafts with optimistic concurrency, sanitised blocks, list/detail.
**Independent test**: `scripts/sdd/test-spec.sh libs/domains/content/story-drafts.e2e-spec.ts`.

- [X] T033 [US1] Write failing `CD/story-drafts.e2e-spec.ts` (describe "Brand stories: create stories and write drafts (validation, sanitisation, concurrency)"; real modules via `supertest`, production global prefix/pipes/filters; parse every response with the `CT/` schema; assert body and persisted rows) covering AS-01, AS-02 (one case per failure class), AS-03 (duplicate slug, other shop, 10 concurrent creates ×20 iterations, one winner), AS-04 (story limit config 3 → `422 story_limit_reached`), AS-05 (save/read drafts, revision increments), AS-06 (one wired sanitisation case), AS-07 (plain-text fields verbatim, `X-Content-Type-Options: nosniff`), AS-08 (`422 invalid_blocks`, `invalid_title`, `payload_too_large`, 413 body limit, 400), AS-09 (revision conflict; concurrent saves ×20 yield one 200 and the rest 409), AS-10 (locale limit 20 and format), AS-11 (delete a draft locale; default locale protected), AS-12 (list, cursor, status filter, viewer list vs write-only detail)
- [X] T034 [P] [US1] Implement Postgres repositories in `CD/infra/`: `story.repository.ts`, `draft.repository.ts` (conditional `UPDATE … WHERE shopId AND storyId AND locale AND revision = $expected`; revision-0 insert maps unique violation to `revision_conflict`), `transition.repository.ts`; every statement carries `shopId`; keyset list `(createdAt desc, id desc)` with opaque validated cursor (A7, A2)
- [X] T035 [US1] Implement `CD/application/stories.service.ts` (create with slug uniqueness → `409 slug_taken`, story limit, `create` history row, list, detail with drafts) and `CD/application/drafts.service.ts` (save with `expectedRevision`, locale limit, block/title validation + sanitise, 256 KiB limit, delete locale with `expectedRevision`) using `TransactionRunner.run` (A1, A2, A3)
- [X] T036 [US1] Implement `CD/api/stories.controller.ts` (thin; `POST/GET /shops/:shopId/stories`, `GET …/:storyId`, `PUT/DELETE …/drafts/:locale`) with zod DTOs from `CT/` in `CD/api/dto/`, `@UseRateLimit('content.write.shop')` on mutations, 1 MiB body limit, malformed ids → 400, foreign-shop story → `404 story_not_found`; wire in `CD/content.module.ts` (A8, C6, FR-001–006, 060–061, 066)
- [X] T037 [US1] Run `story-drafts.e2e-spec.ts` until green; fix only code, not assertions

---

## Phase 4: User Story 2 — Publish a story and serve it from the edge (P1)

**Goal**: atomic gapless publish with idempotency and cache-friendly public read.
**Independent test**: `story-publish.e2e-spec.ts` and `story-public-read.e2e-spec.ts`.

- [X] T038 [US2] Write failing `CD/story-publish.e2e-spec.ts` (describe "Brand stories: publish, versions, optimistic concurrency and idempotent replay") covering AS-20 (version rows, pointer, history row, outbox row `story.published` in the same transaction), AS-21 (edit after publish, republish v2, v1 intact), AS-22 (one case per refusal: `no_drafts`, `default_locale_missing`, `nothing_to_publish`, `unknown_product_reference` via S05 `getProductsByIds`; S05 down/timeout → `503 dependency_unavailable`, nothing persisted), AS-23 (`expectedVersion` mismatch → 409; 20 concurrent publishes → one success, gapless versions), AS-24 (`Idempotency-Key`: replay returns same body with `Idempotency-Replayed`, in flight → 409, different body → 422, missing key → 422, TTL expiry with frozen clock)
- [X] T039 [P] [US2] Implement `CD/infra/version.repository.ts` (immutable `StoryVersion` rows, no UPDATE path) and `CD/infra/product-reference.adapter.ts` (`PRODUCT_REFERENCE_CHECKER` over `ProductQueryService.getProductsByIds(ids, {shopId})`, 2 s timeout, archived products accepted) (B3)
- [X] T040 [US2] Implement `CD/application/publish.service.ts`: S05 check **before** the transaction; one `TransactionRunner.run` unit: row lock on `Story` (`SELECT … FOR UPDATE` with `shopId`), `expectedVersion` check, gapless `version+1`, copy drafts to `StoryVersion` with `publishedAt/publishedBy`, conditional status `UPDATE`, `StoryTransition` row, `sitemapPosition` allocated at first publish, outbox append `story.published` (topic `stories.events`, key `storyId`); post-commit read-model `DEL` wrapped so a Redis failure never fails the request (B1, B2, B10)
- [X] T041 [US2] Add `POST …/publish` to `CD/api/stories.controller.ts` with platform `@Idempotent` (24 h, header `Idempotency-Replayed`), `expectedVersion` DTO, response `{status, version, locales, publishedAt, scheduledAt}`
- [X] T042 [US2] Run `story-publish.e2e-spec.ts` until green
- [X] T043 [US2] Write failing `CD/story-public-read.e2e-spec.ts` (describe "Brand stories: public read, edge cache headers, conditional requests and locales") covering AS-25 (headers `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<shopId>`, strong ETag, `Content-Language`, no `Vary`, `HEAD`), AS-26 (one wired case per `If-None-Match` form; 304 keeps `Cache-Tag`/`Cache-Control`), AS-27 (one wired fallback case, malformed locale 404), AS-28 (`canonical`, `alternates` with `x-default`, `preview:false`), AS-29 (draft/archived/unknown/suspended-shop/scheduled-not-due 404s indistinguishable with `s-maxage=10`; freed slug), AS-30 (50 concurrent readers on a cold key → one durable read; cache wiped and unreachable falls back to store; origin TTL 60 s), AS-31 (locale removed in a later version → 404 or fallback per rule)
- [X] T044 [P] [US2] Implement `CD/infra/story-read-model.ts` (`READ_MODEL`, key `story:pub:<shopSlug>:<slug>`, TTL 60 s, tolerant of Redis errors) and `CD/infra/public-story.reader.ts` (durable fallback joining `StoryShop` for visibility, never `Shop`) (C4, C5, D-12)
- [X] T045 [US2] Implement `CD/application/public-read.service.ts` (single-flight via `CacheService`, locale chain, `canonical` + alternates + `x-default`, visibility incl. `StoryShop.status`, `withEtag(body, '"<id>-v<version>-<locale>"')` and `buildCacheControl`) and `CD/api/public-stories.controller.ts` (`GET|HEAD /stories/:shopSlug/:slug/:locale`, anonymous, throttled by S50 anonymous profile instead of `skipThrottle`) (C1–C5)
- [X] T046 [US2] Run `story-public-read.e2e-spec.ts` until green

---

## Phase 5: User Story 3 — Schedule a story for its reveal time (P1)

**Goal**: schedule as an attribute, exactly-once fire, lost-job sweep.
**Independent test**: `story-schedule.e2e-spec.ts`.

- [X] T047 [US3] Write failing `CD/story-schedule.e2e-spec.ts` (describe "Brand stories: scheduled publish, stale jobs and the due-schedule sweep") covering AS-40 (schedule a draft; status stays `DRAFT`, `scheduledAt/scheduledBy` set, job enqueued with key `story-publish:<storyId>:<scheduledAt>`), AS-41 (fires at T, drafts at fire time, early delivery ignored), AS-42 (reschedule makes the old job stale; cancel), AS-43 (one wired case per `schedule_in_past`/`schedule_too_far`/bad format), AS-44 (duplicate job delivery and publish-now before T yield exactly one version; ×20 concurrent), AS-45 (scheduled republish keeps v1 live), AS-46 (job lost → sweep publishes within 2 minutes; concurrent sweeps ×20 yield one version), AS-47 (permanent failure per code → `scheduleFailure`, `story.schedule_failed` outbox event, no retry; transient failure retries then `publish_failed` on exhaustion)
- [X] T048 [US3] Implement `CD/application/schedule.service.ts` (schedule via publish route `at`, `DELETE …/schedule` → `409 not_scheduled`, reschedule, `@Idempotent`, `expectedVersion`, enqueue via `JobsService` catching `InvalidScheduleError`, adapt to the discriminated `JobsService.cancel` result) (B4, B5, B8)
- [X] T049 [US3] Implement `CD/infra/stories.jobs.ts`: `declareJobType('stories.publish', {storyId, scheduledAt})` and `declareJobType('stories.publish-due-sweep')` next to the `JobPayloads` augmentation; handler locks the `Story` row, ignores stale/early jobs, re-runs publish checks, `NonRetryableJobError` for permanent codes, exhausted retries → `publish_failed` + `story.schedule_failed`; sweep cron `* * * * *` single-run with `FOR UPDATE SKIP LOCKED` on the partial `(scheduledAt, id)` index; register in `apps/worker` through the content worker module (B6, B7, S49 follow-up)
- [X] T050 [US3] Run `story-schedule.e2e-spec.ts` until green

---

## Phase 6: User Story 4 — Every cache layer is invalidated by tag (P1)

**Goal**: events in the transaction; idempotent consumer clears origin → CDN → signed revalidation.
**Independent test**: `story-revalidation.e2e-spec.ts`.

- [X] T051 [US4] Write failing `CD/story-revalidation.e2e-spec.ts` (describe "Brand stories: cache-tag invalidation consumer (origin, CDN, front end)") covering AS-50 (events recorded in the transaction; bus down at publish still commits and relays later), AS-51 (order origin clear → CDN purge → signed call with `X-Revalidate-Timestamp`/`-Signature`, body `{tags, eventId}`), AS-52 (batching, de-duplication, ≤ 30 tags per call), AS-53 (duplicate delivery: 0 duplicate purges/webhook calls, ×20), AS-54 (CDN transient failure retried ≤ 3 with jitter, permanent 4xx not retried, dead-letter after 8), AS-55 (invalid payload dead-lettered), AS-56 (events out of order), AS-57 (racing reader re-caches old version → second origin clear), AS-58 (shop suspended/reinstated → public 404 / served again, tags purged), AS-59 (logging adapters outside production; production start-up fails naming a missing key); recording fakes for the CDN and revalidation endpoint
- [X] T052 [P] [US4] Define events with `defineEvent` in `CD/application/events/story-events.ts`: `story.published` v1 `{storyId, shopId, shopSlug, slug, version, locales}`, `story.archived` v1 `{storyId, shopId, shopSlug, slug, version}`, `story.schedule_failed` v1 `{storyId, shopId, scheduledAt, code}`; schemas from `CT/events.ts` (D5)
- [X] T053 [P] [US4] Implement `CD/infra/cdn-purger.ts` (`CDN_PURGER`: ≤ 30 tags, 5 s timeout, ≤ 3 in-call retries with full jitter, permanent on 4xx) and `CD/infra/revalidation-client.ts` (`REVALIDATION_CLIENT`: resilient HTTP client, signature from `domain/revalidation-signature.ts`, no silent skip when secret missing in production) (D2, D4)
- [X] T054 [US4] Implement `CD/infra/invalidation.consumer.ts` (S53 consumer: inbox by `eventId`, origin clear → CDN purge → webhook → origin clear again, tags `story:<id>` and `shop:<shopId>`, batch/de-duplicate across a message set, permanent-error rule, DLQ after 8 deliveries) replacing `infra/cache-invalidation.ts` (delete the old file and its `StoryCacheInvalidator` export) (D1–D3)
- [X] T055 [US4] Run `story-revalidation.e2e-spec.ts` until green

---

## Phase 7: User Story 5 — Preview a draft before it is live (P2)

**Independent test**: `story-preview.e2e-spec.ts`.

- [X] T056 [US5] Write failing `CD/story-preview.e2e-spec.ts` (describe "Brand stories: signed preview of drafts") covering AS-60 (mint with `products.write`, locale in body, viewer refused, missing draft `404 draft_not_found`, 30-minute expiry), AS-61 (read via `X-Preview-Token` header: public story shape with `preview:true`, `private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, shows the live draft), AS-62 (one case per rejection — expired, wrong audience, wrong algorithm, wrong secret/session token, other shop/story, tampered, token in query string, suspended shop — all identical 404 `no-store`)
- [X] T057 [US5] Implement `CD/infra/preview-signer.ts` (`PREVIEW_SIGNER`: dedicated `STORY_PREVIEW_SECRET`, pinned HS256, `aud=story-preview`, shop/story/locale binding, clock-based expiry) and `CD/application/preview.service.ts`; add `POST …/preview-token {locale}` to the staff controller and `GET /stories/preview` to `CD/api/public-stories.controller.ts` (E1, E2)
- [X] T058 [US5] Run `story-preview.e2e-spec.ts` until green

---

## Phase 8: User Story 6 — Search engines find every published story (P2)

**Independent test**: `story-sitemap.e2e-spec.ts`.

- [X] T059 [US6] Write failing `CD/story-sitemap.e2e-spec.ts` (describe "Brand stories: streamed sitemap index and child sitemaps") covering AS-70 (index without `count(*)`), AS-71 (child content, `lastmod`, alternates, ≤ 50,000 URLs at 20 locales, suspended-shop and non-public stories excluded), AS-72 (positions stable after archive and later publish; page capacity 2), AS-73 (`stories-1.5.xml`, huge, `0`, empty page → 404), AS-74 (5,000-row config page: 1,000-row batches counted per call, backpressure, generator cancelled on client abort), AS-75 (store fails mid-stream → abnormal termination without clean `</urlset>`; failure before the first batch → 5xx problem+json); headers `application/xml`, `s-maxage=3600`
- [X] T060 [P] [US6] Implement `CD/infra/sitemap.reader.ts` (`SITEMAP_READER`: keyset by `sitemapPosition`, 1,000-row batches, statement timeout, joins `StoryShop` for visibility) (F1, F2, F5, G6)
- [X] T061 [US6] Implement `CD/application/sitemap.service.ts` (index and page streams using `domain/sitemap-position.ts` and `sitemap-xml.ts`, backpressure, abort handling, abnormal termination) and `CD/api/sitemap.controller.ts` (`GET /sitemaps/stories.xml`, `GET /sitemaps/stories-:page.xml`; controller only pipes) (F3, F4)
- [X] T062 [US6] Run `story-sitemap.e2e-spec.ts` until green

---

## Phase 9: User Story 7 — Take a story down, read history, roll back (P2)

**Independent test**: `story-lifecycle.e2e-spec.ts`.

- [X] T063 [US7] Write failing `CD/story-lifecycle.e2e-spec.ts` (describe "Brand stories: archive, version history and restore") covering AS-80 (archive: status, `story.archived` outbox event, public 404 after purge), AS-81 (republish an archived story keeps its sitemap position), AS-82 (one wired case per illegal transition → `409 invalid_transition`), AS-83 (concurrent publish and archive ×20: consistent final state and last event), AS-84 (version list with cursor and detail, immutability, `404 version_not_found`), AS-85 (restore replaces all drafts with the version's locales, advances revisions, requires publish to go live)
- [X] T064 [US7] Implement `CD/application/lifecycle.service.ts` (archive with row lock, transition row, outbox `story.archived`; versions list/detail with keyset; restore in one transaction) and add `POST …/archive`, `GET …/versions`, `GET …/versions/:version`, `POST …/versions/:version/restore` to `CD/api/stories.controller.ts` (B9, A6)
- [X] T065 [US7] Run `story-lifecycle.e2e-spec.ts` until green

---

## Phase 10: User Story 8 — Tenant isolation, lifecycle and operations (P1)

**Independent test**: `story-tenancy.e2e-spec.ts` (AS-97/AS-98 cases already written in T030).

- [X] T066 [US8] Extend `CD/story-tenancy.e2e-spec.ts` (describe "Brand stories: authentication, tenant isolation, shop lifecycle, rate limit and operations") with AS-90 (401 on every staff route), AS-91 (viewer and non-member: 403 `permission_denied` / 404 `shop_not_found`), AS-92 (cross-tenant IDOR on every route with another shop's story/draft/version ids → 404, nothing changed), AS-93 (suspended → `403 shop_suspended` on writes, offboarding → `409 shop_offboarding`, purged shop), AS-94 (rate limit 120/min with frozen clock, `429` with `Retry-After`; limiter outage fails closed), AS-95 (store failure during publish → generic 5xx problem+json, nothing partially persisted), AS-96 (outcome logs and metrics incl. purge lag)
- [X] T067 [P] [US8] Implement `CD/application/story-metrics.ts` (counters for publish/schedule/fire/archive outcomes, purge-lag histogram, alert-worthy structured logs) and wire into services and the consumer (G5, FR-065, AS-96)
- [X] T068 [US8] Ensure outbound timeouts on Redis, DB sitemap batches and S05/S03 calls (config-driven) and audit every repository statement for `shopId` in the predicate (grep `CD/infra/*.repository.ts`); fix any gap (A7, G6, FR-064)
- [X] T069 [US8] Run `story-tenancy.e2e-spec.ts` until green

---

## Phase 11: Polish & cross-cutting

- [X] T070 Reduce the barrel `CD/index.ts` and `CD/content.module.ts` to Nest modules only (API module, worker module, projector module); remove exports of `StoriesWorkerModule`/`StoriesModule`/`StoryCacheInvalidator`/`StoryCacheModule`/`StoriesService`; update imports in `packages/backend/apps/projector/src/projector.module.ts` and `apps/worker` accordingly (G4, D-8, X.4)
- [X] T071 Delete the old `CD/stories.e2e-spec.ts`, old `CD/application/stories.service.ts` raw SQL, `infra/cache-invalidation.ts` and obsolete `CD/api/stories.controller.ts` code once every scenario of `test-plan.md` has its new test (L-017: confirm each AS-nn row has a test before deleting); confirm `content` has zero `sequelize.transaction` sites and no `S54 T037 audit` comments
- [X] T072 Confirm `check:table-ownership --strict` is clean for `content` by inspection of `db/ownership.ts` and raw SQL (no `"Shop"` reference remains in `CD/`; no FK to `Shop`) (AS-99, D-12)
- [X] T073 [P] Write load script `scripts/load-tests/stories.test.js` (k6, origin-miss scenario against the read model: 2,000 rps, p99 < 50 ms) and add `loadtest:stories` to the root `package.json` scripts (SC-003; script only, do not run)
- [X] T074 [P] Record unverified criteria: ensure `specs/domains/S27-brand-stories/quickstart.md` "Ops artifacts" lists SC-003, the CDN/front-end part of SC-001 and the web half, and `specs/UNVERIFIED.md` has one row each (spec S27, criterion, how to run, status `not run`); never mark them verified
- [X] T075 [P] Update `specs/domains/S27-brand-stories/gaps.md` "Sibling-spec follow-ups" with bullets for S03 (`shopVersion` monotonic, slug immutable), S49, S50 (`content.write.shop`), S53 (`stories.events` topic), and W02/web owner (public route, `X-Revalidate-*` receiver, tags, `x-default`/`canonical`); no edits to those specs
- [X] T076 Re-run `python3 scripts/livespec/check.py` and fix any broken `[proof: …]`/`[code: …]` in `docs/spec/capabilities/S27-brand-stories.md` after the final file layout
- [X] T077 Run the whole capability once: `scripts/sdd/test-spec.sh libs/domains/content` plus `pnpm jest libs/domains/content/domain`, `pnpm tsc --noEmit` and lint for `packages/backend` and `packages/contracts`, `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:model-registry`; fix code until green (apps boot and fresh-stack proofs are deferred to the final checkpoint)

---

## Dependencies & execution order

- Phase 1 → Phase 2 (blocks all). Within Phase 2: unit tests (T006–T014) before domain code (T015–T024); T025 before repositories; T026–T029 before any e2e; T030 before T031.
- US1 (Phase 3) is the MVP and precedes US2; US2 precedes US3, US4, US5, US7 (they need published versions and the outbox). US6 needs US2 (positions allocated at first publish). US8 extends T030 and can run after US1.
- Phase 11 after all stories.

## Parallel opportunities

- T002–T005; T006–T014 (distinct spec files); T017–T024 (distinct domain files); T034/T039/T044/T052/T053/T060 (distinct infra files) once their ports exist; T073–T075.

## Gap coverage

A1–A3,A6,A8 → T033–T036, T064; A4,A5 → T006,T016; A7 → T034,T068; B1–B3,B10 → T038–T041; B4–B8 → T047–T049; B9 → T063–T064; C1–C5 → T043–T045; C6 → T005,T036; D1–D5 → T051–T054; D6 → T030–T031; E1–E2 → T056–T057; F1–F5 → T059–T061; G1 → T033–T071; G2,G3 → T025,T006–T007; G4 → T070; G5 → T067; G6 → T032,T068; D-6 → T025; D-7 → T030 (no `ShopModel`); D-8 → T070; D-12/ownership/FK → T026,T029,T072. Follow-ups: S03 → T032,T066; S30 → T006; S49 → T049; S52 → T045.

## Implementation strategy

MVP = Phases 1–3 (US1). Then US2 (publish + public read), US3, US4 (all P1), then US5–US7 (P2), US8 hardening, polish. Each phase ends on its narrowest spec; whole suite once at T077.
