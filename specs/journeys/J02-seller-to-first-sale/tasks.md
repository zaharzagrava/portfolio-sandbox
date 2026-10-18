# Tasks: J02 — Seller to First Sale

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `research.md`, `data-model.md`, `contracts/journey-kit.md`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: requested (constitution VII; test-plan.md has 33 rows). Order is test-first: for every test-plan row the journey-test task comes **before** the fix tasks that make it pass.
**Paths**: `B` = `packages/backend`. Journey file `J` = `B/test/journeys/seller-to-first-sale.journey-spec.ts`; kit `K` = `B/test/journeys/support/`. Domains are under `B/libs/domains/`.
**Rules for every task** (do not repeat in each line): rule 0 — edit the capability page `docs/spec/capabilities/<ID>-*.md` first when behaviour changes, keep `[proof]`/`[code]` true (`python3 scripts/livespec/check.py`), never touch `*.reviewed.json`; new transactions use `TransactionRunner.run`/`@Transactional`, and a touched `// S54 T037 audit` site is migrated and its comment deleted; run e2e through `scripts/sdd/test-spec.sh <path>`; after backend edits `bash scripts/sdd/stack-fix.sh api-ready` before a journey run; no fixed sleeps; runtime proofs (fresh stack, standalone boots, full journey suite) belong to the final checkpoint and are **not** tasks.

## Format: `- [ ] Tnnn [P?] [US?] Description with file path`

## Phase 1: Setup (journey kit)

- [X] T001 [P] Create `K/webhook-receiver.ts`: HTTPS server on an ephemeral port with self-signed cert, `received[]` of `{id, deliveryId, attempt, type, replay, body}`, `answer(200|500|hang)` per request count, verification with S43's reference verifier (contracts/journey-kit.md §4).
- [X] T002 [P] Create `K/kyc-fixtures.ts` and the five files `K/fixtures/kyc-ok-registration.pdf`, `kyc-ok-bank.pdf`, `kyc-ok-vat.pdf`, `kyc-unclear.pdf`, `kyc-forged.pdf` with recorded `sha256`, `size`, `contentType` (data-model.md `KycFixture`).
- [X] T003 [P] Extend `K/seller-fixture.ts` with `registerSeller`, `createShop`, `onboardVerified(shop, kyc=ok)`, `subscribe(shop, pm)`, `createProduct(shop, overrides)`, `createEndpoint(shop, url, events)`; each idempotent (409 → open existing, L-010).
- [X] T004 [P] Add J02 hop rows `J02.H1`…`J02.H17` (`{maxMs, owner}` from spec.md hop table) to `K/wait-for-contract.ts`; failure message names hop and owner; deadline `2 × maxMs × JOURNEY_TIME_FACTOR`.
- [X] T005 Make `controlSurface.restoreAll()` in `K/control-surface.ts` resume every group and reset the clock, idempotent and exit-code safe when nothing is paused (L-016).
- [X] T006 Create the empty journey file `J` (top-level `describe` "Journey J02: seller to first sale", one nested `describe` per story US1–US6, `afterAll` calls `restoreAll()` and stops the receiver); document J02 variables and fixtures in `B/test/journeys/README.md`.
- [X] T007 [P] Add contract schemas that lack one to `packages/contracts/src/` (plan-limit problem body, `shopRankSchema`, `leaderboardPageSchema`, shop/onboarding view, `productSearchResponseSchema`, `subscriptionSchema`, `productMemberSchema`) and parse every journey response with them (journey-kit §5).

## Phase 2: Foundational (nothing is addressable or drivable without these)

Tests first, then code.

