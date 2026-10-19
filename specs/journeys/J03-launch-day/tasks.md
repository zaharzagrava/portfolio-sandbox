# Tasks: J03 — Launch Day

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/journey-kit.md`, `quickstart.md`, `test-plan.md` (40 rows), `gaps.md`, `questions.md` (defaults accepted).
**Tests**: requested (test-plan.md, constitution VII.8). Order inside every phase: failing test task first, then the code task that makes it pass.
**Paths** are under `packages/backend/` unless marked `ROOT/`. Journey file: `test/journeys/launch-day.journey-spec.ts`; scenario titles keep the stable `AS-nn` prefix (L-017). Run one spec with `ROOT/scripts/sdd/test-spec.sh <path>`; one story with `pnpm test:journeys -- -t "US<n>"`; after backend edits `bash scripts/sdd/stack-fix.sh api-ready`.
**Not tasks (final checkpoint, run by the loop)**: standalone boots of `core`/`worker`/`projector`/`sse-gateway`, fresh-stack run, full `pnpm test:journeys`, doctor comparison, whole capability suites (L-012, L-018, L-019).
**Rule 0**: edit the capability page in `ROOT/docs/spec/capabilities/` before each behavior change; keep `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`); never create or edit a `*.reviewed.json`. Direct `sequelize.transaction` in touched files → `TransactionRunner.run`/`@Transactional`, delete the `// S54 T037 audit` comment; never add a direct site.

## Phase 1: Setup (journey kit skeleton)

- [X] T001 Add schemas to `packages/contracts/src/` for the voucher page (`GET /orders/vouchers` → `{items:[{voucherId, holdId, launchEventId, shopId, seatCount≥1, status:"ISSUED", createdAt}], nextCursor: string|null}`), the event-tap page (`{items:[{eventId,type,key,version,occurredAt,payload}]}`, `limit` ≤ 200, default 50) and ticket status `admittedAt` (ISO instant, optional, present only when admitted); export from the contracts index.
- [X] T002 [P] Add hop table `J03.H1`..`J03.H30` (`{maxMs, owner, what}` from spec.md, deadline `2 × maxMs × JOURNEY_TIME_FACTOR`) to `test/journeys/support/wait-for-contract.ts`; failure message names hop and owner; no fixed sleeps.
- [X] T003 [P] Create `test/journeys/support/event-tap.ts`: `eventTap(topic,{type?,key?,limit?})` and `countExactlyOnce(type,key)` (only after consumer `lag: 0`), responses parsed with the T001 schema.
- [X] T004 [P] Create `test/journeys/support/sse-client.ts`: `sseClient(topics | liveStreamId)` wrappers over `test/utils/sse-client.ts` for `queue:<ticket>`, `event:<id>:seatmap`, `auction:<id>`, `stream:<id>`, `user:<id>` and `GET /live/:id/events`.
- [X] T005 Create `test/journeys/support/launch-fixture.ts`: `launchFixture` with `createEvent`, `createDrop`, `createStream`, `createAuction` over public routes, unique names, idempotent (409 → open existing, L-010), each story its own products (`createIsolatedProduct`, L-005); reuse J01/J02 `seller-fixture.ts`, `purchase.ts`.
- [X] T006 Extend `test/journeys/support/control-surface.ts`: `restoreAll()` resumes every Kafka group and queue consumer (`orders-booking-voucher` included) and resets the clock; idempotent, exits 0 when nothing is paused (L-013, L-016).
- [X] T007 Create the journey shell `test/journeys/launch-day.journey-spec.ts`: top-level `describe("Journey J03: launch day")`, one nested `describe` per US1–US6 in that order, `afterAll` calls `controlSurface.restoreAll()` (L-029). Update `test/journeys/README.md` with J03 variables (`CLOCK_CONTROL`, `PROVIDER_DOUBLES`, `EVENT_TAP`) and fixtures.

## Phase 2: Foundational (control surface, doubles, fields — nothing is drivable without them)

