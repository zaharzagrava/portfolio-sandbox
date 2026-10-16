# Research: J01 — Buy to Payout

Static audit of the code at commit `272ef4b8` against `gaps.md` (written before S10–S18 were built). Nothing was run. "Not verified" items become first tasks (verify by running the journey slice, then fix).

## 1. Gap status today

| Gap | Status | Evidence / remaining |
|---|---|---|
| G-01 relay shape | PARTIAL | `outbox-publisher.service.ts:261` publishes the bare envelope; `infra/debezium/README.md` corrected. Missing: an e2e that reads the real topic message in poller and CDC mode (existing specs: `outbox-relay`, `outbox-cdc`, `relay-config`). |
| G-02 intents | DONE | `POST payments/intents` (`payment.controller.ts:34`); legacy topics gone. |
| G-03 monolith | DONE (verify) | Monolith composes worker + projector modules incl. payment processor, payouts, statements, notifications. Not confirmed: charge-command/refund-request workers bound, `payment.status` on `/api/streams`. |
| G-04 webhook | DONE | intake → job `orders.process-webhook` → `getPaymentStatus` → `COMPLETED` only. |
| G-05..G-08, G-24 | DONE | typed `payments.events`, `orders-payment-results` consumer, refund task and worker. zod/DLQ and "every path to COMPLETED posts the sale journal" unverified; covered by AS-17/18/24. |
| G-09 deferral | DONE | `settlement.service.ts` returns `sale_missing`, defers, skips refunded. |
| G-10 commission | **OPEN** | flat fee in `payments/domain/fee.ts`; nothing in payments reads `CommissionRateQueryService`. |
| G-11 `order.paid` | DONE (verify) | `paidAt`, `category` set in `order-lifecycle.service.ts`; confirm `lineId`, `shopOrders`, `orderVersion` in the schema (`orderEventSchemas`). |
| G-12 balance | PARTIAL | `availableMinor/asOf/source` present; confirm `shopId`, `currency`, stale-projection fallback, 400s. |
| G-13 | not verified | mechanism doc + test. |
| G-14..G-16 payouts | DONE | creation, destination route, list/detail/upcoming. |
| G-17 provider doubles | **OPEN** | `LoadTestPaymentProvider` succeeds always; no `pm_test_*`/`acct_test_*` anywhere. |
| G-18, G-19 statements | DONE | fact projectors, periods controller incl. findings and close. |
| G-20 events | PARTIAL | `ledger.journal_posted` v2 exists (`ledger-events.ts`); confirm `statements.events` emits. |
| G-21 notifications | DONE | `shop.order_received`, `payment.failed`, `payout.*`, `shopOwners`; confirm `payouts.events` is subscribed. |
| G-22, G-23 | not verified | locale/currency; SSE fan-out of `payment.status`. |
| G-25 consumer idempotency | PARTIAL | generic `consumer-idempotency.e2e-spec.ts`; per-consumer proof unconfirmed for baskets and webhook-router. |
| G-26 DLQ | PARTIAL | `scripts/projections/redrive.ts` and `projection-admin.service.ts`; no HTTP and no depth alert. |
| G-27 topics | **OPEN** | `init-kafka-topics.sh` lacks `orders/payments/ledger/payouts/statements.events`, still creates legacy payment topics. Queue `orders-refund-requested` **exists** in `elasticmq.conf:47-48`. |
| G-30 jobs | **OPEN** | only list/stats/retry/cancel exist. |
| G-31 consumers | **OPEN** | service + CLI only. |
| G-32 clock | **OPEN** | nothing. |
| G-33 fixtures | PARTIAL | destination route exists; S04 onboarding with extractor double and cooling period unverified. |
| G-34, G-37 | OPEN | no journey, no support kit, no `JOURNEY_ENV` doc. |
| G-35, G-36 | DONE | shop orders list, reconciliation runs/issues, findings. |
| Web W04 | **OPEN** | no balance/payouts/statements pages under `packages/web/app/dashboard/seller`; Playwright config and tests dir exist. |
| `// S54 T037 audit` | none | zero direct `sequelize.transaction` in orders/payments/statements/notifications. |
| Living spec | — | no `J*` pages in `docs/spec/capabilities`; `capabilities.tsv:75` registers J01. |

## 2. Decision: where the control surface lives

- **Decision**: three small route groups, each in the owner's module: jobs (S49 service, S01 admin controller), consumers (S53 projections lib), clock (S54).
- **Rationale**: J01 has no runtime exports (spec "Provides"); IV.1 forbids a J01 module reaching into internals; owners already have `JobsAdminService` and `projection-admin.service.ts`.
- **Alternatives**: a `journey-support` Nest module that wires everything — rejected: needs imports of infra of many domains (boundary violation) and would exist in production images.

## 3. Decision: consumer pause/resume/replay semantics

