# Gaps: S27 — Brand stories CMS (domain `content`)

The implementation agent's to-do list: what today's code gets wrong or lacks against [`spec.md`](spec.md), the open debt rows that apply to `content`, and the table-ownership findings with the IX.7 mechanism that replaces each. Paths are under `packages/backend/libs/domains/content/` unless stated. Line numbers are those of the draft at the time of writing.

## 1. Code versus spec

### Stories, drafts, concurrency

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | `create` inserts and returns the raw row; a duplicate slug violates the unique key and surfaces as a 500; no story limit; no history row. | `application/stories.service.ts:43-49` | FR-001, AS-01–AS-04 |
| A2 | `PUT drafts` is an unconditional upsert (`ON CONFLICT DO UPDATE`): the last writer wins silently; there is no revision column, no locale limit, no draft delete. | `application/stories.service.ts:51-63`, `migrations/20261001350000-stories.js:25-33` | FR-002, FR-003, AS-09–AS-11 |
| A3 | Block failures answer `400` with a bare `BadRequestException`; no `422 invalid_blocks`, no title rule, no size limits (draft 256 KiB, body 1 MiB), no `payload_too_large`. | `application/stories.service.ts:54`, `api/stories.controller.ts:14-19` | FR-003, AS-08 |
| A4 | Video host check is a prefix regex on the raw string, not an exact host match on the parsed URL; `Seo.ogImage` is only `https`. | `domain/blocks.ts:23` | FR-004, AS-08 |
| A5 | Sanitiser and `rel="noopener"` exist and work; idempotence and the hostile-input corpus are untested. | `domain/blocks.ts:4-9` | FR-005, AS-06, AS-07 |
| A6 | No staff read endpoints: no list, no detail with drafts, no versions list or detail, no restore. | `api/stories.controller.ts` | FR-006, FR-018, AS-12, AS-84, AS-85 |
| A7 | Queries by `storyId` alone after a separate `own()` check (check-then-act), so the shop is not in the predicate of the actual read or write; every `UPDATE`/`SELECT` must carry `shopId`. | `application/stories.service.ts:52,66,68,75-77,192-195` | FR-060, AS-92 |
| A8 | Controller input is hand-validated (locale regex in the method, `NotFoundException` on a bad locale); responses are untyped objects; no `packages/contracts` schemas for any story route. | `api/stories.controller.ts:45-46`, `packages/contracts` | FR-066, II.1, V.2 |

### Publish, versions, schedule

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | No `expectedVersion`, no `Idempotency-Key`: a replayed or concurrent publish creates a duplicate version with identical content; no `nothing_to_publish`, `no_drafts` is a 400, no default-locale rule. | `application/stories.service.ts:82-97` | FR-010–FR-013, AS-20–AS-24 |
| B2 | Version number is computed by `max(version)+1` under a row lock but there is no status history row, no `publishedBy`; `publishedAt` lives only on the story. | `application/stories.service.ts:84-96`, `migrations/20261001350000-stories.js:11-44` | FR-010, AS-20 |
| B3 | Product blocks are never checked against the catalog. | `domain/blocks.ts:25` | FR-011, AS-22 |
| B4 | `SCHEDULED` is a status: scheduling a republish of a live story makes the public read (`status='PUBLISHED'`) return 404. | `application/stories.service.ts:67-69,115` | FR-014, AS-45 |
| B5 | A past or equal time publishes immediately, silently; no horizon limit. | `application/stories.service.ts:67` | FR-014, AS-43 |
| B6 | Unguarded: the scheduled run compares `scheduledAt` as an ISO string without a row lock, so two deliveries can both pass the check before either publishes (the later `publishNow` serialises, but both create versions). | `application/stories.service.ts:75-80` | FR-015, AS-44 |
| B7 | No sweep: a lost job means the reveal never happens; no `scheduleFailure`, no `story.schedule_failed`; a failing job just retries on the scheduler's defaults. | `stories.module.ts:15-25` | FR-016, FR-017, AS-46, AS-47 |
| B8 | A scheduled publish records no actor (`scheduledBy`), and drafts reflect the fire time without re-running checks. | `application/stories.service.ts:65-80` | FR-015, AS-41 |
| B9 | No archive operation and no `story.archived` event (the migration allows the `ARCHIVED` value, nothing uses it); no cancel-schedule route; no illegal-transition checks. | `migrations/20261001350000-stories.js:16`, `api/stories.controller.ts` | FR-018, AS-80–AS-83 |
| B10 | Network I/O ordering: the cache `DEL` and the shop SQL happen after commit but outside any failure handling; a Redis error after commit turns a successful publish into a 500. | `application/stories.service.ts:99-102` | FR-010, AS-95 |

