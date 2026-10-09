# Test Plan: J01 — Buy to Payout

Constitution VII.8: one row per acceptance scenario in [`spec.md`](spec.md) (31 rows). A rule already proven inside one capability is referenced in the last column, never re-tested here.

- Journey file: `packages/backend/test/journeys/buy-to-payout.journey-spec.ts`, top-level `describe` "Journey J01: buy to payout", one nested `describe` per user story. It runs against the **running local stack** (`moon run infra-setup`, then `moon run dev-monolith`; `pnpm test:journeys`; `API_URL` default `http://localhost:8000`), black box: public APIs, the SSE stream and the control surface only; no database, topic or queue reads.
- Waiting: `waitForContract(hop, probe)` over `test/utils/async-helpers.ts` `waitFor` (poll 250 ms, deadline = 2 × the hop's maximum in `spec.md`, × `JOURNEY_TIME_FACTOR`). No fixed sleeps.
- Fixtures (`test/journeys/support/`): unique users and shops per test through public APIs; `controlSurface` restores the clock and resumes every paused group in `afterAll`.
- Provider doubles at the edge, selected by `paymentMethodId` / `providerAccountId`. Webhooks are posted signed with the stack's secret.
- Order of the file: US1 → US2 → US4 → US5 share one purchase; US6, US7, US8 each create their own orders.
- UI: `packages/web/tests/buy-to-payout.spec.ts` (Playwright, happy path, AS-29 only).
- Static gates (AS-31): `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`.

| Scenario | Journey test (`packages/backend/test/journeys/buy-to-payout.journey-spec.ts`) | Already proven by capability (ID) |
|---|---|---|
| AS-01 happy path to paid | `US1: buyer pays a multi-shop order`: checkout → intent → payment `COMPLETED` → order `PAID`; stream order of `payment.status`, `order.status`; stock read back | S10 AS-13 (checkout), S13 AS-01 (intent), S13 AS-15 (charge), S10 AS-50 (payments result → paid) |
| AS-02 webhook after success | `US1`: signed webhook once and ×10 concurrent; order version and timeline length unchanged | S10 AS-43 (duplicate webhook), S10 AS-42 (signature) |
| AS-03 webhook first | `US1`: slow payment, webhook before `COMPLETED`; order stays `RESERVED`, then `PAID` once | S10 AS-41, AS-44 (status check unavailable → retry), S10 AS-50 (race of the two paths) |
| AS-04 order copy lags, consumer down | `US1`: pause `payments-order-copy`; intent → `404`; resume, same key → `202`, one payment | S13 AS-12, AS-44 (copy idempotent and ordered), S13 AS-09 (key not remembered) |
| AS-05 books follow the payment | `US2`: both balances equal `net(s)`; sum + fee = 2500; `asOf` ≥ `paidAt`; cross-shop `404` | S14 AS-11, AS-17 (journals, settlement), S14 AS-32, AS-37 (balance, freshness) |
| AS-06 no credit without a sale | `US2`: balances unchanged after declined and expired orders | S14 AS-20, AS-21 |
| AS-07 balance equals statement | `US2`/`US5`: statement `own.netMinor` == ledger credit; findings have no mismatch | S16 AS-72, AS-73 (reconciliation), S14 AS-17 |
| AS-08 sale notices | `US3`: buyer and owners get one item each, staff none; `unread-count`; SSE `notification` | S28 AS-01, AS-07 (recipients), AS-02 (duplicates) |
| AS-09 declined card notices | `US3`: one `payment.failed` for the buyer, none for sellers, no `order.confirmed` | S28 AS-13 (rule table) |
| AS-10 payout notices | `US3`: `payout.paid` and `payout.failed` to owners only | S28 AS-07 |
| AS-20 weekly run | `US4`: run job → payout `PENDING` → `PAID`; balance = reserve; upcoming; statement `payoutsPaidMinor` | S15 AS-01, AS-04, AS-31, AS-35; S15 transfer AS-17 to AS-20 |
| AS-21 re-run and overlap | `US4`: three runs → still one payout, balance unchanged | S15 AS-02, AS-03 |
| AS-22 below minimum | `US4`: no payout, `blockedReason: below_minimum` | S15 AS-06, AS-35 |
| AS-23 transfer rejected | `US4`: payout `FAILED`, balance restored, `payout.failed` notice, statement unchanged | S15 AS-23 (definite rejection and reversal) |
| AS-13 live statement follows the chain | `US5`: gross, commission, net, line count, `dataAsOf`, `payoutsPaidMinor` | S16 AS-14, AS-51, AS-56, AS-58 |
| AS-14 close the month | `US5`: advance clock, close job, `CLOSED`, snapshot equals live, second close `409` | S16 AS-28 to AS-30, AS-34 |
| AS-15 books tie out | `US5`: findings list has no mismatch for the journey | S16 AS-72, AS-73 |
| AS-17 declined card | `US6`: payment `FAILED` → order `CANCELLED(payment_failed)` → stock back; no journal; second intent `409` | S13 AS-16 (decline), S10 AS-48 (cancel on failure), S10 AS-31 (stock release) |
| AS-18 cancel while charge in flight | `US6`: cancel, late success → refund task → payment `REFUNDED`, order stays `CANCELLED`, balances unchanged | S10 AS-51 (pay versus cancel), S13 AS-50 to AS-53 (refund command), S14 AS-14, AS-16 |
| AS-19 hold expiry | `US6`: clock +16 min, job, `CANCELLED(hold_expired)`, stock back, intent `409 hold_expired` | S10 AS-36, AS-37 (expiry), S13 AS-44 (copy follows `order.cancelled`) |
| AS-24 same key, many times | `US7`: checkout ×5 concurrent and after paid; intent ×5; webhook ×10; observables equal the clean run | S10 AS-15 to AS-17, S13 AS-03, AS-04 (replay, in flight), S10 AS-43 |
| AS-25 replay of the topics | `US7`: replay `orders.events`, `payments.events`, `ledger.events`, `payouts.events` for the six groups; every observable identical | S14 AS-18 (settlement dup), S16 AS-52, AS-53, AS-59, S28 AS-02, S13 AS-44 |
| AS-26 out-of-order provider signal | `US7`: `payment_failed` after success → order stays `PAID`, no cancel notice | S10 AS-47 |
| AS-27 settlement consumer down | `US8`: pause `ledger-settlement`; order `PAID`; no credit, lag ≥ 1; resume; credit once, lag 0; payout run pays only settled balance | S14 AS-20 (deferral), AS-18 (dup) |
| AS-28 notification and statements consumers down | `US8`: inbox empty then exactly one item; `dataAsOf` behind, close `409 period_not_ready`, resume, close succeeds | S28 AS-03 (crash and replay), S16 AS-32 |
| AS-29 UI journey | `packages/web/tests/buy-to-payout.spec.ts`: buyer pays, sees paid without reload; seller sees balance, paid payout, statement line | W03 (checkout page), W04 (dashboard), S14 AS-32, S15 AS-37, S16 AS-14 (API behind the screens) |
| AS-30 every hop is observable | `US9`: metrics counters moved; all six groups `lag: 0`; log lines carry `requestId`/`traceId`; no secret in output | S10 AS-66, S13 AS-62, S14 AS-65, S28 AS-86 |
| AS-31 approved paths only | Not a journey test: static gates listed above, run in CI | S10 AS-68, S14/S15/S16 boundary scenarios |