- [x] T008 Edit living-spec pages first: `ROOT/docs/spec/capabilities/` pages of S53 (tap, queue-consumer pause/lag), S49 (job allow-list), S23 (classifier double), S22 (`admittedAt`), S10 (voucher consumer and route); then `python3 scripts/livespec/check.py`. (Pages edited and their `[code:]` targets confirmed to exist by reading; `check.py` could not be run here because the shell refused it, so it is deferred to T060.)
- [X] T009 [P] Write failing e2e `libs/domains/identity/topics-admin.e2e-spec.ts` (G-41): admin `GET /api/admin/topics/:topic/messages?type=&key=&limit=` → 200 items; `limit` > 200 rejected/clamped per contract; non-admin 403; refused when `NODE_ENV=production` or `EVENT_TAP` off; read-only.
- [X] T010 Implement the tap: controller in `libs/domains/identity/api/topics-admin.controller.ts` reading via the Kafka admin/consumer client with bounded `limit`; register in the identity module; startup validation refuses `EVENT_TAP=enabled` in production.
- [X] T011 [P] Write failing e2e `libs/domains/identity/admin-jobs.e2e-spec.ts` additions (G-40): `POST /api/admin/jobs` accepts `launch-events.reconcile-seats`, `auctions.sweep-due`, `flash-sale.verify`, `launch-events.live-reconcile`; each run twice leaves state unchanged; unknown type 422; non-admin 403.
- [X] T012 Add the four job types to the allow-list in `libs/domains/identity/api/jobs-admin.controller.ts` and register idempotent handlers in the owning domains (launch-events, auctions, orders flash-sale, launch-events live) through exported services only.
- [X] T013 [P] Write failing e2e `libs/domains/identity/consumers-admin.e2e-spec.ts` additions (G-42): `GET|POST /api/admin/consumers/orders-booking-voucher` and `/pause`, `/resume`; `lag` = visible queue messages; pausing leaves other consumers running.
- [X] T014 Implement queue-consumer pause flag (same flag store as Kafka groups, checked before receive) in the orders SQS consumer base and `libs/domains/identity/api/consumers-admin.controller.ts`; `lag` from approximate visible messages.
- [X] T015 [P] Write failing unit/e2e test for the toxicity double in `libs/domains/launch-events/` (G-43): with `PROVIDER_DOUBLES=enabled`, `[[toxic]]` → 0.95, other content → 0.05; startup refuses it in production.
- [X] T016 Implement the classifier double beside `HeuristicToxicityClassifier` in `libs/domains/launch-events/` selected by `PROVIDER_DOUBLES` (production refused at startup).
- [X] T017 [P] Write failing e2e in `libs/domains/launch-events/` (S22 AS-04/AS-05 area): `GET /launch-events/:eventId/queue/:ticket` returns `admittedAt` only when admitted, owner-only, no personal data; other users 403/404.
- [X] T018 Add `admittedAt` to the ticket status in `libs/domains/launch-events/` (waiting-room service and controller) using the injected `Clock`.
- [X] T019 Verify `scripts/init-kafka-topics.sh` creates `launch-events.events`, `live.events`, `auctions.events`, `orders.events` explicitly (key = aggregate id) (G-30, S53); add the missing ones and a line in `ROOT/docs/spec` S53 page.

**Checkpoint**: tap, allow-list, queue pause, double and `admittedAt` exist; the journey can drive and observe the chain.

## Phase 3: User Story 1 — Queue, book seats, told once (P1) 🎯 MVP

**Goal**: AS-01..AS-09. **Independent test**: `pnpm test:journeys -- -t "US1"`.

