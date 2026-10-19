# Tasks: J04 — Catalog Sync to Search

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/journey-kit.md`, `quickstart.md`, `test-plan.md` (23 rows), `gaps.md` (27 rows, re-rated in research.md §1), `questions.md` (defaults accepted).
**Tests**: requested (test-plan.md, constitution VII.8). In every phase the failing test task comes before the code task that makes it pass.
**Paths** are under `packages/backend/` unless marked `ROOT/`. Journey file: `test/journeys/catalog-sync-to-search.journey-spec.ts`; scenario titles keep the stable `J04 AS-nn` prefix (L-017). Run one spec with `ROOT/scripts/sdd/test-spec.sh <path>`; one scenario with `pnpm test:journeys -- -t "J04 AS-nn"`; after backend edits run `bash scripts/sdd/stack-fix.sh api-ready` first; env/start-script changes: `bash scripts/sdd/stack-fix.sh api-restart`. A run over 10 minutes: `nohup … > specs/journeys/J04-catalog-sync-to-search/journeys-run.log` and poll in the foreground with `sleep 240; tail`.
**Not tasks (final checkpoint, run by the loop)**: standalone boots of core/worker/projector/local-monolith, fresh-stack run, full `pnpm test:journeys`, doctor comparison, whole capability suites, the 100x loops of SC-001..SC-008 (L-012, L-018, L-019).
**Rule 0**: edit the capability page in `ROOT/docs/spec/capabilities/` before each behaviour change; keep `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`); never create or edit a `*.reviewed.json`; a change to a human-signed page goes under `## Spec changes` in gaps.md. Touched files with `sequelize.transaction` and `// S54 T037 audit` → migrate to `TransactionRunner.run`/`@Transactional` and delete the comment; never add a direct site.
**Follow-ups from built specs (requirements)**: S07 → AS-01/AS-03 treat `DONE` / `catalogsync.import_finished` (via status + replayable SSE terminal event) as the trigger, then wait for S32's projection (T019, T022); S09 → AS-10..AS-13 carry "offline device sells stock" = S09 AS-01 + AS-52 and assert search, pickup and provider (T028..T030).

## Phase 1: Setup (docs first, kit skeleton)

- [X] T001 Edit living-spec pages first (rule 0) in `ROOT/docs/spec/capabilities/`: S08 (`ALLOWED_PROVIDER_HOSTS` allow-list, refused in production; `catalogsync.import_finished` is the registered event name, spec text says `catalog_sync.import_finished`), S53 (canonical aliases `integrations-stock-push`, `offline-sync-feed`, `pickup-availability`; topics `pickup.events`, `tenancy.events`, `catalog-sync.events`), S49 (job types `catalog-sync.sync-all`, `catalog-sync.reconcile-all`, `catalog-sync.recover-stalled-imports`, `search.reindex`), S26 (import-origin fan-out policy). Keep every `[proof:]`/`[code:]` true; run `python3 scripts/livespec/check.py`.
- [X] T002 [P] Add hop rows `J04.H1`..`J04.H16` (`{maxMs, owner, what}` exactly as the spec.md hop table: H1 30000, H3/H7/H8/H10/H11/H14 10000, H4 30000, H5/H6/H13/H15 15000, H12 5000, H16 5000 to start) to `test/journeys/support/wait-for-contract.ts`; deadline `2 × maxMs × JOURNEY_TIME_FACTOR`; failure message names hop and owner; no fixed sleeps.
- [X] T003 [P] Add missing response schemas to `ROOT/packages/contracts/src/` (grep first, reuse existing): `importJobSchema`, `integrationSchema` (`linkedProducts`, `lastSyncAt`, `lagSeconds`, `lastError`, `openConflicts`), `conflictPageSchema`, `productPageSchema`, `productSearchResponseSchema`, `syncPushResponseSchema` (per-op `applied|replayed`, `quantityAfter`, `productVersion`), `syncPullResponseSchema`, near-me page schemas (`{items, nextCursor}`, `priceMinor`, `currency`).
- [X] T004 Create the journey shell `test/journeys/catalog-sync-to-search.journey-spec.ts`: top-level `describe("Journey J04: catalog sync to search")`, nested `describe` US1..US8 in order, unique run token `j04<run>`, `afterAll` calls `controlSurface.restoreAll()` (resumes every consumer, resets clock); serial (L-029). Add J04 variables and fixtures to `test/journeys/README.md`.

