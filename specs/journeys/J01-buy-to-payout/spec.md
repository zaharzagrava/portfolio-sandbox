# Feature Specification: J01 — Buy to Payout: a multi-shop order is paid, booked, settled, paid out to sellers and reported in a monthly statement

**Feature Branch**: `J01-buy-to-payout` (spec directory `specs/journeys/J01-buy-to-payout`)

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Cross-domain journey J01: Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified." Sources: constitution v3.1.0 (IV, VII, IX.7), `docs/architecture/domain-map.md`, `docs/architecture/debt-register.md` (D-11), the specs S10, S13, S14, S15, S16, S28, `interview-prep/10-system-design/07-commerce-and-transactions.md` §19–20, `interview-prep/06-distributed-systems/02-consistency-sagas-and-data-sync.md` §2 and §5, and the current code (see `gaps.md`).

## Scope

One buyer fills a cart with products of two shops, checks out, pays, and later each seller is paid and sees the sale in a monthly statement. Eight domains take part. This journey proves only the **hand-offs between them**; every rule inside one domain is already proven by that domain's own spec and is referenced, never re-tested (see `test-plan.md`).

The chain, with the kind of hand-off at each arrow (constitution IV.3, IX.7):

```
buyer ─POST /checkout─► orders ──R1──► catalog (stock), shop-functions (discounts)
orders ─outbox: order.reserved─► (orders.events) ─► payments (order copy, R3)
buyer ─POST /payments/intents─► payments ─job─► payment provider (edge)
payments ─same transaction, R1─► ledger (SALE journal) ; outbox: payments.payment_succeeded, ledger.journal_posted
payments.events ─► orders (consumer)  ┐ either path marks the order paid once
provider webhook ─► orders ──R1──► payments.getPaymentStatus ┘
orders ─outbox: order.paid─► (orders.events) ─► ledger-settlement ; notifications ; statements facts
ledger ─outbox: ledger.journal_posted─► (ledger.events) ─► balance projector ; statements facts
operator/schedule ─job payouts.run-weekly─► payouts ──R1──► ledger (balances, PAYOUT journal) , tenancy (shop eligibility)
payouts ─job payouts.send─► provider ; outbox: payout.* ─► (payouts.events) ─► notifications ; statements facts
operator/schedule ─job statements.close-month─► statements (snapshots) ; outbox: statements.period_closed
failure edges: payments.payment_failed → orders cancel → stock release ; orders.refund_requested (SQS) → payments refund → ledger REFUND
```

In scope:

- The user-visible outcomes of the chain: order status, payment status, seller balance, payouts, statements, notifications.
- The **eventual-consistency contract** of every asynchronous hop (maximum time to visibility on the local stack and how a client observes progress).
- The cross-domain failure modes: duplicate and out-of-order events, a consumer that is down and catches up, replay, the compensation sagas (declined card, cancel-versus-pay race, hold expiry, rejected payout), retried requests with the same idempotency key.
- The **journey control surface** the black-box test needs on the local stack (run a job, pause/resume/replay a consumer, move the clock) and the provider doubles it relies on.
- The hand-offs that are missing or broken in the code today (`gaps.md`).

Out of scope (owners named):

- Cart, stock arithmetic, order state machine internals, webhook signature rules → **S10**; payment state machine, unknown outcomes, breaker → **S13**; journal arithmetic, shards, reconciliation → **S14**; reserve and payout state machine → **S15**; commission rates, adjustments, CSV → **S16**; templates, preferences, quiet hours, delivery channels → **S28**.
- Seller onboarding to a verified shop and subscriptions → **J02** (this journey only needs a verified, payout-enabled shop as a fixture).
- Provider-initiated refunds and disputes (found by reconciliation) → **S14**; fulfilment, shipping and delivery → **S19, S20**; flash sales → **J03**.
- Screens: checkout and orders → **W03**; seller balance, payouts, statements → **W04**. This journey contributes **one** happy-path UI scenario (AS-29).

## User Scenarios & Testing *(mandatory)*

### Notation and conventions

- Buyer `U` (a signed-in user), shops `S1` and `S2` each with an owner (`O1`, `O2`) and a staff member (`T1`), a verified shop with payouts enabled and a payout destination (fixture). Products `A` (shop `S1`, price `1000`, stock `10`) and `B` (shop `S2`, price `500`, stock `4`). Order `O` = `A × 2 + B × 1`, total `2500` EUR minor units. Shop subtotals `S1: 2000`, `S2: 500`. `commission(s)` is the rate the statements capability reports for the shop and category (`GET /admin/commission-rates/as-of`); `net(s) = subtotal(s) − commission(s)`.
- Every user, shop and product is created by the test through public APIs with unique names, so journeys can share a stack. No database, topic or queue is read by the test.
- A hand-off step in a scenario is written **`[trigger] → [domain reacts] → [observable]`**. Triggers are: an API call, a domain event, an SQS task, a scheduled job. Observables are public API reads, the SSE stream `GET /api/streams?topics=user:<id>`, or the control surface below.
- **Waiting** is done only by polling an observable until it shows the expected state, with the deadline of the hop's contract (table below, deadline = 2 × maximum, poll interval 250 ms, scaled by `JOURNEY_TIME_FACTOR`). A fixed sleep is a test defect.
- **Provider doubles** (system edge, selected by configuration of the local stack; constitution VII.2): the payment provider answers by `paymentMethodId`: `pm_test_visa` (succeeds), `pm_test_declined` (definite decline), `pm_test_slow` (succeeds after 8 s), `pm_test_timeout` (never answers); the transfer provider answers by destination `providerAccountId`: `acct_test_ok`, `acct_test_reject` (definite rejection), `acct_test_timeout`. The provider's webhooks are posted by the test, signed with the stack's webhook secret.
- **Control surface** (admin role, local-stack profile; see Cross-capability contracts): `POST /api/admin/jobs` + `GET /api/admin/jobs/:jobId`; `GET /api/admin/consumers/:group`, `POST …/pause`, `…/resume`, `…/replay {since}`; `GET|PUT /api/admin/clock`.
- Every error is `application/problem+json` with a stable `code` (S54).