- [X] T008 Edit the pages of S01 and S50 (`docs/spec/capabilities/S01-*.md`, `S50-*.md`): register answers `202` (same answer for a duplicate, no tokens), own register rate-limit policy, successful logins do not burn the account limit, journey allow-list, bootstrap admin (G-01, G-02).
- [X] T009 Write e2e specs in `B/libs/domains/identity/` for register `202`/duplicate, rate-limit policy `auth.register.ip` and allow-list, and bootstrap `ADMIN` provisioning (idempotent, refused when `NODE_ENV=production`); run them failing first.
- [X] T010 Implement G-01: `libs/domains/identity/api/auth.controller.ts`, `application/auth-session.service.ts`, `B/libs/infrastructure/rate-limit/rate-limit.types.ts` (separate register policy, success logins not counted, local allow-list refused in production).
- [X] T011 Implement G-02: startup provisioning of an `ADMIN` from `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` in identity (local profile only; production boot with these set fails); add settings to config and `packages/backend/.env` example.
- [X] T012 [P] Write failing e2e/unit checks that the admin job allow-list contains `billing.run`, `onboarding.verify-pending`, `webhooks.retry`, `search.reindex` and that the stack clock reaches `billing.run` and `webhooks.retry` (G-18, G-37), in the J01 control-surface tests under `B/libs/` (find with `rg "admin/jobs" B/libs -l`).
- [X] T013 Implement G-37/G-18: register the four job types in the S49 job allow-list; ensure `billing.run` (`libs/domains/billing/application/billing.job-types.ts`, `renewal.service.ts`) and `webhooks.retry` (developer-platform) read the injected clock; `onboarding.verify-pending` handler lands in T040.
- [X] T014 Edit the pages of S01, S03, S18, S32, S40 for the canonical consumer-group names (research.md §2) before renaming.
- [X] T015 Write failing e2e assertions that `GET /api/admin/consumers/:group` knows `identity-seller-promotion`, `tenancy-shop-lifecycle`, `entitlements-invalidation`, `search-product-index`, `webhook-router`, `leaderboards`, `product-cache-invalidator` (extend the S53 consumer-admin spec).
- [X] T016 [P] Rename identity group `identity-shop-owner-promotion` → `identity-seller-promotion` in `libs/domains/identity/infra/shop-owner-promotion.consumer.ts`; `rg` the old name in specs/docs/e2e and update each hit (G-04).
- [X] T017 [P] Rename `search-indexer` → `search-product-index` (covers `products.events` and `tenancy.events`; fold `search-shop-state` into it or keep two classes under one group id) in `libs/domains/discovery/infra/projectors/` and update references (G-36, G-28).
- [X] T018 [P] Rename `seller-insights-boards` (+ `-shops`, `-products`) → `leaderboards` in `libs/domains/seller-insights/` and update references (G-36).
- [X] T019 Merge `tenancy-verification` and `tenancy-shop-plan` into one group `tenancy-shop-lifecycle` (topics `shop-onboarding` and `billing.events`) in `libs/domains/tenancy/infra/projectors/verification.projector.ts` and `infra/shop-plan.consumer.ts`; keep inbox, version guard, zod, DLQ (G-06, G-16, G-36).
- [X] T020 Add the consumer `entitlements-invalidation` on `billing.events` in `libs/domains/billing/` (invalidates the entitlements cache by `eventId` inbox, ignores stale `subscriptionVersion`, DLQ) with a same-message-twice and invalid-payload test (G-15).
- [X] T021 Wire `search_refresh_interval` (`libs/common/config/search-config.ts`) into index settings at `B/libs/infrastructure/elasticsearch/elasticsearch.service.ts:101` instead of the hard-coded `'5s'`; set `1s` in the local profile; unit test the setting (H9–H11).
- [X] T022 Implement `allowedReceiverHosts` (host:port list plus CA fingerprint) as a validated local-profile setting consumed by S43 endpoint validation and S54 `safeRequest`; production boot with a non-empty list fails; e2e for accepted/refused hosts, HTTPS only (G-32). Page edit first (S43, S54).
- [X] T023 Local deployment extractor (G-11): run the document-extractor consumer in `B/apps/local-monolith` from the first minute (L-025), add the model double answering by fixture content (SHA-256/marker) behind `PROVIDER_DOUBLES=enabled`, refused in production; if a queue is added put it in `infra/docker/elasticmq.conf` (L-002, L-020); unit test the double for the five fixtures; confirm `apps/lambdas` still boots alone (L-018).

**Checkpoint**: group names, admin, allow-list, extractor and receiver host setting exist.

## Phase 3: User Story 1 — A visitor becomes a seller with a shop (P1)

**Independent test**: `pnpm test:journeys -- -t "US1"`.

