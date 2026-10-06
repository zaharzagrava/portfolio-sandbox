# Test Plan: S27 — Brand stories CMS (domain `content`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (67 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves the pure rule table; the API e2e entry of the same row proves one wired case through the real stack, never the table again.

- API e2e files live in `packages/backend/libs/domains/content/` and boot the real `content` modules (HTTP, worker, projector consumers) plus the tenancy and identity modules they import, with the production global prefix, `ValidationPipe`, problem+json filter and interceptors, called through `supertest`, against real Postgres (migrations applied), Redis and the Kafka stand-in from `docker-compose.test.yaml`. Each file's top-level `describe` names its feature (VII.8). The existing `stories.e2e-spec.ts` calls services directly and imports `ShopModel`: it is replaced by the files below.
  - `story-drafts.e2e-spec.ts` — describe "Brand stories: create stories and write drafts (validation, sanitisation, concurrency)"
  - `story-publish.e2e-spec.ts` — describe "Brand stories: publish, versions, optimistic concurrency and idempotent replay"
  - `story-public-read.e2e-spec.ts` — describe "Brand stories: public read, edge cache headers, conditional requests and locales"
  - `story-schedule.e2e-spec.ts` — describe "Brand stories: scheduled publish, stale jobs and the due-schedule sweep"
  - `story-revalidation.e2e-spec.ts` — describe "Brand stories: cache-tag invalidation consumer (origin, CDN, front end)"
  - `story-preview.e2e-spec.ts` — describe "Brand stories: signed preview of drafts"
  - `story-sitemap.e2e-spec.ts` — describe "Brand stories: streamed sitemap index and child sitemaps"
  - `story-lifecycle.e2e-spec.ts` — describe "Brand stories: archive, version history and restore"
  - `story-tenancy.e2e-spec.ts` — describe "Brand stories: authentication, tenant isolation, shop lifecycle, rate limit and operations"