- **Decision**: pause = a Redis flag per group, read by `ProjectionRunner` before each poll (resume cursor stays in Kafka committed offsets), so every process running the group sees it; `lag` = sum over partitions of (end offset − committed offset), `state` from the flag; `replay {since}` = offsets-for-times seek on the group while paused, then resume, using the existing `projection-admin.service` rebuild path. Pause/resume/replay need admin role + sensitive session in every profile (per questions.md CONTRACT); no stack flag.
- **Rationale**: the monolith runs all groups in one process but the standalone projector app must obey the same switch; Kafka offsets are already the truth of "where the consumer is".
- **Alternatives**: in-process flag (breaks multi-process, L-018); deleting the consumer group (loses offsets, replays everything).
- **Risk**: replay must be idempotent across all consumers of the topic (G-25); AS-25 proves it for six groups, WP7 for the others.

## 4. Decision: the controllable clock

- **Decision**: a `ClockService` in S54 returning `now()` from `real` or `real + offsetSeconds`, offset stored in Redis (shared by all processes, read with a 200 ms local cache), enabled only when `CLOCK_CONTROL=enabled`; config validation fails startup if enabled with `NODE_ENV=production`. `PUT {advanceSeconds}` forward only; `PUT {mode:"real"}` resets. Domain code under journey (order hold expiry, payout cooling and weekly window, period close, statement months) must read time through it; the audit task is "grep `new Date()`/`Date.now()` in those domains' application layer and migrate".
- **Rationale**: spec needs +16 min, +49 h, next month; faking by DB edits violates black-box.
- **Alternatives**: libfaketime per process (not controllable from the API); mutating DB timestamps (no).
- **Note**: job schedulers use DB `now()` for claims (`FOR UPDATE SKIP LOCKED`); jobs triggered through the control surface are enqueued with `runAt` from the clock service, so due-time comparisons stay consistent. Verify in the first task.

## 5. Decision: provider doubles

- **Decision**: a `ScriptedPaymentProvider` and `ScriptedPayoutProvider` implementing the existing `domain/` ports, bound in the local/test profile when `PROVIDER_DOUBLES=enabled` (refused in production). Behaviors by `paymentMethodId` (`pm_test_visa` ok, `pm_test_declined` definite decline, `pm_test_slow` ok after 8 s through the clock-independent timer, `pm_test_timeout` never answers) and `providerAccountId` (`acct_test_ok`, `acct_test_reject`, `acct_test_timeout`). Replaces the `is_load_test` global switch on those two ports; the order's currency is used.
- **Rationale**: IV.8 ports + adapters; deterministic failure scenarios with no global flag.
- **Alternatives**: keep `IS_LOAD_TEST`+Stripe test mode (nondeterministic, network).
- **Open**: the signed webhook the test posts needs the stack secret: the test reads `STRIPE_WEBHOOK_SECRET` from `JOURNEY_ENV` (G-37).

## 6. Decision: commission at settlement (G-10)

- **Decision**: `SettlementService` asks `CommissionRateQueryService.getRatesAsOf(shopId, category, paidAt)` per line, computes `commissionOf` per S16.R-04 (half-up, integer), credits shop `lineTotal − commission`, credits `PLATFORM_COMMISSION` the sum; sale journal books the full captured amount to clearing; refunds reverse the settlement amounts exactly. Remove the flat-fee split in `fee.ts` after callers move. Reuse the statements `commissionOf` through the exported service so both sides use one function (export a pure `priceLines` from the query service rather than copying the formula).
- **Rationale**: only way for ledger credit == statement net (AS-07, AS-15, SC-006).
- **Impact**: S14 spec page (AS-11, 14, 15, refund) and fixtures change; `finance.e2e-spec.ts` and ledger specs expecting fee 50 are updated in the same change (this is a deliberate behavior change, spec page first). Sibling follow-ups recorded in gaps.md.

## 7. Decision: journey kit shape

- `JourneyClient`: `fetch` with cookie jar per actor, parses every response with the `packages/contracts` schema.
- `waitForContract(hop, probe)`: `waitFor` from `test/utils/async-helpers.ts`, poll 250 ms, deadline = 2 × max × `JOURNEY_TIME_FACTOR`; hop table is a constant keyed H1..H13.
- `sellerFixture`: signs up owner/staff, creates shop, drives S04 onboarding with the extractor double to verified, creates products with stock via S05, sets destination through `PUT /finance/shops/:id/payout-destination`; 409 → read existing (L-010).
- `controlSurface`: jobs, consumers, clock; `restoreAll()` is idempotent and exits 0 when nothing is paused (L-016); run in `afterAll` and in a global teardown.
- SSE: `test/utils/sse-client.ts` `readSse`.

## 8. Decision: UI journey

One Playwright test in `packages/web/tests/buy-to-payout.spec.ts` (AS-29): buyer pays; seller opens balance card, payouts page, statements tab with "as known on" and CSV link. Requires W04 screens first (WP10). Data prepared through the API using the same fixture helpers (not a copy), unique user per run (L-006).

## 9. Unverified by automation

SC-001 (99% of runs ≤ 5 s) and SC-007 (clean stack to green in under 10 minutes, 0 sleeps) are aggregates over many runs; the journey asserts each hop's deadline once but does not prove a percentile. They go to `quickstart.md` Ops artifacts and `specs/UNVERIFIED.md`. All other SCs are asserted inside the journey (SC-002 sums, SC-003 duplicates, SC-004 lag ≤ 15 s, SC-005 failure paths, SC-006 statement vs ledger).
