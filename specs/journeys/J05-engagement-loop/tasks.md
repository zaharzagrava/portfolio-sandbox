# Tasks: J05 — Engagement loop

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `research.md`, `data-model.md`, `contracts/journey-kit.md`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: required (test-plan.md, 37 rows). Test task first, then the code task that makes it pass. Titles keep the `J05 AS-nn` prefix (L-017).
**Paths** are under `packages/backend/` unless marked. Journey file: `test/journeys/engagement-loop.journey-spec.ts`. Run it narrowly: `pnpm test:journeys -t "Journey J05: engagement loop USn"` after `bash scripts/sdd/stack-fix.sh api-ready`. Domain e2e: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`.
**Rules**: rule 0 (edit living-spec page first, never `*.reviewed.json`), `TransactionRunner.run`/`@Transactional` only (no new `sequelize.transaction`), no tasks that run runtime proofs (final checkpoint is the loop's).

## Phase 1: Setup

- [X] T001 Edit living-spec pages first (rule 0): `docs/spec/capabilities/S10-cart-checkout.md` (body `ref` replaces `refCode`; `attribution: {code}` on `GET /orders/:id`; `order.paid.attribution`), `S37-share-links.md` (conversion record, consumer `marketing-affiliate-conversions`, `GET /links/:code/conversions`, stats `conversions`/`convertedMinor`, events `link.converted|link.conversion_reversed` on `links.events`), `S53-events-projections.md` (eight aliases); keep `[proof:]`/`[code:]` tags true (`python3 scripts/livespec/check.py`); record any signed page changed under `## Spec changes` in `gaps.md`.
- [X] T002 [P] Add zod schemas in `/opt/sdd/repo/packages/contracts/src/`: checkout request `ref` (`^[A-Za-z0-9_-]{3,64}$`, `refCode` removed), order `attribution: {code} | null`, `order.paid` `attribution: {code, ownerId} | null`, `link.converted` v1 `{conversionId, linkCode, amountMinor, currency, paidAt}`, `link.conversion_reversed` v1 `{conversionId, linkCode, refundedMinor, amountMinor}`, conversions list response `{items:[{conversionId, paidAt, amountMinor, currency, status, refundedMinor}], nextCursor}`; stats gains `conversions`, `convertedMinor`. No buyer id, order id or key.
- [X] T003 [P] Add topic `links.events` to `scripts/init-kafka-topics.sh` if absent (G-23, D7).

## Phase 2: Foundational (blocks all stories)

### WP1 — names and control surface (G-09, G-17, G-23)
- [X] T004 Write failing e2e `libs/infrastructure/projections/consumer-groups.e2e-spec.ts` (extend existing): `GET /api/admin/consumers/:group` accepts `community-feed-products`, `community-feed-discussions`, `community-feed-fanout`, `marketing-link-clicks`, `marketing-affiliate-conversions`, `discovery-order-baskets`, `discovery-trending-topk`, `experimentation-purchases`; also asserts job allow-list contains `recommendations.build-bought-together` and tap topics `links.events|feed.events|discussion.events` are readable (refused in production).
- [X] T005 Add the eight aliases to `CANONICAL_CONSUMER_GROUPS` in `libs/infrastructure/projections/consumer-groups.ts` (aliases over real group ids read from the projector declarations; no rename); add missing allow-list/tap entries in the control-surface admin code (`libs/domains/identity/api/topics-admin.controller.ts`, jobs allow-list).

