# Research: J03 — Launch Day

Static audit (nothing run) of the code against `gaps.md`, which pre-dates the built capability specs. Paths under `packages/backend/`. Status: **built** (code and an e2e spec exist; the journey still verifies it), **open** (absent in code), **verify** (cannot be judged by reading).

## 1. Gap status

| Gap | Status | Evidence / decision |
|---|---|---|
| G-01 clock | verify | `Date.now()` remains only in e2e specs, fixtures and `flash-sale-state.spec.ts`; none in production code of the four domains. The journey proves it by moving the clock (AS-05). |
| G-02, G-03, G-06 confirm, lifecycle | built/verify | `libs/domains/launch-events/application/confirm.service.ts`, `launch-event-outbox.ts`, `launch-events-confirm.e2e-spec.ts`. AS-01..AS-05 verify transaction, `HOLD_EXPIRED`, sold-out once. |
| G-04 voucher | **open** | the voucher command is emitted (`launch-event-outbox.ts`) and the queue is in `elasticmq.conf`, but `orders` has no consumer, model or route (grep `voucher` finds only launch-events). → WP1. |
| G-05, G-26 notifications | partial | `notifications/domain/event-mapping.ts` maps `launch_events.booking_confirmed` and `auction.*` (leader_changed, closed, second_chance_offered, sold); **no** `flash_sale.sold_out` / `start_failed` row. → WP2 (reason filter and atomic counter verified by AS-14, AS-37). |
| G-07..G-09 ticket, token, admitter | verify | S22 specs cover them; `admittedAt` is absent → WP5. |
| G-10..G-15 live | built/verify | `launch-events/application/events/live-events.ts`, `live-streams.e2e-spec.ts`; the classifier is `HeuristicToxicityClassifier` only → double in WP5. |
| G-16..G-19 drop | built/verify | `orders/infra/flash-sale.jobs.ts`, `flash-sale-lifecycle.e2e-spec.ts`, `application/flash-sold-out.service.ts`. |
| G-20..G-25 auctions | built/verify | `auctions/infra/auction-settlement.consumer.ts`, `order-request.adapter.ts` (uses `createFixedPriceOrder`, `orders/application/order-command.service.ts:47`), `auction-close.e2e-spec.ts`. |
| G-27 counter/dedupe | verify | AS-37 asserts `unread` equals unread items. |
| G-28 realtime topic | decision | the contract is `user:<id>` (questions.md); W03 aligns, not J03. |
| G-29 group names | verify | names fixed in spec.md; rename where a projector's `name` differs (WP6). |
| G-30 topics | verify | `scripts/init-kafka-topics.sh` must list `launch-events.events`, `live.events`, `auctions.events`, `orders.events`. |
| G-31 coupling | verify | `check:table-ownership --strict`, `check:boundaries` (AS-40). |
| G-40 allow-list | partial | `identity/api/jobs-admin.controller.ts` and `admin-jobs.e2e-spec.ts` hold J01/J02 types; the four J03 types are missing → WP4. |
| G-41 event tap | **open** | no `admin/topics` route → WP3. |
| G-42 queue consumer pause | **open** | `consumers-admin.controller.ts` serves Kafka groups → WP4. |
| G-43, G-44 doubles, fields | **open** | `[[toxic]]` double and `admittedAt` absent → WP5; vouchers WP1. |
| G-45 journey kit | **open** | `test/journeys/support` holds J01/J02 files only → WP7. |
| G-46 payment initiation | built (J01) | `support/purchase.ts` drives it. |

## 2. Decisions

- **Voucher is a record, not an order.** Orders consumes `orders.booking_voucher_requested` into a `Voucher` table with `UNIQUE(holdId)`; the insert is `ON CONFLICT DO NOTHING`, so redelivery is a no-op (IV.5). Rejected: a zero-amount order (it enters the payment state machine and the 15-minute expiry).
- **Tap in the identity admin surface**, next to `clock-admin`, `consumers-admin`, `jobs-admin`: reads relayed events through the Kafka admin/consumer client with a bounded `limit`; refused when `NODE_ENV=production` or the local profile is off. Rejected: topic reads in the test (breaks the black-box rule, VII).
- **Queue-consumer pause**: a pause flag the SQS consumer checks before receive (same flag store as the Kafka groups); `lag` = approximate visible messages of the queue. Rejected: stopping the process (it would stop every other consumer).
- **Classifier double** is selected by `PROVIDER_DOUBLES=enabled` (same switch as J01/J02), refused at startup in production.
- **Notices for drop facts** read shop owners through the exported membership query service (no `ShopMembership` import, D-7).
- **Time**: stack clock only; constants (10 min, 15 min, 48 h, 24 h) unchanged.

## 3. Order of work

Slice-first: write one story's scenarios, run with `-t "US<n>"`, fix the owning domain, repeat. US1 needs WP1/WP3/WP4/WP5; US2 needs WP2; US3 needs the classifier double; US4 needs only verification.

## 4. Risks

- The local monolith booting without the voucher consumer registered (L-015/L-018): register in orders' worker module and the monolith composition; standalone `worker` boot is checked at the final checkpoint.
- Journey runtime budget (SC-009, 15 min): US4 clock jumps replace waits; AS-38 uses miniatures.
