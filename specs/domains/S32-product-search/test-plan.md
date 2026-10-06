# Test Plan: S32 — Product Search (domain `discovery`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/discovery/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`ProductSearchModule`, `SearchProjectorModule`, `SearchWorkerModule` as the file needs, plus the identity, tenancy and rate-limit modules they depend on) with the production pipe, filter, prefix and interceptors, against real Postgres (migrated), Redis, the real search engine of the production major version, the Kafka stand-in and ClickHouse from `docker-compose.test.yaml`. Time is frozen with the shared clock helper, state is reset in `beforeEach` (database tables, the live name and every versioned index, the synonym set, topics, click tables), and seeding goes through the shared fixture helpers (`createUser`, `createShop(owner)`, `addMember`) plus an **event publisher helper** that delivers real envelopes of `catalog.product_*`, `tenancy.shop_*`, `media.gallery_changed` and `marketing.product_sponsorship_changed` to the real consumer entry points (the catalog's tables are never seeded to feed search). Every test asserts the response **and** the persisted state (index documents, shop search rows, run and history rows, synonym versions, emitted messages, click rows, DLQ entries, counters).
- Only system-edge dependencies are faked: the embedding provider (deterministic test provider placing chosen phrases near each other), identity token verification, and the media and tenancy exported services where a scenario needs them to fail. **Fault injection** uses real mechanisms: a TCP fault proxy in front of the search engine, of Redis and of the Kafka stand-in (`test/fakes/tcp-fault-proxy.ts`: refuse, hang, delay), a database lease expiry on the job table for worker crashes, and a gate around the embedding provider for timeouts.
- Consumers (`catalog.product_*`, `tenancy.shop_*`, `media.gallery_changed`, `marketing.product_sponsorship_changed`, `search.result_clicked`) have the duplicate-delivery and invalid-payload tests of VII.4 (AS-24, AS-33, AS-72).
- Reindex scenarios drive the real job through the real job table and worker module; the "client searching during the run" of AS-40 is a loop of real `supertest` calls in the same process.
- R1 services (`ProductSearchService`, `ProductTitleSuggester`) are exercised from a test module that imports only `@app/domains/discovery` (AS-78, AS-79).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); AS-86 also has a `fast-check` property test. No unit tests for controllers, repositories, consumers or glue.
- UI journeys (Playwright, owned by W02 and W04, happy path only): `packages/web/tests/search.spec.ts` and `packages/web/tests/seller.spec.ts`. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (AS-80).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`productSearchResponseSchema`, `shopProductSearchResponseSchema`, `reindexRunSchema`, `searchIndexStatusSchema`, `synonymsSchema`, `searchQualityReportSchema`) and emitted events with `searchEventSchemas`.
- The load proof of SC-001 and SC-003 (`loadtest:search` plus the reindex-during-load scenario with error rate 0) is an operations artifact, not an e2e row.

Abbreviations for the e2e files (all under `libs/domains/discovery/`):

| Key | File | Top-level `describe` |
|---|---|---|
| Q | `search-query.e2e-spec.ts` | `Public product search API` |
| F | `search-facets-semantic.e2e-spec.ts` | `Search facets and semantic mode` |
| P | `search-projection.e2e-spec.ts` | `Search index projection` |
| R | `search-reindex.e2e-spec.ts` | `Zero-downtime search reindex` |
| Y | `search-synonyms.e2e-spec.ts` | `Search synonyms administration` |
| S | `shop-product-search.e2e-spec.ts` | `Shop product search` |
| M | `search-measurement.e2e-spec.ts` | `Search click-through measurement` |
| A | `search-admin.e2e-spec.ts` | `Search administration access and status` |
| B | `search-platform.e2e-spec.ts` | `Search exported services and module boundary` |