## Phase 2: Foundational (names, topics, allow-list, doubles — nothing is drivable without them)

- [X] T005 [P] Write failing e2e `libs/infrastructure/projections/consumer-groups.e2e-spec.ts` (WP2; G-11/G-15/G-18/G-22): `GET /api/admin/consumers/integrations-stock-push`, `/offline-sync-feed`, `/pickup-availability` each answer `{state, lag}`; pause/resume of an alias acts on all its real groups (`catalog-sync-product-events` + the tenancy group; `catalog-sync-offline-feed`; `pickup-index-stock|shop|product|point`) and leaves other groups running; `search-product-index` and `product-cache-invalidator` still resolve; real group names keep working (offsets kept).
- [X] T006 Register the three aliases in `libs/infrastructure/projections/consumer-groups.ts` per data-model.md table (aliases, not renames).
- [X] T007 [P] Write failing e2e in `libs/domains/identity/admin-jobs.e2e-spec.ts` (WP2, G-22): `POST /api/admin/jobs` accepts `catalog-sync.sync-all`, `catalog-sync.reconcile-all`, `catalog-sync.recover-stalled-imports`, `search.reindex`; each run twice leaves state unchanged; unknown type 422; non-admin 403.
- [X] T008 Add the missing J04 job types to the allow-list in `libs/domains/identity/api/jobs-admin.controller.ts` and register idempotent handlers through the owners' exported services only (catalog-sync, discovery).
- [X] T009 Add topics `pickup.events`, `tenancy.events`, `catalog-sync.events` (key = aggregate id) to `scripts/init-kafka-topics.sh` (G-19; L-002/L-011); verify `KafkaTopicGroup` in `libs/infrastructure/outbox/outbox.model.ts` names them; verify `pickup.events` payload carries `stockVersion` and a no-op `PUT stock` emits nothing — if not, add a failing e2e then fix in `libs/domains/fulfilment/`.
- [X] T010 [P] Write failing e2e `libs/domains/catalog-sync/integration-boundary.e2e-spec.ts` (G-08/G-26, FR-018): with `ALLOWED_PROVIDER_HOSTS=127.0.0.1:<port>` the Shopify adapter reaches that host:port; any other loopback/private host stays refused by the SSRF guard; startup fails with `NODE_ENV=production` and the list set; empty list = today's behaviour.
- [X] T011 Implement `ALLOWED_PROVIDER_HOSTS` (host:port list, validated at start, refused in production) in `libs/common/config/local-profile-config.ts` and pass it as the `safeRequest` allow option for listed host:port only in `libs/domains/catalog-sync/infra/provider-http.ts` and the Shopify adapter/provider.
- [X] T012 [P] Write failing e2e for the scanner wiring (G-26, FR-018) in `libs/domains/catalog-sync/`: with `clamav_host` pointing at a clamd-protocol TCP server a clean import proceeds and an EICAR stream ends `FAILED`; unset `clamav_host` outside the explicit local profile still refuses the scan (mandatory); production refuses local-profile doubles.
- [X] T013 Wire the local profile in `apps/local-monolith/` (settings: `clamav_host`, `ALLOWED_PROVIDER_HOSTS`, `SEARCH_REFRESH_INTERVAL=1s`, `CLOCK_CONTROL`, `PROVIDER_DOUBLES`) so one deployment hosts core, worker, projector and realtime gateway; every double/setting refused when `NODE_ENV=production`. Put the journey address on the rate-limit allow-list for import, sync, near-me and search policies (`test/journeys/support/rate-limits.ts` and local profile) (G-25).
- [X] T014 [P] Create `test/journeys/support/shopify-double.ts`: HTTPS server (self-signed, trusted by CA fingerprint like the J02 receiver) with OAuth token exchange, products/variants (draft ignored), inventory levels, signed webhooks (HMAC, delivery id), `writeLog[{variantId,set,expected}]`, `answer(200|409|503|hang)`, `sell(variant,n)`; `start()` returns host:port for `ALLOWED_PROVIDER_HOSTS`; stopped in `afterAll`.
- [X] T015 [P] Create `test/journeys/support/scanner-double.ts`: clamd streaming-protocol TCP server (`INSTREAM`), answers clean unless the stream contains EICAR; reached through `clamav_host`.
- [X] T016 [P] Create `test/journeys/support/catalog-fixture.ts`: `csv(rows, opts)` (60-row builder with `externalSku`, title token `j04<run>`), `zipAsCsv()`, `uploadParts(start)` PUT to presigned URLs, `startAndComplete()` with `Idempotency-Key`; idempotent (409 → open existing, L-010); each story creates its own products (L-005).
- [X] T017 [P] Create `test/journeys/support/pickup-fixture.ts` (point at a coordinate, shopper 1.2 km away, `setStock`, `adjust` with `Idempotency-Key`) and `test/journeys/support/device-client.ts` (`X-Device-Id`, HLC, UUIDv7 `opId`, `push`, `pull(cursor)`), responses parsed with T003 schemas.
- [X] T018 Extend `test/journeys/support/control-surface.ts`: `restoreAll()` also resumes the five canonical groups and the J04 queue consumers and resets the clock; idempotent, exits 0 when nothing is paused (L-013/L-016); `test/journeys/support/global-teardown.ts` calls it as last resort.