- [X] T020 [US1] Write failing journey tests AS-01 and AS-02 in `test/journeys/launch-day.journey-spec.ts` (12 buyers join, clock advance, ≤ 5 admitted per clock second via `admittedAt`, hold with token and key, seat map, confirm, `my-bookings`; one inbox item, unread, SSE `user:<id>`, one voucher; no items for others/owner).
- [X] T021 [US1] Write failing e2e `libs/domains/orders/booking-voucher.e2e-spec.ts` (G-04, G-44): consumer group `orders-booking-voucher` on `orders.booking_voucher_requested`, idempotent on `booking-voucher:<holdId>` (same message twice → one row), invalid payload → DLQ, `GET /orders/vouchers?launchEventId=&limit&cursor` own vouchers only, empty filter → empty page, unauthenticated 401.
- [X] T022 [US1] Edit S10 page, then implement WP1 in `libs/domains/orders/`: `Voucher` model (`id` uuid, `holdId` uuid **UNIQUE**, `launchEventId`/`shopId` uuid **no foreign key**, `userId` uuid, `seatCount` int ≥ 1, `status` enum `ISSUED`, `createdAt` from injected clock), expand migration (unique index `holdId`, index `(userId, launchEventId, createdAt)`, no backfill), register in the model registry, `ON CONFLICT DO NOTHING` insert in one `TransactionRunner.run`, consumer registered in orders' worker module and the local monolith composition (L-015/L-018), route `GET /orders/vouchers`. Queue is already in `elasticmq.conf` (L-002); no `groupId` (L-001).
- [X] T023 [US1] Write failing e2e in `libs/domains/notifications/` for `booking.confirmed` (G-05): `launch_events.booking_confirmed` → one inbox item for the buyer only, duplicate delivery adds none, atomic unread counter (same once-only decision as the inbox upsert, G-27).
- [X] T024 [US1] Verify and fix in `libs/domains/notifications/` event mapping/templates/catalog `booking.confirmed` (S28 AS-13) and make the unread counter increment inside the inbox once-only decision; remove the separate `SET NX notif:counted`; per-event isolation in a batch (one bad event no longer rejects the batch).
- [X] T025 [US1] Write failing journey tests AS-03, AS-04, AS-05 (retried confirm ×5 same key, ×10 different keys, key reuse 422; last seat → `SOLD_OUT`, holds 409, one `event_sold_out` on the tap; clock +10 min → `409 HOLD_EXPIRED`, no booking/notice/voucher, next buyer holds).
- [X] T026 [US1] Verify confirm in `libs/domains/launch-events/application/confirm.service.ts` against the tests: one transaction with bookings, history, outbox events and voucher command, no Dynamo/Redis call inside (III.3), fenced vs expiry, `HOLD_EXPIRED`; use stack `Clock`; migrate any direct `sequelize.transaction` to `TransactionRunner` (G-01, G-02, G-06).
- [X] T027 [US1] Write failing journey tests AS-06, AS-07, AS-08 (pause/resume `notification-router` and `orders-booking-voucher` with lag; replay `launch-events.events`; organizer close frees holds ≤ 60 s).
- [X] T028 [US1] Fix findings in the owning domain: event lifecycle jobs `open-sales`/`close-event` and `SOLD_OUT` with outbox events (G-03), `launch-events.reconcile-seats` handler idempotent (G-40), consumer names fixed (G-29).
- [X] T029 [US1] Write failing journey test AS-09 (access token, other event's token, other buyer's token on hold → 403; admission token on `/auth/me` → 401).
- [X] T030 [US1] Verify/fix admission token via R1 `PurposeTokenService.sign/verify` with pinned algorithm and audience `admission:<eventId>`; ticket status and `queue:<ticket>` topic owner-only (async policy with principal, `libs/domains/launch-events/api/realtime-topics.ts`); no `KeyStore` import (G-07, G-08, G-31).
- [X] T031 [US1] Verify admitter in `libs/domains/launch-events/application/admission-ticker.service.ts`: per-tick cap, fenced leader election, heartbeat, missing ticket does not consume capacity (G-09).

**Checkpoint**: US1 green with `-t "US1"`.

## Phase 4: User Story 2 — Limited drop sells exactly its units (P1)

**Goal**: AS-10..AS-18. **Independent test**: `-t "US2"`.

- [X] T032 [US2] Write failing e2e in `libs/domains/notifications/` for `shop.flash_sale_sold_out` (`flash_sale.sold_out`) and `shop.flash_sale_start_failed` (`flash_sale.start_failed`): recipients shop OWNERs only (via exported membership query service, no `ShopMembership` import), category `shop`, push + inapp / email + inapp, replay adds none.
- [X] T033 [US2] Edit S28 page, then add router rows, templates and catalog rows for both types in `libs/domains/notifications/domain/event-mapping.ts` and catalog (WP2, G-26); verify `order.cancelled` filter yields buyer notice only for `out_of_stock` and `hold_expired`.
- [X] T034 [US2] Write failing journey tests AS-10, AS-11, AS-13 (schedule, stock 30, search `inStock`; 60 concurrent checkouts → 20 `202`, 40 `422`, member stock unchanged, refused buyers have no orders; retried checkout ×5 one order).
- [X] T035 [US2] Verify/fix drop in `libs/domains/orders/infra/flash-sale.jobs.ts`: load through catalog stock command `orders:flash:<saleId>:load`, buckets created only if absent, selling only inside `[startsAt, endsAt)`, seller/public routes (`GET /shops/:id/flash-sales[/:saleId]`, `GET /flash-sales/:saleId`), `503 flash_sale_unavailable` on Redis failure; remove raw `UPDATE "Product"` and `ProductModel` injection (G-16..G-19, G-31).
- [X] T036 [US2] Write failing journey tests AS-12, AS-14, AS-15 (J01 chain for 5 paid orders, inbox, owner items, stats sold/held; clock +15 min → units back once, one `order.cancelled` item each, expiry twice no change; end and reconcile → `RECONCILED`, stock 45, one `flash_sale.reconciled` on the tap, rerun no change).
- [X] T037 [US2] Verify/fix claim records and idempotent release/convert per claim, return via `orders:flash:<saleId>:return` and `flash-sale.verify` handler in `libs/domains/orders/` (G-18).
- [X] T038 [US2] Write failing journey tests AS-16, AS-17, AS-18 (owner has one sold-out notice, staff none, replay none; reduce stock after scheduling → `START_FAILED`, regular checkout works, one tap event, owner notice; pause `notification-router`, pay 3 orders, resume, replay, counts unchanged).
- [X] T039 [US2] Fix findings from US2 in the owning domain; ensure `flash_sale.*` on `orders.events` are ignored without error by type-dispatching consumers (webhook router, leaderboards, baskets) with a test in each touched consumer's e2e.