Unit files (all under `libs/domains/discovery/domain/`): `projection-guard.spec.ts`, `reindex-run-status.spec.ts`, `synonym-rules.spec.ts`, `search-cursor.spec.ts`, `query-text.spec.ts`, `popularity-bucket.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy path | Q: 200 body parses, headers, item shape (no vector or score), one engine query, `search.performed` emitted | `search.spec.ts` search "espresso", open a result | — |
| AS-02 typo tolerance | Q: swapped letters, exact above fuzzy, first-letter rule, no match | — | — |
| AS-03 field weights | Q: title > brand > description > tags | — | — |
| AS-04 browse mode | Q: no `q`, `q=`, spaces; business order; no event | — | — |
| AS-05 business boosts | Q: one signal at a time (stock, rating, popularity, tier, sponsored), missing signals neutral | — | — |
| AS-06 boosts never bury text | Q: exact-title product beats a maxed-out weak match | — | — |
| AS-07 hidden products | Q: archived, sandbox, deleted, suspended/deleting/deleted shop across items, total, facets, semantic; restore and reinstate | — | — |
| AS-08 sort | Q: three sorts, tie-break by id, repeatable | `search.spec.ts` sort selector updates the URL | — |
| AS-09 cursor paging | Q: 20/20/5 no dup no gap, wrong query/filter/sort/altered cursor 422, insert between pages | — | — |
| AS-10 validation classes | Q: table-driven over every class incl. removed parameters, 422 price range, zero engine queries | — | — |
| AS-11 hostile text | Q: operators, wildcard, fullwidth, control characters, emoji | — | — |
| AS-12 anonymous and rate limit | Q: anonymous 200, 429 with `Retry-After`, isolation, limiter down (fault proxy) fails open | — | — |
| AS-13 engine failure | Q: refused and slow (fault proxy) → 503 problem+json, no leak, counter, recovery | — | — |
| AS-14 filters | Q: combination, order unchanged by a filter, empty result and its event | `search.spec.ts` price filter updates the URL and results | — |
| AS-15 facet shape and counts | F: counts over all matches, top 20, four price keys, average, sums | `search.spec.ts` facets listed beside results | — |
| AS-16 facet selection keeps siblings | F: category, brand, price selections; `inStock` applies to all | `search.spec.ts` choose a category, siblings remain | — |
| AS-17 facet absence and emptiness | F: absent, empty, more than 20 categories | — | — |
| AS-18 semantic search | F: parka found, 10 of 60 with filter | — | — |
| AS-19 semantic rules | F: no `q`, with facets, with cursor, vector missing, hidden excluded | — | — |
| AS-20 provider failure | F: gated provider times out → lexical, `degraded`, counter, event field | — | — |
| AS-21 embeddings at indexing | F: created, price-only update (provider spy), title update, provider failure + backfill job | — | — |
| AS-22 created searchable | P: event → found after refresh, document fields, checkpoint | — | — |
| AS-23 out-of-order | P: v3 then v2 and v2 then v3, stale counter, no DLQ | — | — |
| AS-24 duplicates | P: same eventId twice; other eventId same version; one document | — | — |
| AS-25 archive and restore ordering | P: archive, late update, restore, restore-before-archive | — | — |
| AS-26 delete is remembered | P: delete, late created/updated, purge job at +30 d + 1 s and before | — | — |
| AS-27 sandbox | P: ignored, counter, no document | — | — |
| AS-28 shop status | P: suspend, later product, reinstate, stale event, unknown shop, either order | — | — |
| AS-29 offboarding and deletion | P: started, cancelled, reordered by `occurredAt`, deleted purges both stores, later events ignored, repeat | — | — |
| AS-30 plan tier | P: PRO boost visible, old version ignored, unknown plan DLQ | — | — |
| AS-31 sponsorship | P: flag and label, late false ignored, never reveals hidden, early arrival kept | — | — |
| AS-32 image | P: first media thumb, empty list, old version, image first, product update keeps image | — | — |
| AS-33 invalid and unknown messages | P: each invalid class DLQ with no change, next message processed, unknown type ack | — | — |
| AS-34 coalescing | P: 30 updates → one engine write at v31 | — | — |
| AS-35 engine outage in projection | P: not acked, backoff, recovery loses nothing, permanent rejection DLQ | — | — |
| AS-36 freshness | P: event → public ≤ 10 s, shop table ≤ 5 s, lag metric | — | — |
| AS-37 popularity | P: job buckets, only changed written, no version change, update keeps it, concurrent runs once | — | — |
| AS-38 shop state backfill | P: R1 batch ≤ 500, suspended hidden, unknown stays active, resumable, rerun no-op | — | — |
| AS-39 reindex happy path | R: 202, transitions, same documents and versions, previous kept, run view, history, event | — | — |
| AS-40 zero downtime | R: 50 searches per second during the run, 0 errors, count never below start | — | — |
| AS-41 changes during the build | R: create, update, archive, delete, suspend during `BUILDING`, final equality | — | — |
| AS-42 one active run | R: 409 with `runId` in every active status, `Promise.all` of two triggers, rollback blocked, new run after terminal | — | — |
| AS-43 cancel and illegal transitions | R: cancel in each active status, cleanup, 409 on terminal runs, 404, 400, cancel racing the switch | — | — |
| AS-44 failure leaves search untouched | R: rejected batch and count mismatch → `FAILED`, cleanup, new run accepted, engine failure reason | — | — |
| AS-45 crash and resume | R: lease expiry mid-build resumes once; crash after switch recovers without second switch | — | — |
| AS-46 rollback | R: switch back with all later updates, second rollback rolls forward, none retained 409 | — | — |
| AS-47 retention | R: before and after 24 h, parallel writes stop, never deletes live or active target | — | — |
| AS-48 legacy concrete index | R: atomic replacement while searching | — | — |
| AS-49 mapping and model versions | R: `outdated` true then false, no startup mutation, vectors recomputed or carried | — | — |
| AS-50 first start | R: two instances boot, one empty index, 200 empty, status, first run fills; existing alias untouched | — | — |
| AS-51 shop table rebuilt | R: missing rows restored, deleted absent, no older version | — | — |
| AS-52 who may run it | A: 401, 403 (owner, user, service), audit line, 429 past `discovery.search-admin`, over every admin route | — | — |
| AS-53 synonyms live update | Y: before/after, 200 body, same index, no run, no rewrite | — | — |
| AS-54 rule kinds | Y: one-way, two-way, multi-word | — | — |
| AS-55 synonym validation | Y: one request per error class → 422 with codes, unchanged state; body shape 400 | — | — |
| AS-56 concurrent edits | Y: `Promise.all` one 200 one 409, winner's rules, stale 409 | — | — |
| AS-57 idempotent replay | Y: same body twice, stale version with identical rules, no engine call | — | — |
| AS-58 engine failure | Y: 503, rules and version unchanged, later success | — | — |
| AS-59 rules survive a reindex | Y: reindex then same answers | — | — |
| AS-60 read and audit | Y: GET body, audit line, history of 20 versions and 90 days | — | — |
| AS-61 shop search happy path | S: member, archived listed with status, filter, shape | `seller.spec.ts` search inventory by text | — |
| AS-62 typos | S: fallback, garbage, word cap | — | — |
| AS-63 cross-tenant | S: other shop's member 404 identical to unknown, same titles in two shops stay separate | — | — |
| AS-64 authentication and status gate | S: 401, viewer 200, suspended 403, deleting 409, deleted 404 | — | — |
| AS-65 validation | S: table-driven, cursor misuse 422 | — | — |
| AS-66 paging | S: 25/25/10, tie-break by id | — | — |
| AS-67 lifecycle and freshness | S: create, rename, archive, restore, delete within 5 s, sandbox shop, shop deleted → 404 | — | — |
| AS-68 hostile input | S: eight hostile strings, table intact | — | — |
| AS-69 rate limit | S: 429, isolation, limiter down | — | — |
| AS-70 click recorded | M: 202 empty body, event, click row | `search.spec.ts` clicking a result posts a click | — |
| AS-71 click validation and forgery | M: forged, altered, expired, bad fields, 429 | — | — |
| AS-72 click consumer | M: duplicate → one row, invalid → DLQ | — | — |
| AS-73 quality report | M: exact numbers, window, ordering, parameter errors | — | — |
| AS-74 privacy of the log | M: email, digits, card, short query, hash stability, no ids, expiry setting | — | — |
| AS-75 logging never hurts search | M: stream down (fault proxy) → 200/202 and counter | — | — |
| AS-76 event contents | M: each mode and filter set parses with `searchEventSchemas` | — | — |
| AS-77 index status | A: shape, values around a run, 401/403 | — | — |
| AS-78 exported search service | B: module importing only the entry point, same visibility, limit 20 | — | — |
| AS-79 title suggestions port | B: visible only, size cap, abort, typed timeout | — | — |
| AS-80 boundaries | B: static gates and an app that loads only these modules | — | — |
| AS-81 version guard decision | — | — | `projection-guard.spec.ts` (`it.each` over stored × incoming × kind; `assertNever`) |
| AS-82 run state machine | — | — | `reindex-run-status.spec.ts` (`it.each` over every pair; `assertNever`) |
| AS-83 synonym grammar | — | — | `synonym-rules.spec.ts` (`it.each` over each valid and invalid rule) |
| AS-84 cursor codec | — | — | `search-cursor.spec.ts` (`it.each` round trip, fingerprint, tampering) |
| AS-85 query normalisation and redaction | — | — | `query-text.spec.ts` (`it.each`) |
| AS-86 popularity bucket and boost cap | — | — | `popularity-bucket.spec.ts` (`it.each` plus `fast-check`: monotone, bounded, multiplier in [1, 4]) |

## Mandatory case check (VII.3)

| Endpoint | Happy | Validation | 401 | Cross-tenant / IDOR | Rate limit | State guard | Concurrency |
|---|---|---|---|---|---|---|---|
| `GET /products/search` | AS-01 | AS-10 | n/a (public) | AS-07 (hidden shops) | AS-12 | — | — |
| `GET /shops/:shopId/products/search` | AS-61 | AS-65 | AS-64 | AS-63 | AS-69 | AS-64 | — |
| `POST /search/clicks` | AS-70 | AS-71 | n/a (public) | n/a | AS-71 | — | — |
| `POST /admin/search/reindex` | AS-39 | AS-52 | AS-52 | n/a (admin) | AS-52 | AS-42 | AS-42 |
| `GET /admin/search/reindex[/:runId]` | AS-39 | AS-43 (malformed id) | AS-52 | n/a | — | — | — |
| `POST /admin/search/reindex/:runId/cancel` | AS-43 | AS-43 | AS-52 | n/a | — | AS-43 | AS-43 |
| `POST /admin/search/rollback` | AS-46 | — | AS-52 | n/a | — | AS-46, AS-47 | AS-42 |
| `PUT /admin/search/synonyms` | AS-53 | AS-55 | AS-52 | n/a | — | — | AS-56 |
| `GET /admin/search/synonyms` | AS-60 | — | AS-52 | n/a | — | — | — |
| `GET /admin/search/quality` | AS-73 | AS-73 | AS-52 | n/a | — | — | — |
| `GET /admin/search/index` | AS-77 | — | AS-52 | n/a | — | — | — |