**Checkpoint**: aliases, topics, allow-list, doubles and fixtures exist; the journey can drive and observe the chain.

## Phase 3: User Story 1 — Bulk file becomes a searchable catalog, exactly once (P1) 🎯 MVP

**Goal**: AS-01..AS-04. **Independent test**: `pnpm test:journeys -- -t "US1"`.

- [X] T019 [US1] Write failing journey tests `J04 AS-01` and `J04 AS-02` in the journey file: 60-row CSV upload → complete (`202`) → poll status or replayable SSE `import:{importId}` to `DONE` (H1) → every product in `GET /shops/:id/products` (H2, `version` 1) → `waitForContract('J04.H3')` on `GET /products/search?q=j04<run>`; same `Idempotency-Key` + same file changes nothing (no version bump, no event; asserted after consumer `lag: 0`).
- [X] T020 [US1] Write failing journey tests `J04 AS-03` and `J04 AS-04`: changed prices re-imported reach search (H3), stock untouched, `version` +1 only for changed rows; a ZIP renamed `.csv` ends `FAILED`, writes nothing, nothing reaches search.
- [X] T021 [US1] Make AS-01..AS-04 pass: fix each broken hand-off in its owner (S07 start/complete/scan/parse/`import_finished` + SSE terminal replay, S05 unchanged-row no-event, S32 projection shape and `projectionLagSeconds`); after each fix `bash scripts/sdd/stack-fix.sh api-ready` and re-run `-t "J04 AS-0n"`.
- [X] T022 [US1] Confirm the S07 follow-up in code: the journey's trigger is `DONE`/`catalogsync.import_finished` through status/SSE and never consumes `catalog-sync.events`; comment it in the journey; fix any import path that publishes the terminal state before the last batch commits.

## Phase 4: User Story 2 — Shopify store joins the catalog and stays current (P1)

**Goal**: AS-05..AS-07. **Independent test**: `-t "US2"`.

- [X] T023 [US2] Write failing journey tests `J04 AS-05` and `J04 AS-06`: install → double OAuth → callback `302 ?connected=` (duplicate callback answers `400`) → backfill (H4: `linkedProducts` = 7 active variants, drafts ignored) → searchable (H3); signed webhook updates once (H5); duplicate delivery id and bad signature (`401`, identical for unknown integration) change nothing.
- [X] T024 [US2] Write failing journey test `J04 AS-07`: change a variant in the double without a webhook; `POST /api/admin/jobs {type:'catalog-sync.sync-all'}` (H16, H6) → product updated, `lastSyncAt` moves; the pulled value is never echoed back to the double.
- [X] T025 [US2] Make AS-05..AS-07 pass in S08 (`libs/domains/catalog-sync/`): OAuth/callback idempotency, `integrations.manage` permission, webhook dedupe / 401 / 503 on enqueue failure / 1 MiB cap, sync-all job handler, `integrationSchema` fields.

## Phase 5: User Story 3 — A stocked product is available near me (P1)

**Goal**: AS-08, AS-09. **Independent test**: `-t "US3"`.

- [X] T026 [US3] Write failing journey tests `J04 AS-08` and `J04 AS-09`: `PUT …/pickup-points/:pid/stock/:productId` → `GET /search/near` shows the offer (H7), `GET /pickup-points/near?productId=` exact; title, price, archive and restore of the catalog product reach near-me (H8) and search (H3); `Idempotency-Key` adjustment applies once; schemas parsed (`{items,nextCursor}`, `priceMinor`).
- [X] T027 [US3] Make AS-08/AS-09 pass in S19 (`libs/domains/fulfilment/`): product copy from `catalog.product_*` version-guarded, `product_not_found` for another shop's product (R1 `getProductsByIds(ids,{shopId})`), no-op stock write emits nothing; S05 archive/restore events.