- Shops, members and products are seeded only through the shared fixture helpers, the identity fixture (`SessionIssuer`) and the exported services or events of identity, tenancy and catalog; no spec injects `ShopModel` or `ProductModel` (D-7). Tenancy events (`shop_created`, `shop_updated`, `shop_status_changed`, `shop_deleted`) are delivered through the real consumers with contract-valid envelopes from fixtures. The clock is frozen and advanced explicitly (schedules, preview expiry, idempotency TTL, revalidation timestamp).
- Only system edges are faked: identity token verification, the CDN purge API and the Next.js revalidation endpoint (recording fakes with switchable failure, delay and status), S05's `getProductsByIds` and S03's `getShopsByIds` where a failure or timeout must be forced (switchable wrappers at the exported-service edge, never stubbing content's own services), the event bus (a spy with a switchable failure), the rate limiter outage, and the clock. Faults for the origin cache and the durable store are injected through switchable wrappers at the driver edge, which also count reads per call (AS-30, AS-74). Configuration overrides: story limit 3, page capacity 2 (AS-72) and 5,000-row page (AS-74), locale limit 20, rate window 120 per minute, schedule horizon 365 days.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `blocks.spec.ts` (block schemas, URL and video-host rules, sanitiser table plus a `fast-check` property: sanitising is idempotent and the output never contains script, `javascript:` or `on*`), `locale-chain.spec.ts`, `story-input.spec.ts` (slug and locale format tables), `story-status.spec.ts` (the status model table with `assertNever`), `schedule-rules.spec.ts` (past, now, horizon), `etag.spec.ts` (`If-None-Match` list, weak and `*` matching), `sitemap-position.spec.ts` (position → page, page-number parsing, ≤ 50,000 URLs per page at the locale cap), `sitemap-xml.spec.ts` (escaping, `hreflang`, `x-default`), `revalidation-signature.spec.ts` (`HMAC("<timestamp>.<body>")`, tamper and age checks). Controllers, repositories and glue get no unit tests.
- UI journey (Playwright): no web capability owns the story pages, the revalidation route or the editor today (see `questions.md`, CONTRACT). The UI column is therefore empty for every row; when a web capability is assigned its single happy-path journey is "staff publishes a story, the public page shows it", and edge cases are never re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (no `content` finding); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback and degradation tests that force the fault: AS-22 (S05 down), AS-30 (origin cache wiped and unreachable), AS-47 (permanent and transient failure at fire time), AS-46 (job lost), AS-50 (bus down at publish), AS-54 (CDN failures), AS-55 (poison payload), AS-75 (store fails mid-stream and before the first batch), AS-94 (limiter outage), AS-95 (store failure during publish).
- Concurrency tests use `Promise.all`, assert the allowed outcome and the invariant, repeated at least 20 times in one test: AS-03, AS-09, AS-23, AS-30 (50 readers), AS-44, AS-46, AS-83.
- Rate-limit tests (VII.3) freeze the clock: AS-94. Idempotency tests (VII.3): AS-24 (replay, in flight, different body, TTL). State-transition guard: AS-82.
- Async consumers (VII.4): each consumer gets a double-delivery test and an invalid-payload test. Invalidation consumer: AS-53, AS-55. Shop-copy consumer: AS-97. Shop-deleted consumer: AS-98. The scheduled-publish job and the sweep: AS-44, AS-46.
- Every e2e response is parsed with the matching `packages/contracts` schema (VII.6) and every test asserts the response body and the persisted state (story, draft, version, history and shop-copy rows, outbox rows, origin cache entries with their TTL, recorded jobs, recorded CDN and webhook calls) (VII.2).
- The k6 script `scripts/load-tests/stories.test.js` (`pnpm loadtest:stories`: origin-miss scenario against the read model) proves SC-003. It is an operations artifact, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create a story | `story-drafts.e2e-spec.ts` | — | — |
| AS-02 create validation (slug, locale, unknown property) | `story-drafts.e2e-spec.ts` (one case per failure class) | — | `story-input.spec.ts` |
| AS-03 duplicate slug, other shop, 10 concurrent creates | `story-drafts.e2e-spec.ts` | — | — |
| AS-04 story limit | `story-drafts.e2e-spec.ts` | — | — |
| AS-05 save and read drafts, revisions | `story-drafts.e2e-spec.ts` | — | — |
| AS-06 rich-text sanitisation | `story-drafts.e2e-spec.ts` (one wired case) | — | `blocks.spec.ts` (sanitiser table, idempotence property) |
| AS-07 plain-text fields verbatim, nosniff | `story-drafts.e2e-spec.ts` | — | — |
| AS-08 block, title, size and body-limit failures | `story-drafts.e2e-spec.ts` (one case per failure class: 422 invalid_blocks, invalid_title, payload_too_large, 413, 400) | — | `blocks.spec.ts` (every block rule and video-host case) |
| AS-09 revision conflict, concurrent saves | `story-drafts.e2e-spec.ts` | — | — |
| AS-10 locale limit and locale format | `story-drafts.e2e-spec.ts` | — | `story-input.spec.ts` |
| AS-11 delete a draft locale | `story-drafts.e2e-spec.ts` | — | — |
| AS-12 list stories, cursor, filters, viewer vs detail | `story-drafts.e2e-spec.ts` | — | — |
| AS-20 publish now: version rows, pointer, history, outbox | `story-publish.e2e-spec.ts` | — | — |
| AS-21 edits after publish, republish, old version intact | `story-publish.e2e-spec.ts` | — | — |
| AS-22 unpublishable drafts, S05 reference check and outage | `story-publish.e2e-spec.ts` (one case per refusal) | — | — |
| AS-23 `expectedVersion`, concurrent publishes | `story-publish.e2e-spec.ts` | — | — |
| AS-24 idempotency: replay, in flight, different body, missing key, TTL | `story-publish.e2e-spec.ts` | — | — |
| AS-25 public read, headers, HEAD | `story-public-read.e2e-spec.ts` | — | — |
| AS-26 conditional requests, 304 | `story-public-read.e2e-spec.ts` (one wired case per form) | — | `etag.spec.ts` (list, weak, `*`) |
| AS-27 locale fallback table, malformed locale | `story-public-read.e2e-spec.ts` (one wired case) | — | `locale-chain.spec.ts` (full table) |
| AS-28 canonical and alternates with `x-default` | `story-public-read.e2e-spec.ts` | — | `sitemap-xml.spec.ts` (alternate builder shared with the sitemap) |
| AS-29 indistinguishable 404 cases, freed slug | `story-public-read.e2e-spec.ts` | — | — |
| AS-30 read model, single flight, cache wiped and unreachable | `story-public-read.e2e-spec.ts` | — | — |
| AS-31 locale removed in a later version | `story-public-read.e2e-spec.ts` | — | — |
| AS-40 schedule a draft story | `story-schedule.e2e-spec.ts` | — | — |
| AS-41 job fires at T, drafts at fire time, early delivery | `story-schedule.e2e-spec.ts` | — | — |
| AS-42 reschedule, stale job, cancel | `story-schedule.e2e-spec.ts` | — | — |
| AS-43 past, now, too far, bad format | `story-schedule.e2e-spec.ts` | — | `schedule-rules.spec.ts` |
| AS-44 duplicate job delivery, publish-now before T | `story-schedule.e2e-spec.ts` | — | — |
| AS-45 scheduled republish keeps v1 live | `story-schedule.e2e-spec.ts` | — | — |
| AS-46 lost job and the sweep, concurrent sweeps | `story-schedule.e2e-spec.ts` | — | — |
| AS-47 permanent and transient failure at fire time | `story-schedule.e2e-spec.ts` (one case per code, plus transient) | — | — |
| AS-50 events recorded in the transaction, bus down | `story-revalidation.e2e-spec.ts` | — | — |
| AS-51 consumer order, signed revalidation call | `story-revalidation.e2e-spec.ts` | — | `revalidation-signature.spec.ts` |
| AS-52 batching, de-duplication, ≤ 30 tags | `story-revalidation.e2e-spec.ts` | — | — |
| AS-53 duplicate event delivery | `story-revalidation.e2e-spec.ts` | — | — |
| AS-54 CDN failures: retry, permanent, dead-letter | `story-revalidation.e2e-spec.ts` | — | — |
| AS-55 invalid payload dead-lettered | `story-revalidation.e2e-spec.ts` | — | — |
| AS-56 events out of order | `story-revalidation.e2e-spec.ts` | — | — |
| AS-57 racing reader re-caches old version | `story-revalidation.e2e-spec.ts` | — | — |
| AS-58 shop suspended and reinstated | `story-revalidation.e2e-spec.ts` | — | — |
| AS-59 logging adapters and production start-up check | `story-revalidation.e2e-spec.ts` | — | — |
| AS-60 mint a preview token | `story-preview.e2e-spec.ts` | — | — |
| AS-61 read a preview, headers, live draft | `story-preview.e2e-spec.ts` | — | — |
| AS-62 rejected tokens, identical 404 | `story-preview.e2e-spec.ts` (one case per rejection) | — | — |
| AS-70 sitemap index | `story-sitemap.e2e-spec.ts` | — | `sitemap-position.spec.ts` |
| AS-71 child sitemap content and limits | `story-sitemap.e2e-spec.ts` | — | `sitemap-xml.spec.ts` (escaping, alternates, ≤ 50,000 URLs at the locale cap) |
| AS-72 stable positions after archive and publish | `story-sitemap.e2e-spec.ts` | — | `sitemap-position.spec.ts` |
| AS-73 bad page numbers, empty page | `story-sitemap.e2e-spec.ts` | — | `sitemap-position.spec.ts` (page parsing) |
| AS-74 backpressure, batches, client abort | `story-sitemap.e2e-spec.ts` | — | — |
| AS-75 store failure mid-stream and before first batch | `story-sitemap.e2e-spec.ts` | — | — |
| AS-80 archive a published story | `story-lifecycle.e2e-spec.ts` | — | — |
| AS-81 republish an archived story | `story-lifecycle.e2e-spec.ts` | — | — |
| AS-82 illegal transitions | `story-lifecycle.e2e-spec.ts` (one wired case per refusal) | — | `story-status.spec.ts` (full table) |
| AS-83 concurrent publish and archive | `story-lifecycle.e2e-spec.ts` | — | — |
| AS-84 version list and detail, immutability | `story-lifecycle.e2e-spec.ts` | — | — |
| AS-85 restore a version and republish | `story-lifecycle.e2e-spec.ts` | — | — |
| AS-90 401 on every staff route | `story-tenancy.e2e-spec.ts` | — | — |
| AS-91 viewer and non-member | `story-tenancy.e2e-spec.ts` | — | — |
| AS-92 cross-tenant IDOR on every route | `story-tenancy.e2e-spec.ts` | — | — |
| AS-93 suspended, offboarding, purged shop | `story-tenancy.e2e-spec.ts` | — | — |
| AS-94 rate limit and limiter outage | `story-tenancy.e2e-spec.ts` | — | — |
| AS-95 generic 5xx, nothing partially persisted | `story-tenancy.e2e-spec.ts` | — | — |
| AS-96 logs and metrics | `story-tenancy.e2e-spec.ts` | — | — |
| AS-97 shop copy: apply, guard, duplicate, out of order, invalid, replay | `story-tenancy.e2e-spec.ts` | — | — |
| AS-98 shop deleted purge, idempotent, resumable | `story-tenancy.e2e-spec.ts` | — | — |
| AS-99 static ownership and boundary checks | — (static gates above) | — | — |