- [X] T024 [US1] In `J` add `AS-01 register and open a shop` (register `202`, login, `POST /shops` with key, `GET /shops/mine`) and `AS-02 role follows the shop by event` (poll `GET /auth/me` to `SELLER` via `waitForContract('J02.H1')`, refreshed token claim); G-03 verify.
- [X] T025 [US1] In `J` add `AS-03` (×5 concurrent same key → one shop, one membership; different body `422`), `AS-04` (stranger `404` on shop and onboarding), `AS-05` (pause `identity-seller-promotion`, create shop, resume, role once, lag `0`).
- [X] T026 [US1] Fix what AS-01..AS-05 expose in the owning domain: apply the idempotency interceptor to the shop-create route in `libs/domains/tenancy` (G-05), confirm tenancy writes no `UPDATE "User"` and emits `tenancy.shop_created` with outbox in the create transaction (G-03/G-04); e2e for the key replay.

## Phase 4: User Story 2 — Onboarding verification and final rejection (P1)

**Independent test**: `-t "US2"`.

- [X] T027 [US2] In `J` add `AS-06 automatic approval` (questionnaire, submit, three `kyc-ok-*` documents, poll document `APPROVED`, shop `VERIFIED`, `payoutsEnabled`) and `AS-07 human review path` (`kyc-unclear.pdf`, admin resolves `APPROVE`, non-admin `403`).
- [X] T028 [US2] In `J` add `AS-08 application rejected` (`kyc-forged.pdf`, `REJECT_APPLICATION`, shop `REJECTED`, `payoutsEnabled:false`, stale `verified` ignored) and `AS-09 duplicate and out-of-order onboarding events` (replay `shop-onboarding` for `tenancy-shop-lifecycle`; `shopVersion` unchanged, using `Recorded` snapshot).
- [X] T029 [US2] In `J` add `AS-10 extractor down, then back` (stop extractor, upload, documents `QUEUED`; start, verified; repeat `uploaded`; `afterAll` restarts the extractor, L-013) and `AS-11 crash between approval and verification` (all documents approved, run `onboarding.verify-pending` twice → exactly one `shop.verified`).
- [X] T030 [US2] Edit the S04 and S03 pages first, then verify topic `shop-onboarding`, payload shapes and `status` in the view (G-07) with failing e2e specs in `libs/domains/seller-onboarding/`.
- [X] T031 [US2] Implement G-06/G-09: append `shop.verified` in the same transaction that approves the last document/review in `libs/domains/seller-onboarding/application/review.service.ts` (no second transaction); tenancy projector applies by `submissionNo`.
- [X] T032 [US2] Implement G-08: `REJECT_APPLICATION` decision emits `shop.rejected`, state `REJECTED`, `payoutsEnabled:false`; tenancy projector never lets an older `verified` lift a newer `rejected`; admin routes sensitive, paged queue with shop names via R1; e2e.
- [X] T033 [US2] Implement G-09 sweep: job `onboarding.verify-pending` in `libs/domains/seller-onboarding/application/` (idempotent, one `shop.verified` per `submissionNo`), registered in the allow-list from T013; e2e.
- [X] T034 [US2] Implement G-10: extraction command through the outbox (not `queue.enqueue` after commit) at `libs/domains/seller-onboarding/application/`, lease on the document, DLQ wiring; e2e of one model call per document and redelivery.

## Phase 5: User Story 3 — Subscription and entitlements exactly once (P1)

**Independent test**: `-t "US3"`.