## Phase 5: User Story 4 — Auction closes once, winner settled (P1)

(Ordered before US3 for priority; journey file order stays US1→US6.)

**Goal**: AS-27..AS-36. **Independent test**: `-t "US4"`.

- [X] T040 [US4] Write failing journey tests AS-27, AS-28, AS-30 (create ×1/×5 with key, stock 2 once, open at start, second create 409, no entitlement 403; three bids, one outbid item per change of leader, retried bid; anti-sniping extends end, original close no-op).
- [X] T041 [US4] Verify/fix in `libs/domains/auctions/`: durable acknowledged bids, `auction.leader_changed` per actual leader change, full event vocabulary (`created`, `opened`, `bid_placed`, `second_chance_offered`, `sold`, `unsold`, `cancelled`; `closed` with `status`, `reason`, `currency`, `auctionVersion`), `Idempotency-Key` on create/bid, problem codes, R1 `getRole` for shill guard (G-20, G-23, G-25).
- [X] T042 [US4] Write failing journey tests AS-31, AS-32, AS-35 (clock to end → `CLOSED`, winner's order `RESERVED` at price, seller sees `winnerOrderId`, one `auction.won`, stock still 2; sweep + job ×3 → one `closed`, one order, one notice; reserve not met → `UNSOLD(reserve_not_met)`, no order, stock back).
- [X] T043 [US4] Verify/fix close in `libs/domains/auctions/infra/auction.jobs.ts`: winner order only through `createFixedPriceOrder` after the closing transaction (appends `order.reserved`), no `BisOrder*` writes or `OrderService` import, stock only via catalog command, `auctions.sweep-due` handler; delete the post-close `setTimeout`; migrate direct transactions (G-21, G-24, G-31).
- [X] T044 [US4] Write failing journey tests AS-29, AS-33, AS-34, AS-36 (staff bid 403; leader loses membership → `UNSOLD(leader_ineligible)`, unit back, no award notice; winner pays via J01 `purchase.ts` → `SOLD`, owner items, second payment no change; +48 h `SECOND_CHANCE`, runner-up order and notice, pay → `SOLD`, or +24 h `UNSOLD` stock back once; pause `auctions-order-results`, pay, resume, replay, late `order.paid` after offer).
- [X] T045 [US4] Verify/fix consumer `auctions-order-results` (group on `orders.events`) in `libs/domains/auctions/infra/auction-settlement.consumer.ts`: inbox dedupe, version guard, zod, DLQ; event-driven second chance emitting `auction.second_chance_offered`; `SOLD` only from `order.paid`; settlement order raises `shop.order_received` (G-22).

## Phase 6: User Story 3 — Live stream (P2)

**Goal**: AS-19..AS-26. **Independent test**: `-t "US3"`.

- [X] T046 [US3] Write failing journey tests AS-19, AS-20, AS-21, AS-22 (snapshot `SCHEDULED`, start ×20 → `LIVE`, one `stream_started` on the tap, non-member 404; comment batch/snapshot `recent`/history once; same `clientId` ×5 one 201, reuse 422; pin own product, foreign/archived/unknown 422, read-only 403, unpin → viewer event `{version, unpinned: true}`).
- [X] T047 [US3] Verify/fix in `libs/domains/launch-events/` live code (staff routes under `/shops/:shopId/live/...` with `ShopScoped('products.write')`, R1 `ShopAccessService.getRole`): stream start/end via outbox in the status transaction, comment durable-then-visible with `clientId`, `503 live_unavailable`, durable versioned pin with catalog product check, viewer connection subscribes before snapshot and watches `SCHEDULED` streams without the Redis `live:active` set (G-10, G-11, G-13, G-14).
- [X] T048 [US3] Write failing journey tests AS-23, AS-24, AS-25, AS-26 (removal ×20, one `comment_removed` on the tap; `[[toxic]]` auto removal once; pause `live-comments-history`, post/remove, resume, replay, removal-first order; end ×2 → connection closes, 409s, one `stream_ended`, stats stop, no notice).
- [X] T049 [US3] Fix `live-comments-history` (idempotent upsert with `removed` marker in any order, DLQ for invalid payloads, `GET /live/:id/history`) and `live-moderation` dedupe in `libs/domains/launch-events/infra/` (G-12); `launch-events.live-reconcile` handler.

## Phase 7: User Story 5 — Inbox tells the truth, all at once (P1)

**Goal**: AS-37, AS-38. **Independent test**: `-t "US5"`.

- [X] T050 [US5] Write failing journey test AS-37 (one buyer through booking, drop, auction: inbox content and order, `unread` equals unread items, read-all, SSE `user:<id>` counts); own fixtures.
- [X] T051 [US5] Write failing journey test AS-38 (concurrent miniatures of booking, drop, chat, auction; invariants; no cross-talk; all groups `lag 0`) and fix any cross-domain defect found in the owning domain.

## Phase 8: User Story 6 — Observable, boundaries hold (P3)

**Goal**: AS-39, AS-40. **Independent test**: `-t "US6"`.

- [X] T052 [US6] Write failing journey test AS-39 (metrics counters moved; every group `RUNNING`, `lag 0`; log redaction scan finds no token, key, e-mail or maximum bid, FR-030).
- [X] T053 [US6] Fix metrics/log redaction gaps in the owning domains found by AS-39; document each group's idempotency mechanism in its spec page (G-29).
- [X] T054 [US6] Write journey test AS-40 running the static gates over the five domains (`check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`, ESLint).
- [X] T055 [US6] Remove cross-domain coupling in `launch-events`, `live`, `auctions`, `orders`: no `ShopMembership`/`KeyStore`/`BisOrderModel`/`Product` imports, no foreign keys `LaunchEvent.shopId`/`Auction.shopId`, barrels export contracts only; no orders → launch-events edge (D-7, D-8, D-11, D-12, G-31).

## Phase 9: Polish and documentation

- [X] T056 Replace remaining `Date.now()` in production code of the five domains and the `JobWorker` due check with the injected `Clock` (G-01); `grep -rn "setTimeout\|sleep(" test/journeys` must stay empty.
- [X] T057 Count direct `sequelize.transaction` sites in the five domains, migrate each touched one to `TransactionRunner.run`/`@Transactional` and delete its `// S54 T037 audit` comment; count must not rise.
- [X] T058 Sibling-spec follow-ups: add `## Sibling-spec follow-ups` to `gaps.md` with bullets `- **S10**: consume voucher command, own Voucher table/route`, `- **S22**: ticket status carries admittedAt`, `- **S23**: classifier double`, `- **S28**: new rows flash_sale.sold_out/start_failed`, `- **S53**: event tap, queue consumers in consumer API`, `- **S49**: four job types`, and `- **W03**: align popover to topic user:<id>` (G-28); add `## Spec changes` there for any signed page changed.
- [X] T059 Ops artifacts: in `quickstart.md` keep the "Ops artifacts" list and add one row each to `ROOT/specs/UNVERIFIED.md` (spec J03, criterion, how to run, status `not run`) for SC-003, SC-004, SC-005, SC-006 (timing part), SC-008, SC-009; never describe them as verified.
- [X] T060 Final living-spec pass: `python3 scripts/livespec/check.py` clean for all edited pages (S10, S11, S21, S22, S23, S28, S49, S53).

## Dependencies

Phase 1 → Phase 2 → stories. US1 needs T010, T012, T014, T018; US2 needs T033; US3 needs T016; US4 needs T012; US5 needs US1, US2, US4 fixtures (or its own); US6 last. Phase 9 after all stories.

## Parallel examples

- Phase 1: T002, T003, T004 together.
- Phase 2: test tasks T009, T011, T013, T015, T017 together; their implementations touch different controllers.
- After Phase 2: US2 (T032–T039), US4 (T040–T045), US3 (T046–T049) touch different domains and can run in parallel; journey-file edits merge by `describe` block.

## Implementation strategy

MVP = Phases 1–3 (US1). Then slice-first per research.md §3: write the story's journey slice, run `-t "US<n>"`, fix the owning domain, move on. Runtime proofs belong to the final checkpoint, not to tasks.