### Eventual-consistency contract (the hops)

Maximum time from the trigger until the result is visible **on the local stack** (single deployment of all processes, outbox relay interval ≤ 2 s). The owner of each hop must meet it; the journey tests wait on it.

| Hop | From → to | Visible through | Max | Owner |
|---|---|---|---|---|
| H1 | `order.reserved` → payments' order copy | `POST /payments/intents` stops answering `404 order_not_found` for the buyer's own order | 3 s | S13 |
| H2 | payment accepted → charge → `COMPLETED` (provider answers at once) | `GET /payments/:id`; SSE `payment.status` | 5 s | S13 |
| H3 | `payments.payment_succeeded` → order `PAID` | `GET /orders/:id`; SSE `order.status` | 5 s | S10 |
| H3w | provider webhook accepted (`200`) → order `PAID` (payment already `COMPLETED`) | `GET /orders/:id` | 5 s | S10 |
| H4 | `order.paid` → settlement journal → seller balance | `GET /shops/:id/balance` (`availableMinor`, `asOf`) | 10 s | S14 |
| H5 | `order.paid` → buyer and shop-owner inbox items | `GET /notifications`, `/unread-count`; SSE `notification` | 5 s | S28 |
| H6 | `order.paid`, `ledger.journal_posted`, `payout.paid` → statement facts | `GET /shops/:id/statements/:month` (`dataAsOf` ≥ the event's time) | 10 s | S16 |
| H7 | job `payouts.run-weekly` finished → payout `PENDING` | `GET /shops/:id/payouts` | 5 s | S15 |
| H8 | payout `PENDING` → transfer sent → `PAID` | `GET /shops/:id/payouts/:id` | 15 s | S15 |
| H9 | `payout.paid` / `payout.failed` → owner inbox item | `GET /notifications` | 5 s | S28 |
| H10 | `POST …/close` accepted → period `CLOSED` | `GET /admin/accounting-periods/:month` | 30 s | S16 |
| H11 | `payments.payment_failed` / hold expiry → order `CANCELLED` and stock restored | `GET /orders/:id`; product stock read | 10 s | S10 |
| H12 | `orders.refund_requested` → payment `REFUNDED` and reversing journal | `GET /payments/:id` | 15 s | S13 |
| H13 | any job triggered through the control surface → finished | `GET /admin/jobs/:jobId` | 5 s to start | S49 |

A consumer that is behind exposes its lag through `GET /admin/consumers/:group` (`lag`, `state`); a consumer at rest reports `lag: 0`.

---

### User Story 1 — A buyer pays for a multi-shop order and it becomes paid exactly once (Priority: P1)

The buyer checks out a cart with products of two shops and pays. Whether the payment result reaches the order through the payments event, through the provider's webhook, or through both at once, the order is paid once, in the right amount, and the buyer can follow the progress.

**Why this priority**: every later step (books, sellers, payouts, statements) starts from one paid order; a double or missing transition breaks all of them.

**Independent Test**: run checkout → intent → webhook for one buyer; assert order, payment and the buyer's stream.

**Acceptance Scenarios**:

1. **AS-01** (happy path to paid) — **Given** `U`'s cart `{A: 2, B: 1}` and the stock above, **When** (1) `U` calls `POST /checkout` with `Idempotency-Key: k-j01-0001` → *orders; R1 calls to catalog (stock) and discounts* → `202 {orderId: O, status: "RESERVED", totalMinor: 2500}` and `GET /orders/O` shows two shop orders `2000` and `500`; (2) `order.reserved` → *payments keeps its order copy* (H1); (3) `U` calls `POST /payments/intents {orderId: O, paymentMethodId: "pm_test_visa"}` with `Idempotency-Key: k-j01-0002` → `202 {status: "PENDING", amountMinor: 2500}`; (4) the charge job → *payments, provider double* → `GET /payments/:id` `COMPLETED` (H2), SSE `payment.status`; (5) `payments.payment_succeeded` → *orders* → `GET /orders/O` `PAID`, both shop orders `PAID`, one timeline row `RESERVED → PAID` (H3), SSE `order.status` `PAID`; **Then** `U`'s stream carried `payment.status` then `order.status` in that order, and stock of `A` is `8` and of `B` is `3` (read through the catalog's own read API).
2. **AS-02** (the webhook arrives too: both paths agree) — **Given** AS-01 completed, **When** the test posts the provider's signed `payment_intent.succeeded` for the same payment to `POST /webhooks/stripe` (once, then ten times at once), **Then** every answer is `200` (`duplicate: true` after the first), `GET /orders/O` is unchanged (same timeline length, same version), and the seller balances, inbox counts and statement lines asserted later do not change.
3. **AS-03** (the webhook arrives first) — **Given** a second order `O2` paid with `pm_test_slow` (provider answers after 8 s), **When** the signed `payment_intent.succeeded` is posted *before* the payment is `COMPLETED` → *orders acknowledges `200`, its job asks payments for the payment's status (R1), gets `PENDING`, retries* → `GET /orders/O2` stays `RESERVED` while payments is `PENDING`; **When** the payment becomes `COMPLETED`, **Then** the order becomes `PAID` within H3w, exactly once; a webhook can never mark an order paid while payments does not say `COMPLETED`.
4. **AS-04** (the order copy lags: consumer down, then catch-up, same key retried) — **Given** the payments consumer of `orders.events` paused through the control surface and a new reserved order `O3`, **When** `U` posts the intent with key `k-j01-0003`, **Then** after 2 s `404 order_not_found` (identical to a foreign order) and no payment exists; **When** the consumer is resumed and `lag` is `0` and `U` retries with the same key, **Then** `202` and exactly one payment exists (the first answer was not remembered).

---

### User Story 2 — The money is booked once and each seller is credited exactly their share (Priority: P1)

When an order is paid, the platform's books record the buyer's money, then split it between the shops and the platform. A seller sees the credited amount on their balance, and it matches what their statement says.

**Why this priority**: an error here is a seller paid wrongly or a buyer refunded from the wrong pocket.

**Independent Test**: after AS-01, read both sellers' balances and the statement lines.

**Acceptance Scenarios**:

1. **AS-05** (books follow the payment) — **Given** AS-01, **When** the payment is `COMPLETED` → *payments posts the sale journal inside its own transaction (R1 to the ledger) and outboxes `ledger.journal_posted`* and `order.paid` reaches *the ledger's settlement consumer* → one settlement journal, **Then** `GET /shops/S1/balance` shows `availableMinor = net(S1)` and `GET /shops/S2/balance` shows `net(S2)` within H4, `source` is `read_model`, `asOf` is not earlier than the order's `paidAt`; the sum of both nets plus the platform's fee equals `2500`; a member of `S1` cannot read `S2`'s balance (`404 shop_not_found`).
2. **AS-06** (no credit without a sale; no sale without a payment) — **Given** the declined order of AS-17 and the hold-expired order of AS-19, **When** the balances are read, **Then** they are unchanged (`0` for fresh shops) and no `order.paid`-derived item exists for those orders.
3. **AS-07** (seller balance equals the statement) — **Given** AS-05, **When** `S1`'s owner reads `GET /shops/S1/statements/<current month>` (see AS-13), **Then** `own.netMinor` equals the ledger credit that order produced for `S1` (`net(S1)`), and the finance findings of that month (`GET /admin/accounting-periods/<month>/findings`) hold no `net_mismatch` and no `fee_mismatch` for the order (the books and the statement agree on the commission).

---

### User Story 3 — The buyer and each seller hear about it exactly once (Priority: P2)

The buyer gets an order confirmation; each shop's owners get "you have an order"; later the seller is told the payout was sent or failed. Nobody is told twice, nobody is told about a failed payment as if it were a sale.

**Why this priority**: notifications are how participants learn the chain moved; duplicates and false notices destroy trust.

**Independent Test**: read the three inboxes after AS-01 and again after replays.

**Acceptance Scenarios**:

1. **AS-08** (sale notices) — **Given** AS-01, **When** `order.paid` → *notifications* (H5), **Then** `U`'s `GET /notifications` holds exactly one `order.confirmed` with `link: /orders/O`; `O1` holds exactly one `shop.order_received` for `O` mentioning only `S1`'s subtotal; `O2` exactly one for `S2`; staff `T1` holds none; `unread-count` of `U` is `1`; the SSE `notification` event reached `U`'s stream.
2. **AS-09** (declined card notices) — **Given** AS-17, **Then** `U` holds exactly one `payment.failed` notice and no `order.confirmed`; `O1` and `O2` hold no notice for that order.
3. **AS-10** (payout notices) — **Given** AS-20 reached `PAID`, **When** `payout.paid` → *notifications* (H9), **Then** `O1` holds exactly one `payout.paid` notice with the paid amount; `T1` and the other shop's owner hold none; for the rejected payout of AS-23 `O1` holds exactly one `payout.failed`.

---

### User Story 4 — Each seller is paid their balance once a week and can see it (Priority: P1)

The weekly run turns each eligible shop's balance into a payout, the transfer is sent once, the seller's balance goes down by that amount (minus the reserve that stays), and the seller sees the payout move to paid.

**Why this priority**: a missed payout is a support case; a double or phantom payout is lost money.

**Independent Test**: after AS-05 and the fixture steps, run the job and read payouts and balances.

**Acceptance Scenarios**:

1. **AS-20** (the weekly run) — **Given** AS-05 with `S1` balance `n1 ≥` the minimum payout, a destination `acct_test_ok` set by the operator (`PUT /finance/shops/S1/payout-destination`) and the clock advanced by 49 hours (cooling period), **When** (1) the operator calls `POST /admin/jobs {type: "payouts.run-weekly"}` → *control surface* → `202`, `GET /admin/jobs/:id` `SUCCEEDED` (H13); (2) *payouts reads balances from the ledger (R1), shop eligibility from tenancy (R1), posts a payout journal in its own transaction and queues the send job* → `GET /shops/S1/payouts` shows one payout `PENDING` with `amountMinor = n1 − reserve` and `reserveHeldMinor = reserve` (H7); (3) the send job → *payouts, transfer provider double* → `IN_TRANSIT` then `PAID` with a `transferRef` (H8); **Then** `GET /shops/S1/balance` equals `reserve` (read after the payout journal's event reached the projector, H4), `GET /shops/S1/payouts/upcoming` shows the new available amount, and `S1`'s statement shows `payoutsPaidMinor` equal to the paid amount after `payout.paid` reached statements (H6).
2. **AS-21** (re-run and overlap change nothing) — **Given** AS-20, **When** the run is requested again with a new job key and twice at once, **Then** each job ends `SUCCEEDED` but `GET /shops/S1/payouts` still holds one payout for the week, the balance is unchanged and no second transfer or notice exists.
3. **AS-22** (a shop below the minimum is not paid) — **Given** `S2` whose balance is below the minimum payout, **When** the run executes, **Then** `S2` has no payout, its balance is untouched and `GET /shops/S2/payouts/upcoming` shows `blockedReason: "below_minimum"`.
4. **AS-23** (compensation: the provider rejects the transfer) — **Given** a shop `S3` (a second fixture) with destination `acct_test_reject` and a balance, **When** the run and the send job execute → *payouts, provider double rejects* → payout `FAILED` with a `failureCode`, and *payouts posts the reversing journal* → `GET /shops/S3/balance` returns to its value before the run (H4), `payout.failed` → owner notified (AS-10), the statement's `payoutsPaidMinor` stays `0`, and the next run pays the shop again once the destination is fixed.

---

### User Story 5 — The monthly statement agrees with the books and then freezes (Priority: P2)

A seller reads the current month live — sales, commission, net, payouts — and after the month ends the platform freezes it. The frozen numbers equal what the seller saw, and a late fact becomes an adjustment, never an edit.

**Why this priority**: it is the sellers' record; its figures must tie to the ledger and the payouts.

**Independent Test**: read the live statement after the sale and the payout; advance the clock; close; read again.

**Acceptance Scenarios**:

1. **AS-13** (the live statement follows the chain) — **Given** AS-01, **When** `order.paid` → *statements applies sale facts* (H6) and later `payout.paid` → *statements applies the payout fact*, **Then** `GET /shops/S1/statements/<month>` shows `status: OPEN`, `source: live`, `own.grossMinor = 2000`, `own.lineCount = 1`, `own.commissionMinor = commission(S1)`, `own.netMinor = net(S1)`, `dataAsOf` not earlier than the order's `paidAt`, and after AS-20 `own.payoutsPaidMinor` equals the paid payout; the other shop's numbers never appear.
2. **AS-14** (close the month) — **Given** AS-13 and the clock advanced into the next month past 02:00 UTC on the 2nd, **When** the operator calls `POST /admin/accounting-periods/<month>/close` (or lets the schedule run, via the control surface) → *statements closes in order, once* → `GET /admin/accounting-periods/<month>` becomes `CLOSED` (H10) and `S1`'s statement reads `source: snapshot` with numbers **identical** to AS-13's; a second close answers `409 period_closed`.
3. **AS-15** (the books tie out for the month) — **Given** AS-14, **Then** the month's findings list holds no `net_mismatch`, `fee_mismatch`, `missing_in_ledger` or `missing_in_statement` for the journey's order, shops or payouts.

---

### User Story 6 — When payment fails or is abandoned, everything is compensated and nobody is paid (Priority: P1)

A declined card, a hold that runs out, and a buyer who cancels while the charge is in flight each end with the order cancelled, the stock back, no seller credited, and the buyer's money returned where it was taken.

**Why this priority**: the compensation paths are where marketplaces lose money and inventory.

**Independent Test**: run each failure with its own order and read order, payment, stock, balances and inboxes.

**Acceptance Scenarios**:

1. **AS-17** (declined card) — **Given** a reserved order `Od` (`A × 1`), **When** `U` posts the intent with `pm_test_declined` → *payments, provider double* → payment `FAILED` (H2) → `payments.payment_failed` → *orders cancels* → `GET /orders/Od` `CANCELLED` with reason `payment_failed` (H11) and the stock of `A` is back to its value before checkout, **Then** no balance moved, no `order.paid` was published for `Od` (statement and inboxes unchanged, AS-06, AS-09), and a second intent for `Od` answers `409 order_not_payable`.
2. **AS-18** (cancel while the charge is in flight) — **Given** a reserved order `Oc` and an intent with `pm_test_slow`, **When** `U` calls `POST /orders/Oc/cancel` (→ `CANCELLED(user_cancelled)`, stock back once) and 8 s later the provider's answer arrives → *payments: `COMPLETED`, sale journal* → `payments.payment_succeeded` → *orders finds the order cancelled and requests a refund (SQS task `orders.refund_requested`)* → *payments refunds, posts the reversing journal* → `GET /payments/:id` `REFUNDED` (H12), `payments.payment_refunded`; **Then** the order stays `CANCELLED` (never `PAID`), the stock was restored exactly once, `S1` and `S2` balances are unchanged, no `shop.order_received` exists, and `U`'s money is accounted for (the payment is `REFUNDED`, the ledger nets to zero for it).
3. **AS-19** (hold expiry) — **Given** a reserved, unpaid order `Oe` and the clock advanced by 16 minutes, **When** the expiry job → *orders* → `GET /orders/Oe` `CANCELLED(hold_expired)` and the stock is back (H11); `order.cancelled` → *payments' order copy* (H1) → **Then** `POST /payments/intents` for `Oe` answers `409 order_not_payable` with `reason: "hold_expired"`, and the balances are unchanged.

---

### User Story 7 — Retried and duplicated requests and events change nothing twice (Priority: P2)

Buyers double-click, clients time out and retry, providers repeat webhooks, and operators replay topics. The visible state after any of that equals the state after one clean run.

**Why this priority**: at-least-once delivery is the contract of every hop; exactly-once effect is what the participants see.

**Independent Test**: repeat each trigger and replay each topic, then compare the observables with the clean run.

**Acceptance Scenarios**:

1. **AS-24** (same key, many times) — **Given** a fresh cart, **When** checkout is sent five times at once with the same key, then again after the order is `PAID`, **Then** one order exists (`GET /orders` lists it once) and every `202` carries the same `orderId`; **When** the intent is sent five times at once with one key, **Then** one payment exists (`GET /payments?orderId=`); **When** the provider webhook is delivered ten times at once (AS-02), **Then** the balances, inbox counts and statement lines after the settle time equal those of a single delivery.
2. **AS-25** (replay of the topics) — **Given** AS-20 completed and all observables recorded (order, payment, balances, payouts, inbox counts, statement), **When** the operator replays, through the control surface, `orders.events`, `payments.events`, `ledger.events` and `payouts.events` from the time the journey started for the groups `payments-order-copy`, `orders-payment-results`, `ledger-settlement`, `ledger-balances`, `notification-router`, `statements-facts`, and each reports `lag: 0` again, **Then** every observable is identical to the recorded one (older versions arrive after newer state and are discarded; duplicates have no effect).
3. **AS-26** (out-of-order provider signals) — **Given** AS-01 completed, **When** the provider's signed `payment_intent.payment_failed` for the same intent arrives afterwards, **Then** `200`, the order stays `PAID` (no cancel, no restock), balances and inboxes are unchanged, and no `order.cancelled` exists in the buyer's inbox.

---

### User Story 8 — A consumer that is down loses nothing and catches up exactly once (Priority: P2)

Any single consumer can be down for a while. Meanwhile the rest of the chain keeps working, the lag is visible, and when the consumer returns it applies each fact once.

**Why this priority**: independent deployment of the consumers is the point of the event design.

**Independent Test**: pause one consumer group, run the purchase, resume, compare with the clean run.

**Acceptance Scenarios**:

1. **AS-27** (settlement consumer down) — **Given** group `ledger-settlement` paused (`state: PAUSED`), **When** a purchase runs to `PAID`, **Then** the order is `PAID` and the buyer is notified within their contracts, the seller balance does **not** show the credit, `GET /admin/consumers/ledger-settlement` shows `lag ≥ 1`; **When** it is resumed, **Then** within H4 the balance shows the credit **once** and `lag` is `0`; a payout run started while the consumer was down pays only what had been settled, never a guess.
2. **AS-28** (notification and statements consumers down) — **Given** `notification-router` paused, **When** a purchase runs to `PAID`, **Then** the orders and balances are right and the inboxes are empty; **When** resumed, **Then** each inbox holds exactly one item (AS-08). **Given** `statements-facts` paused, **Then** the live statement's `dataAsOf` stays behind the sale and a close of an ended month answers `409 period_not_ready` naming the stream; **When** resumed, **Then** the close succeeds and the statement includes the sale.

---

### User Story 9 — Operators and engineers can see progress, and the boundaries hold (Priority: P3)

**Acceptance Scenarios**:

1. **AS-29** (the UI journey, happy path only) — **Given** a signed-in buyer and a seller owner, **When** the buyer checks out and pays in the web app, and the seller opens the dashboard, **Then** the buyer sees the order become paid without reloading, the seller sees the balance, then the paid payout, then the statement line (web capabilities W03 and W04 own the screens; this scenario is one Playwright test, auto-waiting, no sleeps).
2. **AS-30** (every hop is observable) — **Given** the whole journey ran, **When** the metrics endpoint is read, **Then** counters exist and moved for: orders paid, payments succeeded, settlements posted, payouts paid, statement periods closed, notifications created; every consumer group of the journey reports `lag: 0`; every log line of the journey carries a `requestId` or `traceId` and the journey's `orderId` where one applies; no secret, token or card data appears.
3. **AS-31** (approved paths only) — **Given** the repository, **Then** the static gates pass: `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` for the domains `orders`, `payments`, `statements`, `notifications`, `check:module-graph` (every process boots), and payments does not import orders (D-11: the `orders → payments` call is the only synchronous edge; `payments → orders` is events only).

### Edge Cases

- A provider answer or webhook for an order that is `CANCELLED` or past its hold: refund saga (AS-18), never a paid order.
- `order.paid` consumed before the sale journal exists: the settlement waits and retries, never credits the shops without the money (proven in S14, referenced; reproduced here only through AS-27's pause).
- A payout run while settlement lags: pays only the authoritative balance (AS-27).
- The clock moves during the journey: the journey owns the clock for its whole run and restores it at the end; sessions are re-created after each move (tokens may expire).
- Two journeys on one stack: separate users and shops; the clock and consumer pause are global, so journey files run serially (`maxWorkers: 1`) and always resume consumers and reset the clock in `afterAll`, even on failure.
- An order whose shops have different currencies: refused at checkout (S10), not a journey concern.
- A shop that is not verified or has no destination: no payout, balance kept (S15 AS-09, referenced).

## Requirements *(mandatory)*

### Functional Requirements

**The chain**

- **FR-001**: Checkout MUST return `202` and an order `RESERVED` that holds the stock; the order MUST emit `order.reserved` through the outbox in the same transaction as the order (AS-01).
- **FR-002**: Payments MUST accept an intent only through `POST /payments/intents`, using its own copy of the order built from order events (not a synchronous call into orders); a missing copy is `404 order_not_found` after at most 2 s of waiting, and the same key retried later is processed afresh (AS-01, AS-04).
- **FR-003**: Payment success MUST post the sale journal in the payment's own transaction through the ledger's exported service, and outbox `payments.payment_succeeded` and `ledger.journal_posted` in that transaction (AS-05).
- **FR-004**: An order MUST become `PAID` only when payments reports the payment `COMPLETED`, whether the signal came from `payments.payment_succeeded` or from the provider's webhook; it MUST become `PAID` exactly once (version +1, one `order.paid`) when both arrive, in any order or at once (AS-01 to AS-03).
- **FR-005**: `order.paid` MUST carry what its consumers need and nothing they would have to query: order id and version, buyer id, total and currency, payment reference, `paidAt`, lines (with `lineId`, `shopId`, `category`, title, quantity, unit price, discount, line total) and the shop split (AS-05, AS-08, AS-13).
- **FR-006**: The ledger MUST credit each shop its share of the sale net of the commission that statements reports for that shop and category, and the platform its commission, so that the ledger credit equals the statement net (AS-05, AS-07, AS-15).
- **FR-007**: Settlement MUST NOT credit shops before the sale journal exists and MUST NOT credit them for a refunded payment (AS-27, AS-18).
- **FR-008**: The seller's balance read MUST be fast and correct, and report how fresh it is (`asOf`) (AS-05).
- **FR-009**: The payout run MUST read the authoritative balance, skip ineligible shops without moving money, create at most one payout per shop and week, and send each payout once (AS-20 to AS-22).
- **FR-010**: A rejected transfer MUST reverse the payout in the books and notify the owner; an unanswered transfer MUST NOT be re-sent blindly (AS-23; S15 AS-17 to AS-20 referenced).
- **FR-011**: Statements MUST build from event facts (orders, ledger, payouts), expose a watermark (`dataAsOf`), refuse to close a month whose facts are incomplete, and freeze closed months (AS-13, AS-14, AS-28).
- **FR-012**: Notifications MUST be created from events: the buyer on `order.paid` and `payments.payment_failed`, each shop's owners on `order.paid`, the owners on `payout.paid` and `payout.failed`; no other recipient (AS-08 to AS-10).

**Failure modes**

- **FR-013**: Every consumer in the chain MUST be idempotent (inbox, unique key on the event id, or version-guarded upsert), MUST validate its payload, and MUST dead-letter poison messages without blocking (constitution IV.5) (AS-24, AS-25).
- **FR-014**: Events for one aggregate MUST be keyed by the aggregate id, and consumers MUST discard an event whose version is lower than the one already applied (AS-25, AS-26).
- **FR-015**: Declined payments, hold expiry and a cancel during the charge MUST each end with the order cancelled, the stock restored exactly once, no seller credited and the buyer's money returned (AS-17 to AS-19).
- **FR-016**: A payment completed for an order that is no longer payable MUST be refunded automatically through the `orders.refund_requested` task (AS-18).
- **FR-017**: Every request that creates something (`checkout`, `payments/intents`, operator writes) MUST be safe to retry with its key; a retry changes nothing and returns the original answer (AS-24).

**Observability and control (journey support)**

- **FR-018**: Every hop in the contract table MUST meet its maximum time on the local stack and be observable through the API named in the table (all scenarios).
- **FR-019**: A consumer's state and lag MUST be readable and pausable, resumable and replayable by an operator through an admin API (AS-04, AS-25, AS-27, AS-28).
- **FR-020**: An operator MUST be able to run an allow-listed job on demand and read its outcome (AS-20, AS-14).
- **FR-021**: The local stack MUST offer a controllable clock, available only when explicitly enabled by configuration and refused in production (AS-14, AS-19, AS-20).
- **FR-022**: The local stack MUST run with provider doubles that answer by the identifiers listed in the notation, and MUST run every process the chain needs (core, worker, projector, payment processor, realtime gateway) in the single local deployment.
- **FR-023**: The journey MUST drive and observe only through public APIs and the control surface; it MUST resume paused consumers and reset the clock even when it fails.

**Safety**

- **FR-024**: A user MUST see only their own orders, payments and notifications; a shop member only their own shop's balance, payouts and statements (`404` for another shop, `403` for a role without the permission), through every read of the chain (proven per capability; spot-checked in AS-05).
- **FR-025**: Events and logs MUST NOT carry payout destinations, card data, secrets, or the buyer's identity beyond what a consumer needs (statements store no buyer id).

### Key Entities

- **Order / shop order**: the buyer's purchase and its per-shop parts; status `RESERVED → PAID` (or `CANCELLED`).
- **Payment**: one per order; `PENDING → COMPLETED | FAILED | REFUNDED`.
- **Order copy**: payments' own record of an order's facts, kept from order events.
- **Journal**: a balanced, immutable set of ledger lines (sale, settlement, refund, payout, payout reversal).
- **Balance**: what a shop is owed now, read from a read model with an `asOf`.
- **Payout**: a shop's weekly transfer, with a reserve held back.
- **Statement fact / statement / period**: sale, ledger and payout facts, the live statement, and the frozen snapshot of a month.
- **Notification**: an inbox item per recipient and event.
- **Consumer group**: a named subscription of one domain to one or more topics, with state and lag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the buyer's payment to the order showing paid: at most 5 seconds on the local stack in 99% of runs; the buyer sees it without reloading.
- **SC-002**: From the order being paid to both sellers' balances showing their credit: at most 10 seconds; the sum of the two credits plus the platform's commission equals the order total to the cent in 100% of runs.
- **SC-003**: Under any retry or replay pattern of the journey (same key five times at once, webhook ten times at once, topics replayed), exactly 1 order, 1 payment, 1 credit per seller, 1 payout per shop and week, and 1 notice per recipient and fact exist: 0 duplicates in 100% of runs.
- **SC-004**: With any one consumer paused during a purchase and resumed afterwards, 0 facts are lost and 0 are applied twice; the lag returns to 0 within 15 seconds of resuming.
- **SC-005**: Every failure path (declined, expired, cancelled in flight, rejected transfer) leaves the books, stock and balances exactly as if the purchase or payout had not happened (apart from the refund and reversal records), in 100% of runs.
- **SC-006**: A seller's statement for the month equals the ledger credits and the paid payouts for it with 0 differences, before and after the close.
- **SC-007**: The journey runs from a clean local stack to green in under 10 minutes, with 0 fixed sleeps.

## Assumptions

- Every default below is also a line in `questions.md`; those that change an existing contract are tagged `[BREAKING]` there.
- **Payments start over HTTP** (`POST /payments/intents`), not through a message from an external gateway; the local deployment runs the payment processor and the realtime gateway too.
- **Payments never calls orders** (it keeps an order copy from events; S13 wins over S10's mention of a payable-order call); orders calls payments only to confirm a payment's status. This keeps D-11's cycle out of the runtime path.
- **The commission is decided at settlement** from the commission rates that statements exposes, so the ledger and statements agree; the sale journal books the full captured amount to clearing.
- **Eventual-consistency numbers** are those of the hop table; they are the contract of the owners and the deadlines of the tests (×2).
- **Jobs and time are driven through the control surface**: no test waits for Monday 06:00 or the 2nd of the month; the clock is advanced and jobs are run on demand. The control surface exists only in the local/test profile (config-validated; refused in production), except consumer pause/resume/replay, which are operator tools behind the admin role and a sensitive session.
- **Fixtures**: shops with payouts enabled are made verified through S04's public onboarding and admin decision routes using the document-extractor test double (J02 proves onboarding itself); destinations are set through S15's operator route.
- **Notified recipients**: buyer on paid and on failed payment; shop owners (not staff) on a sale and on payout paid or failed. No "statement ready" notice in this release. E-mail delivery itself is proven in S28; this journey asserts the inbox and the realtime event.
- **One currency** (`EUR`); the amounts of the notation are illustrative, the assertions are relational (sums, equalities) wherever a rate or minimum is configurable.
- A journey owns the stack clock while it runs; journeys run serially.

## Cross-capability contracts

Searched before writing: `grep -rl` over `specs/domains specs/web specs/journeys` for `J01` and `journeys`. Contracts the earlier specs require from this journey, and how they are honoured:

- **S10** (test plan): "a switch of the payments fake to the real module is part of J01" (honoured: AS-01 runs against the real S13).
- **S14** (AS-32 and `spec.md:33`): one step of the UI journey (seller balance card after settlement), and the API chain order paid → sale → settlement → balance (honoured: AS-05, AS-29). S14 names the UI file `packages/web/e2e`; S15 and S16 name `packages/web/tests/buy-to-payout.spec.ts`; this spec adopts the latter (see `questions.md`, `[CONTRACT]`).
- **S15** (AS-37, `questions.md:38`): J01 proves order paid → settlement → payout `PAID` → statement and the payouts page; consumes `payout.paid`/`payout.failed` on `payouts.events` (honoured: AS-20, AS-23, AS-29).
- **S16** (AS-28, `test-plan.md:54`): J01 owns the "monthly-statement step" and the statements tab with W04 (honoured: AS-13 to AS-15, AS-29).
- **S28**: notices on `order.paid`, `payments.payment_failed`, `payout.paid`, `payout.failed` (honoured: AS-08 to AS-10). **Differs**: S28 lists `order.confirmed` for the buyer and `shop.order_received` for owners; this spec names both as the observable types.
- **S43, S11, W03, W04**: only name J01 as a consumer or owner of a UI journey; nothing required of this spec beyond the above.

**Provides** (J01 has no runtime exports; it provides a test, a fixture kit and a timing contract that other capabilities must meet):

- `packages/backend/test/journeys/buy-to-payout.journey-spec.ts` (top-level `describe` "Journey J01: buy to payout") and `packages/web/tests/buy-to-payout.spec.ts` (AS-29).
- `packages/backend/test/journeys/support/` — `JourneyClient` (typed, contract-schema-parsing calls to the public API), `waitForContract(hop, probe)` (polling with the hop's deadline, built on `test/utils/async-helpers.ts` `waitFor`), `sellerFixture` (user, shop, verification, product, destination), `controlSurface` (jobs, consumers, clock; always restores in `afterAll`).
- **The hop table** under "Eventual-consistency contract": H1–H13 with maximum times; owners listed there must not exceed them.

**Requires** (owner and exact shape assumed):

- **S10 (orders)**: `POST /checkout` (`Idempotency-Key`) → `202 {orderId, status, totalMinor, currency, reservedUntil}`; `GET /orders/:orderId` → `orderSchema` with `shopOrders[]`, `timeline[]`; `POST /orders/:orderId/cancel`; `POST /webhooks/stripe`; `GET /api/streams?topics=user:<id>` event `order.status {orderId, status, orderVersion}`; events on `orders.events` keyed `orderId`: `order.reserved`, `order.paid {orderId, userId, totalMinor, currency, paymentRef, paidAt, lines: [{lineId, productId, shopId, category, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}` (**additions asked: `lineId`, `category`, per S16**), `order.cancelled`; consumer group **`orders-payment-results`** on `payments.events`; the SQS task `orders.refund_requested`; jobs `orders.expire-reservation`, `orders.process-webhook`; it calls only `PaymentQueryService.getPaymentStatus(paymentRef)` (R1) in payments.
- **S13 (payments)**: `POST /payments/intents`, `GET /payments/:paymentId`, `GET /payments?orderId=`; SSE `payment.status`; events on `payments.events` keyed `paymentId`: `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded`; consumer group **`payments-order-copy`** on `orders.events`; consumer of `orders.refund_requested`; the sale journal posted in its transaction through S14's `recordPaymentCaptured`; provider double by `paymentMethodId`; `PaymentQueryService.getPaymentStatus`; no import of orders.
- **S14 (ledger)**: consumer group **`ledger-settlement`** on `orders.events` (`order.paid`); consumer group **`ledger-balances`** on `ledger.events`; `GET /shops/:shopId/balance?currency=EUR` → `{shopId, currency, availableMinor, asOf, source}`; `ledger.journal_posted` v2; **settlement books the commission from `CommissionRateQueryService.getRatesAsOf` (S16)** and the sale journal books the full captured amount to clearing.
- **S15 (payouts)**: `GET /shops/:shopId/payouts`, `…/payouts/:payoutId`, `…/payouts/upcoming`; `PUT /finance/shops/:shopId/payout-destination`; job `payouts.run-weekly {periodStart?}` and `payouts.send {payoutId}`; events `payout.created|paid|failed` on `payouts.events` keyed `payoutId`; transfer provider double by `providerAccountId`.
- **S16 (statements)**: consumer group **`statements-facts`** on `orders.events`, `payouts.events`, `ledger.events`; `GET /shops/:shopId/statements/:month` (with `dataAsOf`, `own.{grossMinor,commissionMinor,netMinor,lineCount,payoutsPaidMinor}`); `POST /admin/accounting-periods/:month/close`, `GET /admin/accounting-periods/:month` and `…/findings`; `GET /admin/commission-rates/as-of`; `statements.period_closed` on `statements.events`; error `409 period_not_ready {stream, watermark}`.
- **S28 (notifications)**: consumer group **`notification-router`** on `orders.events`, `payments.events`, `payouts.events`; inbox types `order.confirmed`, `shop.order_received`, `payment.failed`, `payout.paid`, `payout.failed`; `GET /notifications`, `/notifications/unread-count`; realtime `notification`.
- **S03 / S04 / S05 / S01**: shop creation, member roles (owner, staff), verification route usable with the extractor double; product creation with stock and a stock read for a shop member; sign-up/sign-in; admin role.
- **S49 (jobs) with S01 (admin routes)**: `POST /api/admin/jobs {type, payload?, idempotencyKey}` → `202 {jobId}` for allow-listed types (`payouts.run-weekly`, `statements.close-month`, `payments.reconcile-daily`); `GET /api/admin/jobs/:jobId` → `{id, type, status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD", attempts, finishedAt}`.
- **S53 (events)**: `GET /api/admin/consumers/:group` → `{group, topics, state: "RUNNING" | "PAUSED", lag, lastProcessedAt}`; `POST /api/admin/consumers/:group/pause | resume`; `POST /api/admin/consumers/:group/replay {since: ISO}` → `202`; topics created explicitly (`orders.events`, `payments.events`, `ledger.events`, `payouts.events`, `statements.events`); the outbox relay publishing the same envelope in every mode.
- **S54 (platform toolkit)**: `GET|PUT /api/admin/clock` (`{now, mode: "real" | "offset"}`; `PUT {advanceSeconds}` forward only, `PUT {mode: "real"}` resets), a clock shared by all processes of the stack, enabled only by `CLOCK_CONTROL=enabled` and refused at startup in production.
- **S51 (realtime)**: `GET /api/streams?topics=user:<id>` with `order.status`, `payment.status`, `notification`.
- **W03 / W04**: the checkout/payment screens, balance card, payouts page and statements tab for AS-29.