## Phase 6: User Story 4 — Offline device sells stock and every copy follows (P1)

**Goal**: AS-10..AS-13. **Independent test**: `-t "US4"`.

- [X] T028 [US4] Write failing journey tests `J04 AS-10` and `J04 AS-11`: device `D1` pushes a sale (−3) for a Shopify-linked product → catalog `quantityAfter`/`productVersion` (H9), search `inStock`/availability (H10), exactly one `writeLog` entry (H11) with `expected`, echo webhook causes no event/write; replaying the same `opId` returns `replayed` with no second effect, `op_id_reused` on a changed body; selling out sets `inStock:false`.
- [X] T029 [US4] Write failing journey tests `J04 AS-12` and `J04 AS-13`: sale of a CSV (unlinked) product never calls Shopify (`writeLog` empty after `lag: 0` plus hop max); pickup count moves only by its own route (S19 adjustment); second device `D2` pulls the sale in order, gap-free `seq` (H12).
- [X] T030 [US4] Make AS-10..AS-13 pass: S09 push via `applyStockDelta(sync:<shopId>:<opId>)`, per-op results, `offline-sync-feed` consumer; S08 stock-push consumer (three-way merge on `syncedStock`, conditional write, coalesce, ignore unlinked/sandbox/echo); S32 `inStock` follow. Fix in owners.
- [X] T031 [P] [US4] Static audit WP1 (G-02, G-04; D-7/D-8/D-10/D-12/D-15): grep `libs/domains/{orders,auctions,payments}` and every domain for raw `Product` quantity SQL and raw `products.events` inserts (`order.service`, `order.jobs`, `auction.jobs`, `payment.service`, `checkout.service`); for each hit write a failing e2e in its own domain, then migrate to `applyStockDelta` with `operationId <service>:<aggregate>:<step>`; fix the stale discovery comment at `libs/domains/catalog/infra/models/product.model.ts:137`; migrate touched `// S54 T037 audit` sites.

## Phase 7: User Story 5 — Both sides sell, provider down (P2)

**Goal**: AS-14..AS-16. **Independent test**: `-t "US5"`.

- [X] T032 [US5] Write failing journey tests `J04 AS-14` and `J04 AS-15`: device sale and Shopify-side sale in either order converge to `local + remote − base` on both sides (H13); oversold clamps both sides to 0 and opens exactly one conflict visible through `conflictPageSchema` (`openConflicts` 1).
- [X] T033 [US5] Write failing journey test `J04 AS-16`: double `answer(503)` → device sale still accepted (FR-010), `lastError` set; `answer(200)` + next trigger (job or webhook) repairs without reversing the sale.
- [X] T034 [US5] Make AS-14..AS-16 pass in S08/S09 (merge rule `domain/stock-merge.ts`, clamp + conflict, outage retry/lease); fix owners only.

## Phase 8: User Story 6 — Consumer down, duplicate and out-of-order deliveries (P2)

**Goal**: AS-17..AS-19. **Independent test**: `-t "US6"`.

- [X] T035 [US6] Write failing journey tests `J04 AS-17` and `J04 AS-18`: pause `search-product-index` → sale leaves search stale while other consumers progress, `projectionLagSeconds` > 0; resume → `lag: 0` (H15) and converged; pause `integrations-stock-push`, three sales → resume → one coalesced Shopify write with the final value.
- [X] T036 [US6] Write failing journey test `J04 AS-19`: record every observable (search doc, near-me, feed, product versions, Shopify `writeLog`), replay `search-product-index`, `pickup-availability`, `offline-sync-feed`, `integrations-stock-push` from the journey start (duplicates and old-after-new) → identical snapshot, zero new Shopify writes.
- [X] T037 [US6] Make AS-17..AS-19 pass in S53/S32/S19/S08 (version guards `min-version`, coalescing, replay without provider writes, alias pause/replay acting on every real group).

## Phase 9: User Story 7 — Boundaries hold (P2)

**Goal**: AS-20..AS-22. **Independent test**: `-t "US7"`.