- [X] T035 [US3] In `J` add `AS-12 subscribe, charge, entitlements` (free tier until invoice `PAID`, then `ACTIVE`, `maxProducts = m`, `Shop.plan`) and `AS-13 retried subscribe` (×5 same key → one invoice; other body `422`; no key `422`).
- [X] T036 [US3] In `J` add `AS-14 first charge declined` (`pm_test_declined`, free tier throughout, fix method, advance clock, `billing.run`, `ACTIVE`), `AS-15 entitlements cache catches up` (pause `entitlements-invalidation`), `AS-16 duplicate and replayed billing events` (replay `billing.events` for two groups; no change).
- [X] T037 [US3] Verify/fix G-13/G-14 in `libs/domains/billing/application/entitlements.service.ts`, `plan-tier.service.ts`, `events/billing-events.ts`: interim free-tier state until first `PAID`, no pre-commit invalidation, events carry `from`, `planCode`, `subscriptionVersion` and are appended in the deciding transaction; e2e.
- [X] T038 [US3] Fix G-16 in `libs/domains/tenancy/infra/shop-plan.consumer.ts` (now in `tenancy-shop-lifecycle`): `Shop.plan` follows `subscription_plan_changed`, version-guarded; G-12 verify subscribe schema/key; G-17 `StripeBillingGateway` currency and `is_load_test` path (`pm_test_*` honoured by the double); G-19 seed catalog matches S17 (seats, `enterprise`, trial) and `GET /plans` exposes `maxProducts`; e2e for each.

## Phase 6: User Story 4 — Plan limit and search (P1)

**Independent test**: `-t "US4"`.

- [X] T039 [US4] In `J` add `AS-17 plan limit applies` (own shop; fill free tier, `409 plan_limit_reached`, subscribe, create → `201`) and `AS-18 list, then find` (create with key, anonymous search by unique title with `shopId`, `GET /products/:id`) and `AS-19 retried create` (×5 same key → one product, one hit, one event id at `R`).
- [X] T040 [US4] In `J` add `AS-20` (pause `search-product-index`, create, resume, hit once), `AS-21` (patch, archive, restore; converge; replay `products.events`), `AS-22` (admin suspend hides, reinstate shows), `AS-23` (pause, create shop and product, resume; one hit, never a flicker).
- [X] T041 [US4] Edit S05 and S18 pages, then write failing e2e in `libs/domains/catalog/` for: limit reached → `409 plan_limit_reached` and nothing written; entitlements unavailable → `503 entitlements_unavailable` (fail closed); concurrent creates never exceed the limit.
- [X] T042 [US4] Implement G-20 in `libs/domains/catalog/application/product-command.service.ts`: `EntitlementsService.checkLimit('SHOP', shopId, 'maxProducts', count)` inside `TransactionRunner.run` after a per-shop advisory lock; count non-archived, non-deleted; export through the billing public API only; run `check:module-graph` for a billing → catalog edge (IV.2).
- [X] T043 [US4] Verify/fix G-21/G-22/G-24: product create/draft publish responses without `embedding`, `products.events` rows carry `eventName` + snapshot written by `outbox.append` in the same transaction, no legacy `{productId}` writers; e2e per path.
- [X] T044 [US4] Verify/fix G-23: `rg 'UPDATE "Product"' B/libs B/apps` outside catalog; route every stock change through `ProductStockService` with an event; e2e.
- [X] T045 [US4] Fix G-25/G-26: `libs/domains/discovery/infra/projectors/product-index.projector.ts` indexes the event snapshot (no re-read of `Product`), applies only a higher `productVersion`, copies shop-state, hides products of a shop not known-active; search answers the documented shape; e2e for replay and ordering.
- [X] T046 [US4] Implement/verify G-27: `GET /admin/search/index` returns lag/progress; G-28: `tenancy.shop_status_changed` suspend/reinstate handled in `search-product-index`; e2e.

## Phase 7: User Story 5 — First sale reaches webhooks and leaderboard (P1)

**Independent test**: `-t "US5"`.