### WP2 — checkout attribution (G-01, G-02)
- [X] T006 Write failing e2e `libs/domains/orders/checkout-attribution.e2e-spec.ts`: valid `ref` ⇒ order `attribution: {code}` and `order.paid.attribution {code, ownerId}`; unknown/disabled/self ref ⇒ 2xx `attribution: null`; expired ref attributes; malformed ref ⇒ 400; unknown property (`refCode`) ⇒ 400; same key + different `ref` ⇒ `422 idempotency_key_reused`; marketing lookup failure degrades to null; `ownerId` never returned by any API.
- [X] T007 Add nullable uuid column `Order.attributionOwnerId` (migration in orders' migration folder) and map it in the order model/repository (`libs/domains/orders/infra/order.repository.ts`); `refCode` column now holds the frozen attribution code only.
- [X] T008 Replace `refCode` with `ref` in `libs/domains/orders/api/checkout.dto.ts` and the idempotency fingerprint in `application/checkout.service.ts`.
- [X] T009 Export `LinkAttributionService.resolveAttributions` from marketing (R1, `libs/domains/marketing/application/link-attribution.service.ts`) with owner id and self/disabled handling; call it once in `CheckoutService`, freezing `{code, ownerId}` on the order; failure ⇒ null. Run `check:module-graph`; if orders → marketing cycles, add `AttributionResolverPort` in orders bound by the app.
- [X] T010 Add `attribution` to `GET /orders/:id` (no owner id) and to the `order.paid` payload in `libs/domains/orders/application/events/order-events.ts`, `order-lifecycle.service.ts` (read from the order row inside the paid transaction); update the event contract test.

### WP3 — conversion slice (G-12, G-14, G-22)
- [X] T011 Write failing e2e `libs/domains/marketing/affiliate-conversions.e2e-spec.ts`: `order.paid` with attribution ⇒ one `CONFIRMED` row and one `link.converted`; duplicate/replayed delivery changes nothing; lower `orderVersion` discarded; partial refund raises `refundedMinor`; full refund ⇒ `REVERSED` + `link.conversion_reversed`; refund before paid ⇒ `PENDING_REFUND` merged on paid (events in order); no attribution ⇒ nothing; `paidAt` from payload; poison message to DLQ; `GET /links/:code/conversions` owner only (`404` others), paged, no buyer/order id; stats `conversions` and `convertedMinor` (confirmed minus refunded); duplicate click `clickId` counted once.
- [X] T012 Add model + migration for table `AffiliateConversion` per data-model.md (`id` UUIDv5(namespace, `orderId`) PK; `linkCode` text; `ownerId` uuid; `orderId` uuid unique, internal only; `amountMinor` bigint, `currency` text; `status` CONFIRMED|REVERSED|PENDING_REFUND; `refundedMinor` bigint ≥ 0, ≤ `amountMinor`; `orderVersion` int; `paidAt`, `createdAt`, `updatedAt` timestamptz) in `libs/domains/marketing/infra/`; register in table-ownership (`check:table-ownership --strict`) and model registry.
- [X] T013 Implement consumer `marketing-affiliate-conversions` (`order.paid`, `order.refunded`) in `libs/domains/marketing/infra/`: idempotent insert on `orderId`, `orderVersion` guard, out-of-order refund, one transaction per batch via `TransactionRunner.run`, outbox rows `link.converted|link.conversion_reversed` (topic `links.events`, key link code, v1) in the same transaction, injected `Clock`, zod-validated input; wire in marketing module (barrel exports modules, not projectors).
- [X] T014 Add `GET /links/:code/conversions` and the stats fields in `libs/domains/marketing/api/share-links.controller.ts` + application service (owner only, cursor paging; no buyer, order id, key).
- [X] T015 Verify/fix click dedupe by `clickId` in `libs/domains/marketing/infra/clickhouse-click-stats.reader.ts` / `link-clicks.projector.ts` (G-12).

### WP5/kit — journey support (G-19)
- [X] T016 [P] Create `test/journeys/support/engagement-fixture.ts` (`follow`, `publishProduct`, `post`, `comment`, `createLink`, `referredCheckout`, `payOrder`, `createExperiment`; public routes only; 409 ⇒ open existing, L-010) per `contracts/journey-kit.md`.
- [X] T017 [P] Create `test/journeys/support/storefront-double.ts` (`post(events[], {token, anonymousId})` to `POST /api/events`; fresh `event_id` per event; `anonymousId` 8–64 chars).
- [X] T018 Add hop rows `J05.H1..H16` (maxima from spec.md hop table) to `test/journeys/support/wait-for-contract.ts`; deadline = 2 × max × `JOURNEY_TIME_FACTOR`, poll 250 ms.
- [X] T019 Create `test/journeys/engagement-loop.journey-spec.ts` skeleton: `describe("Journey J05: engagement loop")`, one nested `describe` per story, `beforeAll` takes `logMark(apiLogPath())` (L-032) and unique run token, `afterAll` restores clock and resumes every paused group, also on failure (L-013); document J05 variables in `test/journeys/README.md`.

## Phase 3: US1 — follower sees new product in feed (P1)
Goal: AS-01..AS-06 (+AS-34 pending). Independent test: `-t "J05 .* US1"`.
- [X] T020 [US1] Write journey tests `J05 AS-01`..`J05 AS-06` (follow, late follow, replay of `products.events`/`feed.events`, archive/restore and old-event replay, `community-feed-fanout` paused then resumed, sandbox/draft/price_drop 24 h rule) in the journey file.
- [X] T021 [US1] Run US1 narrowly; fix each broken hop in its owner (`libs/domains/community`, `catalog`) — G-04/05/06/16 verification; no foreign model in feed code.
- [X] T022 [P] [US1] Create Playwright stub `/opt/sdd/repo/packages/web/tests/engagement-loop.spec.ts` for AS-34 marked pending (`test.fixme`) with title `J05 AS-34`.

## Phase 4: US2 — discussion, post in feed, comment notice (P1)
Independent test: `-t "J05 .* US2"`.
- [X] T023 [US2] Write journey tests `J05 AS-07`..`J05 AS-12` (post → follower feed + board list, ×5 retried post key, comment notice via inbox/unread/SSE and no notice to commenter, deleted post vanishes + one `post_deleted` in tap, `community-feed-discussions` paused, unknown board `404 board_not_found`).
- [X] T024 [US2] Run US2 narrowly; fix hand-offs in `community` / `notifications` (G-07/08/15/21 verification).

## Phase 5: US3 — referred purchase credits the sharer once (P1)
Independent test: `-t "J05 .* US3"`.
- [X] T025 [US3] Write journey tests `J05 AS-13`..`J05 AS-21` (link→click→ref checkout→pay→conversion/stats/tap, third user `404`; same-key checkout ×5 and different `ref` `422`; `marketing-affiliate-conversions` paused + replay of `orders.events`; self-referral null; unknown/malformed/disabled null and expired credited; click without `ref`; full/partial/refund-before-paid; declined/expired orders never credit; link create once per key, off-marketplace `422`).
- [X] T026 [US3] Run US3 narrowly; fix any remaining hand-off in the owner (orders, marketing, payments chain).

## Phase 6: US4 — bought together (P2)
Independent test: `-t "J05 .* US4"`.
- [X] T027 [US4] Write journey tests `J05 AS-22`..`J05 AS-25` (three buyers + job via control surface, rail both ways, hidden when archived/out of stock; under threshold nothing; `discovery-order-baskets` paused/replay equals single delivery; refund keeps the rail).
- [X] T028 [US4] Run US4 narrowly; fix `libs/domains/discovery` (3-distinct-buyer rule, basket `buyerId`/`orderVersion`, product visibility via `ProductQueryService`, G-13/G-17).

## Phase 7: US5 — trending (P2)
Independent test: `-t "J05 .* US5"`.
- [X] T029 [US5] Write journey tests `J05 AS-26`..`J05 AS-29` (storefrontDouble views/carts + clock advance + weighted scores; purchase alone no change; duplicate `event_id`, invalid product, `discovery-trending-topk` paused; archived leaves ranking).
- [X] T030 [US5] Run US5 narrowly; fix `libs/domains/discovery` trending (G-10) if a hop fails.

## Phase 8: US6 — A/B experiment (P2)
Independent test: `-t "J05 .* US6"`. Satisfies S39 follow-up: `unit: "user"`, metric `purchase` experiment, poll `GET /api/admin/experiments/:key/results` up to 60 s after the purchase (FR-044; H14 deadline 120 s).
- [X] T031 [US6] Write journey tests `J05 AS-30`..`J05 AS-33` (create/start `EX`, stable assignment, exposure, pay, results incl. 401/403; purchase before exposure; duplicates + replay `experimentation-purchases` + pause; anonymous exposure then signed-in purchase ⇒ `excluded.unattributable > 0`).
- [X] T032 [US6] Run US6 narrowly; fix `libs/domains/experimentation` if needed (G-11).

## Phase 9: US7 — replay and static gates (P3)
Independent test: `-t "J05 .* US7"`.
- [X] T033 [US7] Write journey tests `J05 AS-35` (record observables, replay every group, rerun build, compare), `J05 AS-36` (scan conversions, stats, tap, bodies and this run's log lines for buyer identity, keys, props), `J05 AS-37` (run the six gates: `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`).
- [X] T034 [US7] Fix what AS-35..37 expose; WP6 / G-13, G-20: no foreign model in `libs/domains/orders/api/orders.controller.ts` or `discovery`; barrels `community/index.ts`, `discovery/index.ts`, `experimentation/index.ts`, `marketing/index.ts` export modules not projectors (adjust app wiring); direct `sequelize.transaction` count in these domains does not rise.

## Phase 10: Polish & docs

- [X] T035 Add under `## Sibling-spec follow-ups` in `gaps.md` the bullets for S10, S37, S53 (already listed — confirm exact `- **<id>**:` form) and update the `gaps.md` status line for rows closed.
- [X] T036 [P] Confirm `specs/UNVERIFIED.md` rows for AS-34, SC-010 and SC-001/004/006/007/008 exist (rows at lines 311–313) and that `quickstart.md` "Ops artifacts" lists the same; never mark them verified.
- [X] T037 [P] Run `python3 scripts/livespec/check.py` and fix any broken `[proof:]`/`[code:]` tag in the S10/S37/S53 pages.

## Dependencies

- Phase 1 → Phase 2. Inside Phase 2: T004→T005; T006→T007→T008→T009→T010; T011→T012→T013→T014, T015; WP3 needs WP2 (nothing credits without attribution). T016–T018 before T019; T019 before all journey tasks.
- Stories run in order US1 → US7 in one file (US4–US6 use US3's paid orders or create their own). Phase 10 last.
- Parallel: T002/T003; T016/T017; T022; T036/T037; WP1 alongside WP2.

## Implementation strategy

MVP = Phase 1–2 plus US3 (attribution and conversion are the only new capability code); then US1/US2 (verification of built feed/discussions), then US4–US7. Test first in every pair; fix defects in the owning domain. Runtime proofs (standalone boots, full journey suite, fresh stack) belong to the final checkpoint and are not tasks.