### Public read, cache, ETag

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | Locale is a query parameter; `Vary: Accept-Language` is sent although the server ignores the header; `max-age=60` is sent; 404 has no cache header; no `HEAD`; no `x-default`/`canonical`. | `api/stories.controller.ts:67-77`, `application/stories.service.ts:110-141` | FR-020–FR-023, AS-25–AS-29 |
| C2 | ETag comparison is `ifNoneMatch === etag`: no list, weak or `*` forms; the 304 repeats no `Cache-Tag`; handled in the controller instead of the cache toolkit (S52). | `api/stories.controller.ts:76` | FR-022, AS-26 |
| C3 | Locale fallback ends with `available[0]` when the default is absent, so a request can be served from an arbitrary locale; no validation of the requested locale. | `domain/blocks.ts:34-37` | FR-020, AS-27 |
| C4 | Origin cache: TTL 3600 s, not single flight (stampede on a cold key), a Redis error fails the request, a reader racing a publish can re-cache the old version for an hour. | `application/stories.service.ts:111-121` | FR-025, FR-033, AS-30, AS-57 |
| C5 | Public visibility ignores the shop's status (no suspended-shop rule) and reads the shop through SQL. | `application/stories.service.ts:113-118` | FR-024, AS-29, AS-58 |
| C6 | Anonymous routes use `skipThrottle: true` and there is no rate profile for staff writes. | `api/stories.controller.ts:66,88,105` | FR-061, AS-94 |

### Invalidation

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | The consumer does not clear the origin entry (the service does, before the event is relayed); the order origin → CDN → front end is not guaranteed and there is no second clear. | `infra/cache-invalidation.ts:61-82` | FR-031, FR-033, AS-51, AS-57 |
| D2 | No inbox: duplicate events purge and call the webhook again; no dead-letter reason, no bounded redelivery policy, no permanent-error rule for CDN `4xx`; a CDN failure aborts the webhook call. | `infra/cache-invalidation.ts:67-81` | FR-032, AS-53–AS-55 |
| D3 | Tags are not batched across the events of one message set beyond a `Set`; the 30-tag chunking exists in the adapter only. | `infra/cache-invalidation.ts:30-41,67-69` | FR-031, AS-52 |
| D4 | Revalidation signature is `HMAC(body)` with `at` inside the body, header `x-revalidate-signature`, and the call is skipped silently when no secret is set; no timestamp header, no `eventId`; production does not fail at start-up without CDN or secret config. | `infra/cache-invalidation.ts:71-81,86-91` | FR-031, FR-034, AS-51, AS-59 |
| D5 | Only `story.published` exists; archive and failure events do not; the event lacks `shopSlug`. | `application/events/story-events.ts:4-10` | FR-030, AS-50 |
| D6 | No handling of tenancy events (suspend, reinstate, delete). | — | AS-58, AS-97, AS-98 |

### Preview

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | Token signed with the session `jwt_secret`, no `aud`, no pinned algorithm, no shop or locale binding checked, token in a query string; the response is the raw draft row (no `id`, `version`, `alternates`), `Cache-Control: private, no-store` only; no `noindex` or `no-referrer`. | `application/stories.service.ts:143-160`, `api/stories.controller.ts:80-85` | FR-040, FR-041, AS-60–AS-62 |
| E2 | Minting requires only `products.read`, so viewers can read drafts; the preview does not check the shop's status or the story's existence beyond the draft row. | `api/stories.controller.ts:54-58` | FR-040, AS-60, AS-62 |