- [X] T047 [US5] In `J` add `AS-24 webhook endpoint for the shop` (create to `R`, secret once, staff `403`, other shop `404`) and `AS-25 the sale end to end` (J01 purchase of `P`; search `inStock:false`; `R` gets one signed `order.paid` sliced to `S`; attempts API `ok`; rank and board; **S40 follow-up**: `waitForContract('J02.H14')` polling `GET /shops/:shopId/rank` until `200` with a 10 s floor on the deadline, and `404 not_ranked` asserted once before payment).
- [X] T048 [US5] In `J` add `AS-26 two-shop order`, `AS-27 receiver fails, then recovers` (`R` 500, advance clock, `webhooks.retry`, `R` 200; same id; replay with key and `Marketplace-Replay`), `AS-28` (pause `webhook-router`, then `leaderboards`), `AS-29` (replay `orders.events` and `products.events` for five groups; observables identical), `AS-30` (`PATCH /shops/S` renames board entry, rank same), `AS-31` (declined/expired orders: no webhook, rank unchanged, stock back).
- [X] T049 [US5] Edit the S43 page, then write failing e2e in `libs/domains/developer-platform/` for wire headers `Marketplace-Delivery-Id`, `-Event-Type`, `-Attempt`, `-Replay` and body `resource_version` (G-31).
- [X] T050 [US5] Implement G-29/G-31: create endpoint requires `webhooks.manage`; event types; headers and `resource_version` on the wire; attempts filter `?eventId=`.
- [X] T051 [US5] Implement G-30: router subscribes to `orders.events` and `products.events`, slices an order by shop with deterministic event ids (one per source event and shop, AS-26/AS-29); idempotent and DLQ; e2e.
- [X] T052 [US5] Verify/fix G-33: the webhook FIFO queue consumer and router run in `apps/local-monolith`; FIFO options only where the task is created (L-001); queue in `elasticmq.conf` (L-002).
- [X] T053 [US5] Fix G-34/G-35 in `libs/domains/seller-insights/`: board entry exposes `name`, `slug`, no placeholder `"Unknown shop"`, no `revenue` leak; `GET /shops/:shopId/rank` answers `404 not_ranked` before payment and `200` within 10 s after `order.paid`; projector uses `lineTotalMinor` and `paidAt` from the event; name/slug from `tenancy.*` (H15) with version guard; idempotent per `orderId`; e2e (covers the S40 follow-up).

## Phase 8: User Story 6 — Observable hops and approved paths (P3)

**Independent test**: `-t "US6"` plus static gates.

- [X] T054 [US6] In `J` add `AS-32 every hop is observable` (counters moved; all journey groups `lag: 0` and `RUNNING`; log fields; no secrets). Add `AS-33` as a documented gate-only row (static gates; no HTTP test) in the README.
- [X] T055 [US6] Implement G-38: counters (shops created, onboarding decisions, invoices paid, products indexed, deliveries, ranks) and log fields in the owning domains; e2e per counter; secrets redacted.
- [X] T056 [US6] G-40: remove raw models/SQL crossing domains on this journey's paths (identity, tenancy, seller-onboarding, billing, catalog, discovery, developer-platform, seller-insights); migrate every touched `// S54 T037 audit` site; `check:table-ownership --strict` and `check:boundaries` clean for the eight domains; direct `sequelize.transaction` count does not rise.

## Phase 9: Polish

- [X] T057 [P] Update living-spec pages not yet edited (S03, S04, S05, S17, S18, S32, S40, S43, S49) to the final behaviour; run `python3 scripts/livespec/check.py`; list any page with a `*.reviewed.json` that changed under `## Spec changes` in `gaps.md`.
- [X] T058 [P] Confirm `gaps.md` `## Sibling-spec follow-ups` lists S01, S03, S04, S05, S18, S32, S40, S43, S49 and add any new contract change found (e.g. `plan_limit_reached`, headers) without editing those specs.
- [X] T059 [P] Confirm the six criteria SC-001..SC-005, SC-008 appear under "Ops artifacts" in `quickstart.md` and as rows in `specs/UNVERIFIED.md` (status "not run"); add any missing row.
- [X] T060 [P] Check `rg "setTimeout|sleep\(" B/test/journeys` is empty and every J02 scenario title keeps the stable `AS-nn` prefix (L-017); `tsc --noEmit` and ESLint on `B/test/journeys` and the touched domains.

## Dependencies

Phase 1 → Phase 2 → US1 → US2 → US3 → US4 → US5 → US6 → Polish. Journey order is serial (US1–US5 share one seller). Inside a phase the test task precedes its fix tasks. T016–T018 and T001–T004, T007 are parallel (different files). T033 needs T013; T042 needs T020 and T038; T053 needs T018.

## Implementation strategy

MVP = Phases 1–3 (kit, foundations, US1). Then add one story at a time: write the slice, run it with `-t`, fix the owning domain, move on. Full suites, standalone boots and the fresh-stack run are done by the final checkpoint, not by a task.