- [X] T038 [US7] Write failing journey tests `J04 AS-20` and `J04 AS-21`: `POST /admin/shops/:id/suspend` hides products in search and near-me (H14), import start refused, push/pull halted, Shopify webhook ignored; reinstate restores; owner of another shop gets 403/404 on import, integration, sync, product, pickup stock (`product_not_found`, `integration_not_found`).
- [X] T039 [US7] Write failing journey test `J04 AS-22`: four writers (seller edit, import, Shopify, device) each change one product; `productVersion` rises by exactly one per accepted change, no gaps or duplicates.
- [X] T040 [US7] Make AS-20..AS-22 pass: S03 `tenancy.shop_status_changed` producer and consumers (`search-product-index`, `pickup-availability`, `integrations-stock-push`), `ShopNotActiveError` before any write in S07/S08/S09, IDOR checks, single-writer versioning in S05.

## Phase 10: User Story 8 — Operators can see progress (P3)

**Goal**: AS-23. **Independent test**: `-t "US8"`.

- [X] T041 [US8] Write failing journey test `J04 AS-23`: import status counters and SSE terminal replay for a late subscriber, integration `lagSeconds`/`lastError`, `GET /admin/search/index` `projectionLagSeconds`, consumer `{state,lag}`; a member sees the import stream, a removed member loses it, non-admin gets 403 on admin reads.
- [X] T042 [US8] Make AS-23 pass in S07/S08/S32/S51/S53 (member policy via S03 `assertMember`, replayable terminal event).

## Phase 11: Cross-cutting fixes the journey exposes

- [X] T043 [P] Write failing e2e in `libs/domains/community/` (G-24, WP6): importing 60 products creates no per-product `new_product` feed item for followers (coalesced to one summary or skipped by the event's `source`); a seller's single create still does.
- [X] T044 Implement the policy in `libs/domains/community/infra/feed-projectors.ts` (skip or coalesce import-origin creates using the event's `source`); keep the S26 page (T001) true; migrate touched direct transactions.
- [X] T045 [P] Write failing e2e for rate-limit policies (G-25): import start, sync push/pull, near-me and search each use their own policy (`libs/domains/catalog-sync/rate-limit-policies.ts`, `fulfilment.near-search`, discovery) and the journey-address allow-list works; then fix mapping gaps in `libs/infrastructure/rate-limit/rate-limit.types.ts`.

## Phase 12: Polish — docs, ledger, static gates (code and docs only)

- [X] T046 Update `gaps.md`: add `## Spec changes` (signed pages changed, if any) and `## Sibling-spec follow-ups` (e.g. **S07**: event name `catalogsync.import_finished`; **S53**: aliases registered; **S26**: import-origin policy; **S19**: `stockVersion` on `pickup.events`); mark each G-01..G-27 status per research.md (G-12 superseded).
- [X] T047 Ops artifacts: confirm quickstart.md "Ops artifacts" lists SC-001..SC-006 and SC-008 with how-to-run and "not run", and that the seven matching rows exist in `ROOT/specs/UNVERIFIED.md` (spec J04, criterion, how to run, status `not run`); never describe them as verified; SC-007/SC-009 are proven by AS-17..AS-19 and the no-sleep check.
- [X] T048 [P] Add a unit check `libs/domains/catalog-sync/journey-no-sleep.spec.ts` (the unit runner does not cover test/) asserting the J04 journey and its support files contain no `setTimeout(`/`sleep(`/fixed delays (L-003, SC-009).
- [X] T049 Make static gates clean on touched paths: `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (nine domains), `pnpm check:module-graph`, `tsc --noEmit`, `python3 scripts/livespec/check.py`; direct `sequelize.transaction` count in touched domains has not risen.

## Dependencies & execution order

- Phase 1 → Phase 2 (T005/T007/T010/T012/T014–T017 parallel; T006 after T005, T008 after T007, T011 after T010, T013 after T012) → stories.
- US1 → US2 → US3 → US4 (needs a linked product from US2 and a searchable one from US1) → US5, US6 (need US4) → US7 → US8; US3 independent of US2. T031 and Phase 11 run as slices expose them. Phase 12 last.
- Parallel: [P] tasks in Phases 1–2; T031, T043, T045 any time after Phase 2.

## Implementation strategy

MVP = Phases 1–3 (kit + US1 file-to-search). Then one slice at a time: write the journey scenario, run it with `-t`, fix the owner, re-run. No runtime-proof tasks are added; boots, fresh stack and the full journey run belong to the final checkpoint.