### Sitemap

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | `OFFSET page*50000` to find the page start and `count(*)` for the index: offset pagination and a full count on an unbounded table. | `application/stories.service.ts:162-166,187-190` | FR-051, AS-70 |
| F2 | 50,000 stories per page with one `<url>` per locale: a file can hold 1,000,000 URLs, over the protocol's 50,000 limit; no stable position, so a page shifts when any earlier story is archived. | `api/stories.controller.ts:25,113-119`, `application/stories.service.ts:162-185` | FR-050, FR-051, AS-71, AS-72 |
| F3 | There is no `try/catch` around the stream: a mid-stream error leaves the response half-written with no defined termination, there is no abort handling and the generator is not cancelled when the client disconnects. | `api/stories.controller.ts:105-122` | FR-052, AS-74, AS-75 |
| F4 | A bad page number is `404`; `stories-1.5.xml` and huge numbers are not covered; the XML, header and loop logic live in the controller. | `api/stories.controller.ts:108-111` | FR-050, AS-73, II.1 |
| F5 | Suspended shops and non-public stories are not filtered; the `lastmod` is `publishedAt` of the story (correct per version), alternates have no `x-default`. | `application/stories.service.ts:172-181` | FR-050, AS-71 |

### Tests and layering

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | The e2e spec calls `StoriesService` directly for every write, injects `ShopModel` from tenancy (D-7), calls `StoryCacheInvalidator.project` by hand, and has no 401, IDOR, validation, concurrency, idempotency, rate-limit, failure or double-delivery case. Replace it with the nine e2e files and nine unit specs of `test-plan.md`. | `stories.e2e-spec.ts:1-127` | VII.2–VII.5, VII.8 |
| G2 | `application/` runs raw SQL through the injected `Sequelize` connection and `infra` classes (`RedisService`, `JobsService`) directly instead of repositories behind `domain/` ports; the key helper and `PublicStory` live in `application/`. | `application/stories.service.ts:2-9,31-41` | I.2, III.1 (debt D-6) |
| G3 | `domain/blocks.ts` is correct as pure logic but `localeChain` and the sanitiser options have no unit specs; the SQL and the cache key format are not behind ports, so the e2e tests cannot inject store faults at the edge. | `domain/blocks.ts` | VII.5, VII.9 |
| G4 | The barrel exports `StoriesWorkerModule`, `StoriesModule`, `StoryCacheInvalidator`, `StoryCacheModule`; `StoriesModule` exports `StoriesService`; `apps/projector` and `apps/worker` wire the pieces by importing those names. | `index.ts:7`, `stories.module.ts:12,28-32`, `apps/projector/src/projector.module.ts:2,54` | X.4 (debt D-8) |
| G5 | No metrics or structured outcome logs; no purge-lag signal; no alert-worthy log lines. | — | FR-065, AS-96 |
| G6 | No outbound timeout on the Redis, DB and S05/S03 calls beyond the HTTP client's; no statement timeout for the sitemap batches. | `application/stories.service.ts` | FR-064 |

### New things the spec needs that do not exist

- Migrations (expand/contract with `lock_timeout`, III.11): `StoryDraft.revision`; `Story.scheduledBy`, `scheduleFailure`, `sitemapPosition` (never reused, allocated from a sequence at first publish) and drop `SCHEDULED` from the status check after code stops writing it; `StoryVersion.publishedAt`, `publishedBy`; new tables `StoryTransition` and `StoryShop` (the shop copy, with `shopVersion`); drop the foreign key `Story.shopId → Shop.id`; add every new table to `db/ownership.ts` as `domain:content`.
- Events `story.archived`, `story.schedule_failed`, and the `shopSlug` field of `story.published`.
- Consumers for `tenancy.shop_created|updated|status_changed|deleted` (in `content/infra/`, deployed through `apps/projector`).
- Jobs `stories.publish` (revised) and `stories.publish-due-sweep`.
- Rate policy `content.write.shop`; config keys for the preview secret, the revalidation secret, CDN zone and token; start-up validation.
- Contract schemas in `packages/contracts` for every endpoint of Provides.
- A load-test script `scripts/load-tests/stories.test.js` for SC-003.

## 2. Open debt rows that name `content` or S27

Source: `docs/work/architecture/debt-register.md`. No row names `content` or S27 explicitly; the generic rows below apply to this domain's code (checked against the findings of §3). D-1 to D-5, D-9 to D-11 and D-13 to D-17 do not.

| Debt | What in this capability | Where | Replaced by |
|---|---|---|---|
| D-6 (I.2 layering) | `application/stories.service.ts` talks to Postgres and Redis directly and imports `infra` classes (G2). | `application/stories.service.ts` | Repository ports and tokens in `domain/` (stories, drafts, versions, history, shop copy, read model, event inbox) with adapters in `infra/`. |
| D-7 (IX.4 model exports) | The e2e spec imports and injects `ShopModel` (tenancy). Production code of `content` injects no foreign model. | `stories.e2e-spec.ts:9,15` | Seed shops through the shared fixtures and S03's exported provisioning service or events; no model import. |
| D-8 (X.4 barrel exports internals) | The barrel exports a worker module, the cache invalidator and its module. | `index.ts:7` | `apps/projector` and `apps/worker` import a `content` projector/worker module through the barrel; no consumer, purger or service class is exported. |
| D-12 (IX.4 raw SQL on another domain's table) | Three raw SQL statements read tenancy's `Shop`. | `application/stories.service.ts:100,115,175` | Single write-path lookup → **R1** `ShopQueryService.getShopsByIds`; public read, sitemap and visibility → **R3**: the `StoryShop` copy fed by `tenancy.shop_created|updated|status_changed|deleted` (S03 gaps already name `content` as consumer). |

## 3. `pnpm --dir packages/backend check:table-ownership` — content lines

Run at the time of writing, whole-repo output: 87 findings in 21 domains; `content` has **1** line:

| Kind | Finding | Where | Owner of the fix | Mechanism |
|---|---|---|---|---|
| SQL | `Shop` (owned by tenancy) referenced in raw SQL | `application/stories.service.ts` (the three statements at lines 100, 115 and 175) | S27 | R1 for the single write-path lookup (D-12); R3 copy `StoryShop` for the public read, sitemap and status visibility |

Not reported by the tool but required by IX.4 and to be fixed by S27: the foreign key `Story.shopId REFERENCES "Shop"("id")` in `migrations/20261001350000-stories.js:13` (a cross-domain FK; replace with a plain ID column, no FK); the e2e spec's `ShopModel` import (D-7, `stories.e2e-spec.ts:9`). After S27, `pnpm --dir packages/backend check:table-ownership --strict` must report no `content` line (AS-99).

## 4. Cross-capability dependencies this capability waits on

| Needs | From | Notes |
|---|---|---|
| `ShopScoped(permission)` with status gate, `ShopQueryService.getShopsByIds`, events `tenancy.shop_created|updated|status_changed|deleted` with `shopVersion` | S03 | S03 `gaps.md` already lists `content` as the consumer of the R3 slug projection. |
| `ProductQueryService.getProductsByIds(ids, {shopId})` | S05 | AS-22. |
| Delayed jobs with idempotency key, permanent-failure outcome, single-run cron | S49 | AS-41–AS-47. |
| Rate policy registry entry `content.write.shop` | S50 | AS-94. |
| Strong-ETag conditional GET, single-flight cache-aside | S52 | AS-26, AS-30. |
| Outbox append in a transaction, consumer framework with inbox, DLQ and retry | S53 | AS-50–AS-55, AS-97, AS-98. |
| Problem+json filter, config validation, resilient HTTP client, idempotency-key facility | S54 | AS-24, AS-59, AS-95. |
| `Firewall`, `@User()` | S01 | All routes. |
| A web owner for the story pages, the revalidation route and the editor UI | W-capability to be assigned | Until then the UI column of `test-plan.md` is empty and the revalidation call has no real receiver. |

## Spec changes

No human-signed page existed for S27 and no `*.reviewed.json` was created or touched. The implementation created the living-spec page `docs/spec/capabilities/S27-brand-stories.md` first (rules R-01 to R-26, behaviors B-01 to B-10, every one with `[proof: S27 AS-nn]`); it is unsigned.

## Sibling-spec follow-ups

- **S03**: `tenancy.shop_*` events must keep `shopVersion` monotonic and the slug immutable; S27 consumes them as the R3 source and drops its direct read of `Shop`.
- **S49**: add a permanent-failure outcome and single-run cron facility use as documented in `NonRetryableJobError`; S27 relies on both for `stories.publish` and the sweep.
- **S50**: registry entry `content.write.shop` (120/min per shop, fail closed) is declared by S27 in `content/rate-limit-policies.ts`.
- **S53**: topic `stories.events` (key `storyId`) and the event types `story.published|archived|schedule_failed` are new.
- **S03**: the registered `tenancy.shop_deleted` payload is `{shopId, shopVersion}` (the S27 spec text says `{shopId}`); S27 consumes the registered definition from `@app/domains/tenancy`, so `shopVersion` is required of the producer. The status gate of `ShopScoped('products.read')` also refuses the story list in a `SUSPENDED` or `DELETING` shop (S03's `WHILE_SUSPENDED` list holds only `shop.read`, `members.read`, `shop.export`); S27 relies on that and does not add its own gate.
- **S54**: the problem code `invalid_transition` carries the current status as `currentStatus` (the member `status` is the problem document's HTTP status); `slug_taken` and `version_conflict` are raised with S27's wording but not registered in the catalog (tenancy and several domains already register them with other wording).
- **W02 (or the assigned web owner)**: adopt the public route `GET /api/stories/:shopSlug/:slug/:locale`, the revalidation receiver (`X-Revalidate-Timestamp`/`-Signature`, reject timestamps older than 5 minutes, idempotent), tags `story:<id>`/`shop:<id>`, and the `x-default`/`canonical` data.

## Implementation notes (decisions taken while building)

- A `DELETING` shop keeps its live stories public until `tenancy.shop_deleted` (`questions.md`, LOCAL line, S03 allows reads in `DELETING`); `FR-024` says "ACTIVE". The code follows `questions.md`: public read and sitemap show `ACTIVE` and `DELETING`, a preview needs `ACTIVE`, a scheduled publish needs `ACTIVE` (`shop_not_active`).
- A status event is applied to the copy every time it is delivered (so a replay rebuilds an empty copy), while clearing the caches is decided by the inbox per `eventId` and repeated when an earlier try failed.
- `StoryShop.slug` is nullable: a `shop_status_changed` may arrive before `shop_created`; the slug is set once, status and version only move forward.
- The invalidation consumer uses `natural` idempotency plus `InboxService.claim/markStatus` (not `recordOnce`): `recordOnce` needs a transaction, and a network call must not run inside one (III.9). A failure of either target throws a plain error, so the framework's attempt budget (8) ends in the dead letter; a permanent CDN refusal and an invalid payload are `PermanentError`.
- Configuration added: `STORY_PREVIEW_SECRET`, `REVALIDATE_URL`, `CDN_ZONE`, `CDN_TOKEN`, `CDN_API_URL` in `libs/common/config/stories-config.ts` (the production rule names a missing key and never a value). The limits (`stories_*`) are read by the domain from the environment, upper-cased.
- The k6 script is `packages/backend/scripts/load-tests/stories.test.js` and `pnpm loadtest:stories` lives in `packages/backend/package.json` next to the other load tests (the root `package.json` has none).
- Not done by this capability: the e2e specs were written after the code of their phase (the unit specs of the domain core were run red first); every spec was run green and the whole capability once at the end.

## Gate repairs

- Test integrity: the old `stories.e2e-spec.ts` (no scenario ids) was deleted, which the gate refuses. Recreated at the same path as a real lifecycle walk-through (draft → publish → read → republish → locale fallback → preview) on the new story-client fixtures, titled S27 AS-05/06/20/21/23/25/27/60/61. No product code changed.
- `libs/domains/identity/infra/crypto/secret-box.spec.ts` (`S01 AS-67 › rejects a tampered tag`) failed outside this capability: the helper tampered with a part by overwriting its last two base64url characters with `AA`. The 16-byte GCM tag encodes to 22 characters whose last one carries 2 unused bits, so about 1 run in 1000 the tampered tag decoded to the same bytes and `open` correctly did not throw. The helper now changes the first character of the part (all six bits significant), so the tamper always changes the bytes. The assertions are unchanged and `SecretBox` is untouched.
