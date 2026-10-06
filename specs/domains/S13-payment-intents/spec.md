# Feature Specification: S13 — Payment Intents, Idempotency, Unknown Outcomes, PSP Circuit Breaker, Outbox, Saga with Orders (domain `payments`)

**Feature Branch**: `S13-payment-intents` (spec directory `specs/domains/S13-payment-intents`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders (domain `payments`)". Sources: `README.md` (Interview-Prep), `docs/showcase/sections/SD-20-payments-ledger-reconciliation.md`, note 10-System-Design/07 §19 (payment flow, saga) and §20 (exactly-once effect, unknown outcomes), note 06-Distributed-Systems/03 §1–§3 (timeouts, retries, circuit breaker), constitution v3.1.0, `docs/architecture/domain-map.md` (`payments`), `docs/architecture/pattern-map.md` (rows naming S13: P0311, P0407, P0414, P0611, P0617), the written specs S10, S11 and S05 (contracts they require from this capability).

## Scope

A buyer who has a reserved order pays for it. The platform records one payment for that order, asks the payment provider (the PSP) to charge it, and tells the buyer and the order system the result. The provider can be slow, down, or silent after a request; the platform must never charge twice, never lose a charge, and never take the rest of the platform down with the provider.

In scope:

- **Payment intent**: one authenticated request, safe to retry (`Idempotency-Key`), that records one payment per order. Amount and currency come from the order, never from the client. The answer is `202 Accepted`; the charge happens asynchronously and the buyer follows the status by reading it or by push.
- **Charge processing**: an asynchronous processor charges the provider once, with the order as the provider-side idempotency reference, classifies every provider answer (success, definite decline, customer action required, rejected, unknown), and applies it through a guarded state machine.
- **Unknown outcomes**: when the provider does not answer in time, the payment becomes `UNKNOWN`. It is settled by asking the provider about our reference with backoff, never by sending the charge again.
- **PSP circuit breaker**: per provider operation, with timeouts, one retry layer, fail-fast, half-open probing, and degradation to "accepted, charged later".
- **Concurrency**: every status change is a guarded, versioned, recorded step (optimistic concurrency); competing resolvers produce exactly one effect.
- **Outbox and events**: every payment result leaves through the transactional outbox as a typed event; the payment, its ledger posting and its event commit together or not at all.
- **Saga with orders**: payments keeps its own copy of the order facts it needs (from order events), reacts to order cancellation, executes refund commands from orders (late payments, cancel races), and publishes results that orders consumes. All steps are idempotent and tolerate duplicate and out-of-order messages.
- **Reads**: the buyer's payment status, own payment list, a push event, and the exported status service that orders uses.

Out of scope (owners named):

- Double-entry ledger internals, balanced journals, balances, reconciliation against the provider's statements → **S14**. This capability only asks the ledger to post the sale and its reversal in its own transaction (see Cross-capability contracts).
- Seller payouts and transfers keyed by payout ID → **S15**. Statements → **S16**.
- Cart, checkout, reservation, order state machine, the provider's signed webhook endpoint and its inbox → **S10**. This capability never receives provider webhooks; orders does, and asks this capability for the payment's status.
- Realtime hub → **S51**. Outbox, consumers, queues → **S53**. Jobs and scheduling → **S49**. Rate limiter → **S50**. Platform toolkit (problem+json, idempotency facility, clock, config, metrics, shutdown) → **S54**. Authentication → **S01**.
- Screens (the pay step, 3-D Secure frame, payment history) → **W03**; composition with orders for a screen → **S48** (IX.7 R2).
- Subscription billing charges (billing is a separate capability that sends a charge command) and any card data handling: card numbers never reach the platform (the provider's hosted fields produce a token).
- Provider-initiated changes the platform did not ask for (a refund made in the provider's dashboard, a dispute): detected by reconciliation (**S14**), not here.
- A direct operator refund endpoint: none here; refunds are executed from the order system's refund command.

Cross-domain data used (IX.7): order facts come from an **R3** copy fed by S10's order events; S10 reads payment status through an **R1** exported service; screens that show an order with its payment use **R2** composition. Nothing else crosses the boundary.

## User Scenarios & Testing *(mandatory)*

Notation: `U` and `V` are buyers; `O` is an order reserved by `U` for `2500` minor units EUR (25.00 EUR) until `T+15 min`; `pi_1` is the provider's reference for the charge; amounts are integer minor units. "The order copy" is this capability's own record of an order's facts, kept from S10's events (IX.7 R3). "The provider" is a test double at the system edge. "Time is frozen" means tests control the clock. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. Request bodies reject unknown properties.

### User Story 1 — A buyer pays for a reserved order exactly once, however often the request is repeated (Priority: P1)

A buyer presses "Pay" on a flaky connection. The browser retries, the buyer double-clicks, two tabs fire. Exactly one payment exists for the order, the price comes from the order, and the answer says "accepted, payment pending".

**Why this priority**: charging twice is the failure that costs money and trust; everything else builds on this.

**Independent Test**: reserved orders exist as order copies; fire the request sequentially, simultaneously and with different keys; count payments, charge commands and provider calls.

**Acceptance Scenarios**:

1. **AS-01** (accepted, full effect) — **Given** buyer `U`, the order copy of `O` `{RESERVED, totalMinor: 2500, currency: "EUR", reservedUntil: T+15 min}` and time `T+1 min`, **When** `POST /payments/intents` with `Idempotency-Key: k-pay-0001` and body `{orderId: O, paymentMethodId: "pm_test_visa"}`, **Then** `202` with `Location: /api/payments/<paymentId>` and `{paymentId, orderId: O, status: "PENDING", amountMinor: 2500, currency: "EUR", createdAt}` parsed by `paymentAcceptedSchema`; and exactly: one payment (`PENDING`, version 1, owner `U`, amount 2500 EUR, no provider reference), one history row (`∅ → PENDING`), one charge command in the outbox, one completed idempotency record; the provider was not called during the request.
2. **AS-02** (amount and currency come from the order; input is strict) — **Given** the same order, **When** the body contains `amountMinor`, `currency`, `userId` or any card field (`cardNumber`, `cvc`, `exp`) or any other unknown property, **Then** `400 validation_failed` naming the property and nothing is created; **When** `orderId` is not a UUID, or `paymentMethodId` is missing, empty, not a string or longer than 255 characters, **Then** `400 validation_failed` with the field; no payment, no outbox row, no provider call.
3. **AS-03** (replay) — **Given** AS-01 completed and the payment has since become `COMPLETED`, **When** the same key and the same body are sent again, **Then** `202` with the original body byte for byte (status `PENDING` as then) and `Idempotency-Replayed: true`; no new payment, history row, command or provider call.
4. **AS-04** (in flight) — **Given** a first request paused after the order check (a test gate), **When** a second request with the same key and body arrives, **Then** `409 idempotency_in_flight` with `Retry-After: 1`; **When** the gate opens and the first finishes, **Then** a third attempt replays the `202`; one payment exists.
5. **AS-05** (concurrent duplicates) — **Given** an order and key `K`, **When** five identical requests run at once (`Promise.all`), **Then** every response is `202` with the same `paymentId` or `409 idempotency_in_flight`, at least one is `202`, exactly one payment and one charge command exist, and after processing the provider's create call ran once.
6. **AS-06** (one payment per order) — **Given** an order without a payment, **When** two requests with different keys run at once (`Promise.all`, repeated 50 times), **Then** exactly one answers `202` and the other `409 payment_already_exists` with `existingPaymentId`; exactly one payment exists per run; **When** a third request with yet another key arrives later, **Then** `409 payment_already_exists` again, whatever the payment's status (a failed payment cancels the order in S10, so a new attempt needs a new order).
7. **AS-07** (key misuse) — **Given** key `K` used with body `{orderId: O, paymentMethodId: "pm_a"}`, **When** it is reused with `{orderId: O, paymentMethodId: "pm_b"}`, **Then** `422 idempotency_key_reuse` and nothing changes; **When** the header is missing, **Then** `422 idempotency_key_required`; **When** the key is `short` (5 characters), 129 characters long or contains a space, **Then** `422 idempotency_key_invalid`; a key is 8–128 characters of `[A-Za-z0-9_-]`.
8. **AS-08** (keys are per buyer) — **Given** buyer `U` used key `K` for `O`, **When** buyer `V` uses the same `K` for her own order, **Then** `V` gets her own new payment (`202`), not `U`'s answer.
9. **AS-09** (what a key remembers) — **Given** a request that failed before any payment existed (`order_not_payable`, `order_not_found`, `400`, `422`, `429`, `503`), **When** the cause is fixed and the same key is sent again, **Then** it is processed afresh (`202`); **Given** a `5xx` answer, **Then** the key is released; a `202` is remembered for 24 hours and is final for that key.
10. **AS-10** (access) — **Given** no credentials, **Then** `401`; **Given** only a guest cookie, **Then** `401`; **Given** an order reserved by buyer `V`, **When** `U` posts its `orderId`, **Then** `404 order_not_found` with a body identical to the answer for an order ID that does not exist (apart from `instance` and `requestId`); no payment, no outbox row, no provider call.
11. **AS-11** (only payable orders) — **Given** order copies in the statuses `CANCELLED`, `PAID` and `RESERVED` with `reservedUntil <= now`, **When** `U` posts each, **Then** `409 order_not_payable` with `reason` `order_cancelled`, `order_paid` and `hold_expired`; at exactly `now == reservedUntil` the hold counts as expired; nothing is created.
12. **AS-12** (the order copy lags behind) — **Given** `O` was just reserved and its event is not yet consumed, **When** `U` posts it and the event arrives within 2 s, **Then** `202`; **When** it does not arrive within 2 s, **Then** `404 order_not_found` (the same answer as for a foreign order, AS-10).
13. **AS-13** (limits, pure) — **Given** order totals, **Then** `amountMinor` must be an integer from 1 to 99,999,999: `0` and `100,000,000` answer `422 amount_out_of_range`, `1` and `99,999,999` are accepted; **Given** currencies, **Then** only `EUR`, `USD` and `GBP` (two-decimal currencies) are accepted and any other (`JPY`, `BHD`) answers `422 currency_unsupported`; nothing is created in the refused cases.
14. **AS-14** (rate limit) — **Given** a buyer who made 10 payment requests in the last minute (any outcome), **When** the 11th arrives, **Then** `429 rate_limited` with `Retry-After` and no payment is created; **Given** the limiter's store is down (forced), **Then** the request is refused the same way (fail closed).

### User Story 2 — The charge happens in the background and every outcome is applied correctly (Priority: P1)

After "accepted", a processor charges the provider once and records what happened: paid, declined, or waiting for the customer (3-D Secure). The buyer sees the result by reading the payment or by push.

**Why this priority**: this is the money movement and the signal everything else reacts to.

**Independent Test**: accepted payments exist; run the processor with a provider double that answers in each way; assert state, ledger, events and provider calls.

**Acceptance Scenarios**:

1. **AS-15** (success, full effect) — **Given** the payment of AS-01 and a provider that answers "succeeded" with reference `pi_1`, amount 2500, currency EUR, **When** the processor handles the charge command, **Then** the provider's create call ran exactly once with the idempotency reference `O` and metadata `{orderId: O, paymentId}`, amount 2500 and currency `eur`; and exactly: the payment is `COMPLETED` (version 2, provider reference `pi_1`), history `PENDING → COMPLETED`, one balanced ledger journal for the payment (posted by the ledger capability inside the same transaction), one outbox event `payments.payment_succeeded {paymentId, paymentRef: "pi_1", orderId: O, userId: U, amountMinor: 2500, currency: "EUR", occurredAt, paymentVersion: 2}`, one realtime push `payment.status COMPLETED` to `U`, and `GET /payments/<id>` answers `COMPLETED`.
2. **AS-16** (definite decline) — **Given** the provider answers "card declined", **When** processed, **Then** the payment is `FAILED` with `failureCode: "card_declined"` (history `PENDING → FAILED`), no ledger entries, one `payments.payment_failed {…, reasonCode: "card_declined"}`; the payment is not `UNKNOWN`, the charge is not retried, and the breaker's failure count does not change.
3. **AS-17** (customer action required) — **Given** the provider answers "requires customer action" with reference `pi_1`, **When** processed, **Then** the payment stays `PENDING` with `requiresAction: true` and provider reference `pi_1`, version unchanged, no ledger entry, no outbox event; the owner's `GET /payments/<id>` returns a `clientSecret`; another buyer's read answers `404` (AS-57); the list never contains `clientSecret`; **When** the customer completes the action and the status is refreshed (AS-56), **Then** the payment is `COMPLETED` and `clientSecret` is `null`.
4. **AS-18** (provider rejects the request) — **Given** the provider answers `400 invalid_request` or `401`, **When** processed, **Then** the payment is `FAILED` with `failureCode: "provider_rejected"`, an error is logged with the provider's request ID (no secrets), `payments_provider_calls_total{operation="create_intent", outcome="rejected"}` increments, the breaker's failure count does not change, and one `payment_failed` event exists.
5. **AS-19** (order no longer payable when the charge starts) — **Given** an accepted payment whose order copy became `CANCELLED` before the processor picked it up, **When** processed, **Then** the payment is `CANCELLED` with `failureCode: "order_not_payable"`, the provider spy has 0 calls, one `payments.payment_failed {reasonCode: "order_not_payable"}` is emitted, and the order copy is unchanged.
6. **AS-20** (the charge command is delivered twice, or is invalid) — **Given** a charge command delivered twice one after the other and then twice at once, **Then** the provider's create call ran once, one transition and one event exist; **Given** a command with a missing `paymentId`, a non-UUID `paymentId`, a negative `attempt` or an unknown type, **Then** it is dead-lettered without effect and the next message is processed.
7. **AS-21** (reading never changes anything) — **Given** the payment of AS-15, **When** `GET /payments/<id>` is called 20 times, **Then** it returns `paymentSchema` `{id, orderId, status, amountMinor, currency, failureCode, requiresAction, clientSecret, version, createdAt, updatedAt}` every time, and version, history, outbox and provider calls are unchanged.
8. **AS-22** (the provider's answer is validated before use) — **Given** the provider answers "succeeded" with amount 2400, a currency other than the payment's, a missing status, or metadata whose `orderId` is not `O`, **When** processed, **Then** the payment is not completed: it becomes `UNKNOWN` with reason `provider_response_invalid`, no ledger entry, no event, an error is logged, and `payments_provider_mismatch_total{field}` increments (`amount`, `currency`, `status` or `order`); a later settlement attempt that sees the same mismatch leaves it `UNKNOWN` and alerts (S14's reconciliation resolves it).

### User Story 3 — A silent provider never causes a second charge or a lost one (Priority: P1)

The provider times out after we asked it to charge. The charge may or may not exist. The platform marks the payment `UNKNOWN`, asks the provider what happened to our reference, and applies the answer. It never sends the charge again.

**Why this priority**: blind retries double-charge; giving up loses money. Note 10/07 §20: "mark UNKNOWN, query the provider's status by reference with backoff; never blindly resend".

**Independent Test**: a provider double that times out on create; later answers lookups in each possible way; count create calls.

**Acceptance Scenarios**:

1. **AS-23** (timeout → UNKNOWN) — **Given** an accepted payment and a provider whose create call does not answer within the 8 s limit (forced), **When** processed, **Then** the payment is `UNKNOWN` (history `PENDING → UNKNOWN`, reason `provider_timeout`, version 2), no ledger entry, no event to orders, `payments_unknown_outcomes_total` increments, the first resolution is scheduled for `+30 s`, the charge command is acknowledged (not redelivered for re-sending), and the provider's create call ran exactly once in total, including after redeliveries and restarts of the processor.
2. **AS-24** (the provider has the charge) — **Given** the `UNKNOWN` payment, **When** the resolution runs and the provider's lookup by our reference (`orderId` metadata) returns an intent `pi_1` that succeeded, **Then** the payment becomes `COMPLETED` with provider reference `pi_1` through the same guarded step as AS-15 (one ledger journal, one `payment_succeeded`, one push), and the provider's create call count is still 1.
3. **AS-25** (the provider has a failed or canceled intent) — **Given** the lookup returns an intent that is canceled or still needs a payment method (a failed attempt), **When** resolved, **Then** the payment becomes `FAILED` with the intent's decline code (or `provider_canceled`), one `payment_failed`, and no create call was made.
4. **AS-26** (the provider has no record, boundary at 60 minutes) — **Given** the `UNKNOWN` payment whose charge attempt began at `T0` and a lookup that finds nothing, **When** the resolution runs at `T0 + 59 min 59 s`, **Then** the payment stays `UNKNOWN` and the next check is scheduled; **When** it runs at `T0 + 60 min`, **Then** the payment is `FAILED` with `failureCode: "no_provider_record"`, one `payment_failed`, still 1 create call in total.
5. **AS-27** (the provider is unreachable while resolving) — **Given** an `UNKNOWN` payment, **When** the lookup times out, fails, or its breaker is open, **Then** the payment stays `UNKNOWN` (never `FAILED` because the provider was unreachable) and the next check is scheduled after a delay drawn uniformly from `[0, min(15 min, 30 s × 2^n)]` (full jitter, `n` = checks so far); **When** the payment has been `UNKNOWN` for more than 24 hours, **Then** a warning is logged once per hour, the gauge `payments_unknown_oldest_age_seconds` exceeds 86,400, and the payment is still `UNKNOWN`.
6. **AS-28** (the lookup shows the customer has not finished) — **Given** an `UNKNOWN` payment and a lookup that returns an intent waiting for customer action, **When** resolved, **Then** the payment becomes `PENDING` with `requiresAction: true` and provider reference `pi_1` (history `UNKNOWN → PENDING`).
7. **AS-29** (a lost resolution job) — **Given** an `UNKNOWN` payment whose scheduled resolution was lost (forced), **When** the periodic sweep runs (every 60 s), **Then** the payment is resolved no later than 2 minutes after it was due; **Given** two workers running the sweep at once, **Then** each payment is looked up and resolved once (single run).
8. **AS-30** (a crash between the provider's answer and our record) — **Given** the processor started a charge (the attempt is recorded) and stopped before the answer was applied (forced crash), **When** the command is redelivered, **Then** the processor does not call the provider's create again: the payment becomes `UNKNOWN` with reason `crash_recovery` and is settled by lookup (AS-24 to AS-26); **Given** the crash happened before the attempt was recorded, **Then** the redelivery charges normally and the create call runs once.

### User Story 4 — A provider outage degrades payments but not the platform (Priority: P1)

The provider starts failing. After a few failures the platform stops calling it, keeps accepting payment requests, charges later when it recovers, and gives up cleanly when the order's hold is over.

**Why this priority**: note 06/03 §3, pattern P0617. A hung dependency must not hold sockets, connections and workers.

**Independent Test**: a provider double that fails or hangs on demand and a controllable clock; assert breaker state, calls, payment states, answers of the HTTP endpoints and metrics.

**Acceptance Scenarios**:

1. **AS-31** (the breaker opens) — **Given** the breaker of the operation `create_intent` (rolling window 10 s, opens when at least 50% of at least 10 calls fail), **When** 10 of 10 charge calls fail with `503` within the window, **Then** those 10 payments are `UNKNOWN` (a `5xx` may have been processed), the breaker is open, `circuit_breaker_open{breaker="create_intent"}` is `1`; **When** the 11th charge is processed, **Then** the provider spy has no new call, the payment stays `PENDING` (not `UNKNOWN`, because nothing was sent), a retry is scheduled (AS-34), and the HTTP create still answers `202`.
2. **AS-32** (half-open and recovery) — **Given** an open breaker, **When** the clock moves 30 s, **Then** exactly one probe call is allowed and calls made at the same time are refused without reaching the provider; **When** the probe succeeds, **Then** the breaker closes and the gauge is `0`; **When** the probe fails, **Then** it opens again for another 30 s.
3. **AS-33** (declines do not trip the breaker) — **Given** 50 consecutive definite card declines, **Then** the breaker stays closed and the provider keeps being called; only timeouts, connection errors, `5xx`, `429` and calls slower than 5 s count as failures; **Given** 10 successful calls each taking 6 s, **Then** the breaker opens (slow calls count).
4. **AS-34** (charge retry when nothing was sent, and its deadline) — **Given** a `PENDING` payment whose charge was refused by an open breaker, **When** the provider recovers before the 3rd attempt, **Then** the charge runs on that attempt, the payment is `COMPLETED` and the create call ran once; attempts are spaced by delays drawn uniformly from `[0, min(60 s, 2 s × 2^n)]`; **Given** the outage lasts for 6 attempts or 10 minutes after the payment was created, whichever is first, **Then** the payment is `FAILED` with `failureCode: "provider_unavailable"` (definitely never charged: provider create calls = 0), one `payment_failed`.
5. **AS-35** (one retry layer) — **Given** a charge under outage, **Then** the provider client makes no network retries of its own (calls with retry count 0) and the charge is attempted at most 6 times in total.
6. **AS-36** (timeouts and no waiting inside a transaction) — **Given** the provider never answers, **Then** create and refund calls end at 8 s, lookups and cancellations at 4 s and status refreshes at 2 s; **While** a create call is hung, **Then** `GET /payments/<id>` and `POST /payments/intents` for other orders still answer within 300 ms (no database transaction or row lock is held during a provider call).
7. **AS-37** (the HTTP surface does not depend on the provider) — **Given** the provider is down and all breakers are open, **Then** `POST /payments/intents` answers `202` and `GET /payments/<id>` answers from stored data, both within 300 ms; readiness stays "ready" (an open breaker is not a readiness failure) and liveness is unaffected.
8. **AS-38** (breakers are separate per operation) — **Given** the breaker of `create_intent` is open, **Then** lookups (`retrieve_intent`) and refunds (`refund`) are still attempted, and an open `refund` breaker does not stop charges.

### User Story 5 — Competing paths agree: one change, one effect, always recorded (Priority: P1)

The charge result, the resolution job, a status refresh and a late redelivery can all try to settle the same payment. Exactly one of them wins; the others see "already applied".

**Why this priority**: pattern P0311; lost updates here mean double ledger entries or a payment that is both failed and paid.

**Independent Test**: run the competing paths at once (`Promise.all`) and repeat; assert one transition, one history row, one journal, one event.

**Acceptance Scenarios**:

1. **AS-39** (transition table, pure) — **Given** the seven statuses `PENDING`, `UNKNOWN`, `COMPLETED`, `FAILED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED` and the commands `succeed`, `fail(code)`, `markUnknown(reason)`, `awaitCustomer`, `cancel`, `requestRefund`, `refundSucceeded`, **When** table-driven over every combination, **Then** exactly these are allowed: `PENDING → COMPLETED | FAILED | UNKNOWN | CANCELLED` (`cancel` only while no charge attempt is recorded); `PENDING → PENDING` by `awaitCustomer` (flag only, no new version); `UNKNOWN → COMPLETED | FAILED | PENDING`; `COMPLETED → REFUND_PENDING`; `REFUND_PENDING → REFUNDED`; `FAILED`, `CANCELLED`, `REFUNDED` accept nothing; every other pair is refused with `InvalidPaymentTransition { from, command }`; the table is exhaustive (a new status without a rule does not compile).
2. **AS-40** (completion race) — **Given** an `UNKNOWN` payment, **When** the resolution, a status refresh (AS-56) and a late charge result all report "succeeded" at once (`Promise.all` of 3, repeated 50 times), **Then** each run ends with exactly one applied transition (`UNKNOWN → COMPLETED`), version +1, one history row, one ledger journal, one `payment_succeeded` event and one push; the other two report "already applied" and no caller sees an error.
3. **AS-41** (terminal states are never revisited) — **Given** a `FAILED` payment, **When** a later lookup or refresh reports that the provider has a succeeded intent for it, **Then** nothing changes, an error is logged with both states, and `payments_conflicting_provider_state_total` increments (S14's reconciliation resolves it); **Given** a `COMPLETED` payment and a late "failed" result, **Then** the same.
4. **AS-42** (history and versions) — **Given** a payment taken `PENDING → UNKNOWN → COMPLETED → REFUND_PENDING → REFUNDED`, **Then** each move has exactly one history row `{fromStatus, toStatus, reason, actor, at}` in order, the version rises by exactly 1 per move, and history rows cannot be changed or deleted by any code path.
5. **AS-43** (cancel versus charge start) — **Given** a `PENDING` payment, **When** a cancellation (AS-48) and the processor's charge start run at once (`Promise.all`, repeated 50 times), **Then** each run ends in exactly one outcome: `CANCELLED` and the provider's create call never ran, or the charge started and the cancellation is refused as "charge already started" (the payment follows AS-15 to AS-30); never a `CANCELLED` payment together with a provider charge.

### User Story 6 — Payments and orders stay consistent: facts in, results out, compensations in both directions (Priority: P1)

Orders reserve stock and ask for payment; payments reports results; if the order is cancelled, a pending payment is cancelled; if money arrives for a cancelled order, it is refunded exactly once.

**Why this priority**: pattern P0611 and note 10/07 §19 ("saga with compensations (release stock, refund) and the outbox for events").

**Independent Test**: feed order events and refund commands (duplicated, reordered, invalid); inspect payments, the order copy, the outbox and the provider double.

**Acceptance Scenarios**:

1. **AS-44** (order facts in, idempotent and ordered) — **Given** `orders.events` carrying `order.reserved {orderId: O, userId: U, totalMinor: 2500, currency: "EUR", shopIds, reservedUntil, orderVersion: 1}`, **When** it is delivered, **Then** the order copy exists `{RESERVED, 2500, EUR, reservedUntil, orderVersion: 1}`; **When** the same message is delivered twice, **Then** one copy, no change; **When** `order.cancelled {orderVersion: 3}` arrives and then a stale `order.reserved {orderVersion: 1}`, **Then** the copy stays `CANCELLED` at version 3; **When** `order.paid {orderVersion: 2}` arrives after `order.cancelled {orderVersion: 3}`, **Then** the copy stays `CANCELLED`; **When** the message has a missing `orderId`, a negative `totalMinor`, a non-UUID `orderId`, an unsupported currency or an unknown type under a payments-relevant name, **Then** it is dead-lettered without effect and the next message is processed; other `order.*` types are acknowledged and ignored.
2. **AS-45** (events leave only through the outbox, atomically) — **Given** a payment moving to `COMPLETED`, **When** the ledger posting fails (forced) or the transaction is aborted after the status update (forced), **Then** the status, history, journal and outbox rows are all unchanged (rolled back together) and no event exists; **Given** a commit followed by a stop of the relay, **When** the relay resumes, **Then** the event is published once to the topic `payments.events` with key `paymentId` and the envelope `{eventId, type, version: 1, occurredAt, aggregateId: paymentId}`, and a consumer that sees it twice applies it once (the eventId is unique).
3. **AS-46** (a payment is created and charged without a publish inside any transaction) — **Given** a payment request, **Then** no message is sent to a queue or topic and no provider call is made while a database transaction is open: the charge command exists only as an outbox row until the relay sends it after commit.
4. **AS-47** (the order is cancelled while the customer has not finished) — **Given** a `PENDING` payment with `requiresAction: true` (a provider intent `pi_1` exists), **When** `order.cancelled` for its order arrives, **Then** the provider's cancel call runs once for `pi_1` (reference `cancel:<paymentId>`), the payment becomes `CANCELLED` with `failureCode: "order_cancelled"`, one `payment_failed {reasonCode: "order_cancelled"}` is emitted, and a later confirmation attempt by the customer fails at the provider; **When** the provider's cancel call times out, **Then** it is retried with backoff and the payment stays `PENDING` until it is cancelled; **When** the provider answers that `pi_1` already succeeded, **Then** the payment becomes `COMPLETED` (the order system turns that into a refund command, AS-50).
5. **AS-48** (the order is cancelled before any charge started) — **Given** a `PENDING` payment with no charge attempt recorded, **When** `order.cancelled` arrives, **Then** the payment becomes `CANCELLED` (`failureCode: "order_cancelled"`), the provider spy has 0 calls, one `payment_failed` is emitted, and the charge command, when it arrives afterwards, is acknowledged with no effect.
6. **AS-49** (the order is cancelled while a charge is running or unknown) — **Given** a payment `UNKNOWN`, or `PENDING` with a charge attempt recorded and no customer action pending, **When** `order.cancelled` arrives, **Then** the payment is not changed by it; **When** the payment later becomes `COMPLETED`, **Then** `payments.payment_succeeded` is emitted as usual, `payments_completed_for_unpayable_order_total` increments, and the refund follows AS-50 when the order system asks.
7. **AS-50** (refund of a completed payment) — **Given** a `COMPLETED` payment (`pi_1`, 2500 EUR, order `O`), **When** the message `orders.refund_requested {orderId: O, paymentRef: "pi_1", amountMinor: 2500, currency: "EUR", reason: "order_cancelled"}` is consumed, **Then** the payment becomes `REFUND_PENDING` (history reason `order_cancelled`), the provider's refund call runs once for `pi_1` with reference `refund:<paymentId>`, then the payment becomes `REFUNDED` with exactly one reversing ledger journal posted in the same transaction as the status change, one `payments.payment_refunded {paymentId, paymentRef: "pi_1", orderId, userId, amountMinor: 2500, currency: "EUR", occurredAt, paymentVersion}` and one push.
8. **AS-51** (refund duplicates) — **Given** the message of AS-50, **When** it is delivered five times at once (`Promise.all`) and again later, **Then** there is one transition to `REFUND_PENDING`, one provider refund call, one reversing journal, one event; messages that find the payment `REFUND_PENDING` or `REFUNDED` are acknowledged with no effect.
9. **AS-52** (refund requested before the payment is settled) — **Given** a payment `UNKNOWN` or `PENDING` with a charge attempt recorded, **When** the refund message arrives, **Then** it is not acknowledged: it is redelivered with backoff and nothing changes; **When** the payment then becomes `COMPLETED`, **Then** the next delivery refunds it (AS-50); **When** it becomes `FAILED` or `CANCELLED`, **Then** the next delivery is acknowledged as "nothing to refund" (`payments_refund_requests_total{result="nothing_to_refund"}`); **When** 24 hours pass unsettled, **Then** the message is dead-lettered and an alert metric increments; **Given** a payment `PENDING` with no charge attempt recorded, **Then** it is cancelled as in AS-48.
10. **AS-53** (refund requests that do not match) — **Given** messages whose `amountMinor` differs from the payment's, whose `currency` differs, whose `paymentRef` differs from the payment's provider reference, whose `orderId` has no payment, whose `reason` is not `order_cancelled`, or that fail validation (missing field, negative amount, non-UUID), **Then** each is dead-lettered with no effect and `payments_consumer_dead_lettered_total{reason}` increments with `refund_amount_mismatch`, `refund_currency_mismatch`, `refund_ref_mismatch`, `payment_not_found`, `unsupported_reason` or `invalid_payload`; the next message is processed (only full refunds are executed here).
11. **AS-54** (provider failures while refunding) — **Given** a `REFUND_PENDING` payment, **When** the provider's refund call times out, **Then** the payment stays `REFUND_PENDING` and the refund is retried with backoff (jittered, cap 15 min); before each retry the provider is asked whether a refund for `pi_1` already exists and, if so, the payment becomes `REFUNDED` without a second refund call; **When** the provider answers that the charge was already refunded, **Then** the payment becomes `REFUNDED`; **When** the provider refuses (a non-retryable error) or 24 hours pass, **Then** the payment stays `REFUND_PENDING`, an error is logged, `payments_refund_stuck_total` increments and the alert gauge `payments_refund_pending_oldest_age_seconds` shows its age; **When** the `refund` breaker is open, **Then** the retry is scheduled later with no provider call.
12. **AS-55** (status service for orders, R1) — **Given** payments in each status, **When** `PaymentQueryService.getPaymentStatus(paymentRef)` is called with a known provider reference, **Then** it returns `{paymentId, paymentRef, orderId, status, amountMinor, currency}` with `status` mapped `PENDING → PENDING`, `UNKNOWN → PENDING`, `COMPLETED → COMPLETED`, `REFUND_PENDING → COMPLETED`, `REFUNDED → REFUNDED`, `FAILED → FAILED`, `CANCELLED → FAILED`; **When** the reference is unknown, empty or longer than 255 characters, **Then** it returns `null`; the result never contains `clientSecret`, `userId`, internal failure details or the payment method.
13. **AS-56** (status refresh from the provider) — **Given** a payment `PENDING` with `requiresAction` and provider reference `pi_1`, and the provider now reports `pi_1` succeeded (the order system received the provider's webhook), **When** `getPaymentStatus("pi_1")` is called, **Then** the provider's intent is retrieved once (2 s limit, no retry), the payment becomes `COMPLETED` through the guarded step of AS-15 (one journal, one event, one push), and `COMPLETED` is returned; **When** 10 callers do this at once, **Then** one transition and one provider retrieval at most per 2 s per payment; **When** the provider is down, times out or the `retrieve_intent` breaker is open, **Then** the stored status is returned (`PENDING`), nothing throws and nothing changes; **When** the payment is terminal (`COMPLETED`, `FAILED`, `CANCELLED`, `REFUNDED`), **Then** the provider is not called; **When** it is `UNKNOWN`, **Then** the same lookup as AS-24 is made.

### User Story 7 — Buyers see their payments and nobody else's (Priority: P2)

A buyer reads one payment, or lists their own, and may follow a payment's status live.

**Why this priority**: the pay screen depends on it, and it is the tenant-isolation surface of this capability.

**Independent Test**: seed payments of two buyers; run the read matrix; assert identical "not found" answers.

**Acceptance Scenarios**:

1. **AS-57** (read one) — **Given** buyer `U`'s payment, **When** `U` calls `GET /payments/<id>`, **Then** `200` `paymentSchema` (AS-21); **When** buyer `V`, or any caller with another buyer's payment ID, calls it, **Then** `404 payment_not_found` with a body identical to the answer for an ID that does not exist; **When** the ID is not a UUID, **Then** `404 payment_not_found`; **When** there are no credentials, **Then** `401`; `clientSecret` is non-null only while the payment is `PENDING` with `requiresAction` and only for its owner.
2. **AS-58** (list, keyset pagination) — **Given** buyer `U` with 45 payments, **When** `GET /payments?limit=20` is called and `nextCursor` followed, **Then** pages of 20, 20 and 5, newest first with ties broken by ID, no payment twice or missed even while new payments are created between page requests, `nextCursor: null` on the last page, items are `paymentSchema` without `clientSecret`; filters `orderId` and `status` narrow the list; **When** `limit` is `0` or `101`, **Then** `400 validation_failed`; **When** `cursor` is malformed or tampered with, **Then** `400 invalid_cursor`; the default `limit` is 20.
3. **AS-59** (the list is scoped to the caller) — **Given** buyer `V`'s order `W` and payment, **When** `U` calls `GET /payments?orderId=W`, **Then** `200` with an empty list (never `403`, never `V`'s payment); no filter combination returns another buyer's payment.
4. **AS-60** (read rate limit) — **Given** a buyer who made 120 payment reads in a minute, **When** the 121st arrives, **Then** `429 rate_limited` with `Retry-After`; **Given** the limiter's store is down, **Then** reads are still answered (fail open).
5. **AS-61** (push) — **Given** a payment's status changes (any transition of AS-39 that changes the status), **Then** after the commit one realtime event `payment.status {paymentId, orderId, status, version}` is published to the topic `user:<userId>` of the owner only; **Given** the realtime hub is down (forced), **Then** the transition and its events are unaffected, the failure is logged and counted, and polling `GET /payments/<id>` still shows the status.

### User Story 8 — The domain is safe, observable and well-bounded (Priority: P3)

Operators can see the breaker, the unknown payments and the stuck refunds. No secrets leak. Other capabilities rely on a small, stable public surface.

**Why this priority**: it keeps the money path operable and the architecture checkable.

**Independent Test**: run the flows above and inspect metrics, logs, the ownership check and the module graph.

**Acceptance Scenarios**:

1. **AS-62** (observability) — **Given** the flows of AS-15, AS-16, AS-23, AS-31 and AS-50, **Then** these exist and move as described: `payments_created_total{result}`, `payments_status_transitions_total{from,to}`, `payments_provider_calls_total{operation,outcome}`, `payments_unknown_outcomes_total`, `payments_unknown_oldest_age_seconds`, `circuit_breaker_open{breaker}`, `payments_refund_pending_oldest_age_seconds`, `payments_consumer_dead_lettered_total{reason}`; every log line carries `requestId` or `traceId`, and payment lines carry `paymentId` and `orderId`; one trace spans the request, the outbox row and the processor's work (same `traceId`).
2. **AS-63** (no secrets, no card data) — **Given** every flow above run with a sentinel `paymentMethodId`, a provider secret and a `clientSecret`, **When** the logs, outbox payloads, event payloads and error responses are searched, **Then** the provider secret and the `clientSecret` appear nowhere, the `paymentMethodId` appears nowhere except the stored payment record that needs it for the charge, and responses of `5xx` carry only a generic `detail` without stack traces, SQL or provider messages.
3. **AS-64** (boundaries, static) — **Given** the finished implementation, **Then** the payment-intent code reads and writes only tables owned by `payments` (the ownership check reports no finding for these files; today the code queries the catalog's table, associates the order model and references orders by foreign key); the payment model has no association or foreign key to an order or user model; no other domain imports a payments model (`PaymentModel`, `PaymentStatus`, `PaymentDtoService` leave the public entry point); `pnpm check:boundaries` is green; and the module graph has no `orders ↔ payments` cycle (debt D-11).
4. **AS-65** (configuration is validated at startup) — **Given** a missing provider key, a missing or malformed setting for any limit in this spec, or a non-positive timeout, attempt count or threshold, **When** the process starts, **Then** it fails with a message naming the setting and does not serve.
5. **AS-66** (graceful shutdown) — **Given** the processor holds a provider call in flight, **When** it receives the stop signal, **Then** it stops taking new commands, lets the call finish within its 8 s limit and records the result, then exits; **When** it exits before recording (forced kill), **Then** the redelivery follows AS-30.

### Edge Cases

- **Double submit, retries, replays**: AS-03, AS-04, AS-05, AS-06, AS-07, AS-08, AS-09.
- **Concurrency and invariants**: AS-05, AS-06, AS-40, AS-43, AS-51, AS-56.
- **Illegal state transitions**: AS-39, AS-41, AS-52 (refund against the wrong state), AS-43.
- **Cross-tenant and cross-user access**: AS-10, AS-57, AS-58, AS-59, AS-61.
- **Limits and ranges**: AS-13, AS-14, AS-58, AS-60.
- **Timeouts and unknown outcomes**: AS-23 to AS-30, AS-36, AS-54, AS-66.
- **Provider outage and breaker**: AS-31 to AS-38.
- **Duplicate, late and out-of-order messages**: AS-20, AS-44, AS-49, AS-51, AS-52.
- **Payment after the order was cancelled or expired**: AS-11, AS-19, AS-47 to AS-50.
- **Forged or tampered input and provider answers**: AS-02, AS-22, AS-53, AS-63.
- **Atomicity and crash windows**: AS-30, AS-45, AS-46, AS-66.
- **A buyer who abandons the customer-action step**: AS-47 (order cancelled by hold expiry cancels the provider intent).
- **A refund made outside the platform, or a provider that later contradicts a final status**: AS-41 (reported, resolved by S14).
- **The order copy is stale or missing**: AS-12, AS-44.

## Requirements *(mandatory)*

### Functional Requirements

**Payment intent (accept)**

- **FR-001**: `POST /payments/intents` requires an authenticated buyer and `Idempotency-Key`, accepts only `{orderId, paymentMethodId}`, and answers `202` with `Location` and `{paymentId, orderId, status, amountMinor, currency, createdAt}`. It never calls the provider (AS-01, AS-02).
- **FR-002**: Amount and currency are copied from the order copy; the client cannot supply or change them. Amounts are integers from 1 to 99,999,999 minor units; currencies are `EUR`, `USD`, `GBP` (AS-02, AS-13).
- **FR-003**: A payment is accepted only for an order that belongs to the caller, is `RESERVED`, and whose hold has not ended (`now < reservedUntil`); otherwise `404 order_not_found` (not the caller's, unknown, or not known within 2 s) or `409 order_not_payable` with `reason` (AS-10, AS-11, AS-12).
- **FR-004**: One payment exists per order, enforced by the store itself (never by a check followed by a write); the loser of a race, or a later request with a new key, gets `409 payment_already_exists` with `existingPaymentId` (AS-06).
- **FR-005**: The payment, its history row, its charge command (outbox) and the idempotency record are written so that either all exist or none; no provider call or message publish happens inside the transaction (AS-01, AS-46).
- **FR-006**: `POST /payments/intents` is rate limited per buyer at 10 per minute, failing closed (AS-14).

**Idempotency**

- **FR-007**: The request header `Idempotency-Key` (8–128 characters of `[A-Za-z0-9_-]`) is mandatory. Same key and same body replays the stored answer with `Idempotency-Replayed: true`; same key while the first is running answers `409 idempotency_in_flight` with `Retry-After: 1`; same key with another body answers `422 idempotency_key_reuse`; a missing or malformed key answers `422 idempotency_key_required` or `idempotency_key_invalid`; keys are per buyer and live 24 hours (AS-03, AS-04, AS-07, AS-08).
- **FR-008**: Only a `202` is remembered. Failures before a payment exists leave the key unused; `5xx` releases it (AS-09).
- **FR-009**: The provider-side idempotency reference for the charge is the order's ID, and for a refund `refund:<paymentId>`, for a cancellation `cancel:<paymentId>`; the provider is never given a reference derived from client input (AS-15, AS-50, AS-47).

**Charge processing**

- **FR-010**: A processor, separate from the HTTP request, handles each charge command. Before the provider call it re-checks that the order copy is still payable; if not, the payment is `CANCELLED` and the provider is not called (AS-19).
- **FR-011**: The processor records that a charge attempt began (guarded by status), then calls the provider with the order ID as idempotency reference and metadata `{orderId, paymentId}`, then applies the classified answer (AS-15, AS-30).
- **FR-012**: Provider answers are classified by a pure rule: succeeded → `COMPLETED`; definite decline → `FAILED(card_declined | insufficient_funds | expired_card | …)`; customer action required → `PENDING` with `requiresAction`; rejected request (`400`, `401`, `403`) → `FAILED(provider_rejected)`; timeout, connection reset, `5xx` → `UNKNOWN`; `429` and refusals by an open breaker → "not sent, retry"; an answer that fails validation (amount, currency, status, order metadata) → `UNKNOWN(provider_response_invalid)` (AS-15 to AS-18, AS-22, AS-23, AS-31).
- **FR-013**: A charge whose command is delivered again never creates a second provider charge: a recorded attempt without an applied result becomes `UNKNOWN(crash_recovery)` and is settled by lookup (AS-20, AS-30).
- **FR-014**: When customer action is required the payment stays `PENDING`, exposes a `clientSecret` to its owner only, and ends through a status refresh or the resolution lookup; the `clientSecret` is cleared on any final status and is never logged or published (AS-17, AS-63).
- **FR-015**: Not-sent charges are retried with exponential backoff and full jitter (base 2 s, cap 60 s) for at most 6 attempts and 10 minutes from creation; then the payment is `FAILED(provider_unavailable)` (AS-34).
- **FR-016**: The provider client performs no network retries of its own; the charge retry of FR-015 is the only retry layer (AS-35).

**Unknown outcomes**

- **FR-017**: A timeout, connection error or `5xx` after a charge was sent makes the payment `UNKNOWN`; the charge is never sent again for that payment (AS-23).
- **FR-018**: `UNKNOWN` payments are settled by looking the intent up by our reference (`orderId` metadata), first at `+30 s`, then with exponential backoff and full jitter, cap 15 minutes: found and succeeded → `COMPLETED`; found and failed or canceled → `FAILED`; found awaiting the customer → `PENDING`; not found for at least 60 minutes since the charge attempt began → `FAILED(no_provider_record)`; provider unreachable → stays `UNKNOWN` (AS-24 to AS-28).
- **FR-019**: A periodic sweep (every 60 s, one run at a time across all workers) resolves any due `UNKNOWN` payment within 2 minutes of its due time, so a lost job never strands a payment (AS-29).
- **FR-020**: A payment `UNKNOWN` for more than 24 hours stays `UNKNOWN`, raises a warning once per hour, and is visible in `payments_unknown_oldest_age_seconds`; it is never auto-failed on guesswork (AS-27).

**Circuit breaker and timeouts**

- **FR-021**: Each provider operation (`create_intent`, `retrieve_intent`, `cancel_intent`, `refund`) has its own breaker: rolling window 10 s, opens at ≥ 50% failures with at least 10 calls, stays open 30 s, then allows one probe; the state is exported as `circuit_breaker_open{breaker}` (AS-31, AS-32, AS-38).
- **FR-022**: Only timeouts, connection errors, `5xx`, `429` and calls slower than 5 s count as breaker failures; definite declines and `4xx` rejections do not (AS-33).
- **FR-023**: Every provider call has an explicit limit: 8 s for create and refund, 4 s for lookup and cancel, 2 s for a status refresh, 2 s to connect; a call refused by an open breaker is "not sent", never `UNKNOWN` (AS-31, AS-36).
- **FR-024**: The HTTP surface and readiness do not depend on the provider: payment acceptance and reads work with every breaker open; no database transaction is open during a provider call (AS-36, AS-37).

**State machine and concurrency**

- **FR-025**: Payment statuses are `PENDING`, `UNKNOWN`, `COMPLETED`, `FAILED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED` with the transitions of AS-39; the transition table is exhaustive and pure (no clock, no I/O) (AS-39).
- **FR-026**: Every status change is one guarded update (the payment's current status and version must match) that must affect exactly one record, plus one history row `{fromStatus, toStatus, reason, actor, at}` and a version increase of 1, in the same transaction as its ledger posting and outbox event; a lost race reports "already applied" and has no effect (AS-40, AS-42).
- **FR-027**: Terminal statuses are never revisited; a contradicting provider report is logged, counted and left to reconciliation (AS-41).
- **FR-028**: A cancellation applies only while no charge attempt is recorded; the decision and the charge start are mutually exclusive (AS-43).

**Ledger link**

- **FR-029**: Moving to `COMPLETED` posts the sale journal through the ledger capability inside the same transaction, once per payment; moving to `REFUNDED` posts the reversing journal the same way. A ledger failure aborts the whole step (AS-15, AS-45, AS-50).

**Events and outbox**

- **FR-030**: Each change to `COMPLETED`, `FAILED`, `CANCELLED` and `REFUNDED` writes one event to the outbox in the same transaction: `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_failed` (reason `order_cancelled`/`order_not_payable`) and `payments.payment_refunded`. Transitions to `UNKNOWN`, `PENDING` and `REFUND_PENDING` publish nothing to orders (AS-15, AS-16, AS-23, AS-45, AS-50).
- **FR-031**: Events carry the envelope `{eventId, type, version: 1, occurredAt, aggregateId}`, are keyed by `paymentId`, and money is in `…Minor` fields (AS-45).
- **FR-032**: After each status change the owner gets a realtime event `payment.status`; push failure never affects the transition (AS-15, AS-61).

**Saga with orders**

- **FR-033**: This capability keeps its own copy of order facts `{orderId, userId, totalMinor, currency, status, reservedUntil, orderVersion}` fed only by `order.reserved`, `order.paid` and `order.cancelled`; updates are version-guarded so that duplicate and out-of-order messages cannot move the copy backwards; it never reads orders' tables or calls orders synchronously (AS-44, AS-64).
- **FR-034**: Every consumer of this capability validates its payload, is idempotent, and dead-letters invalid messages without blocking the queue (AS-20, AS-44, AS-53).
- **FR-035**: `order.cancelled` cancels a payment that has not started charging (AS-48) or that is waiting for the customer (cancelling the provider's intent, AS-47); it leaves running or unknown payments alone (AS-49).
- **FR-036**: `orders.refund_requested` v1 (`{orderId, paymentRef, amountMinor, currency, reason: "order_cancelled"}`) refunds a `COMPLETED` payment in full, exactly once, with a reversing journal and a `payment_refunded` event; it waits (redelivered with backoff, up to 24 hours) for payments that are not yet settled; it is a no-op for settled-without-money payments and for payments already being refunded or refunded; it rejects mismatching amount, currency, reference, unknown payment or unsupported reason (AS-50 to AS-53).
- **FR-037**: Refund execution never blindly resends: before a retry it asks the provider whether the refund exists; "already refunded" counts as done; an unfinished refund older than 24 hours alarms and stays `REFUND_PENDING` (AS-54).
- **FR-038**: `PaymentQueryService.getPaymentStatus(paymentRef)` maps statuses as in AS-55 and refreshes non-terminal payments from the provider within a 2 s limit, at most once per payment per 2 s, returning the stored status when the provider cannot answer (AS-55, AS-56).

**Reads**

- **FR-039**: `GET /payments/:paymentId` and `GET /payments` return only the caller's payments; a payment of another buyer is `404 payment_not_found` and indistinguishable from a missing one. Lists use cursor pagination (default 20, max 100, newest first, unique tie-breaker) and the filters `orderId`, `status` (AS-57 to AS-59).
- **FR-040**: Reads never change state (`GET` is safe) and are rate limited at 120 per minute per buyer, failing open (AS-21, AS-60).
- **FR-041**: `clientSecret` is returned only to the owner of a `PENDING` payment with `requiresAction`, never in lists, events, logs or the status service (AS-17, AS-55, AS-63).

**Security, operations, boundaries**

- **FR-042**: Every response is validated against its `packages/contracts` schema and every error is problem+json; `5xx` details are generic (AS-63).
- **FR-043**: Logs, metrics and traces meet AS-62; secrets and card data never appear (AS-62, AS-63).
- **FR-044**: Time comes from an injected clock; all timeouts, thresholds, limits, attempt counts and backoff parameters are configuration with the defaults of this spec, validated at startup (AS-65).
- **FR-045**: Shutdown is graceful for the processor (AS-66).
- **FR-046**: This domain reads and writes only the tables it owns (payments, their history, the order copy, and the ledger tables through the ledger capability's own service); orders and users are plain IDs without associations; no model leaves the domain's public entry point; the payment-query code in `apps/core` and the payment stream in `apps/sse-gateway` move into the domain or are replaced by the realtime event (AS-64).

### Key Entities *(include if feature involves data)*

- **Payment**: one per order. Order ID and buyer ID (plain IDs, no associations), amount (integer minor units), currency, status, version, provider reference (`pi_…`, once the provider answers), charge-attempt time, requires-action flag, failure code, creation and update times. The aggregate root.
- **Payment history entry**: append-only record of a transition: from, to, reason, actor, time.
- **Order copy**: the order facts payments needs: order ID, buyer ID, total, currency, status (`RESERVED`, `PAID`, `CANCELLED`), reservation deadline, order version. Copied from events, never written back (IX.8).
- **Charge command / refund command / cancel command**: internal asynchronous requests to the processor, written to the outbox with the payment's change.
- **Event (outbox)**: `payments.payment_succeeded`, `payments.payment_failed`, `payments.payment_refunded`.
- **Idempotency record** and **consumer dedupe record**: technical records kept through the platform's allow-listed technical stores.
- **Breaker**: per-operation runtime state (closed, open, half-open), not persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Under any retry pattern of one payment request (sequential, simultaneous, with the same or different keys, after a timeout), exactly 1 payment exists and at most 1 charge reaches the provider — 0 double charges in 100% of 200 repeated runs with 5 simultaneous requests.
- **SC-002**: With the provider fully down, 99% of payment requests and reads are answered in under 300 ms and the platform stays ready.
- **SC-003**: After the failure threshold is crossed, the provider receives at most 2 calls per minute per operation while the breaker is open (the probes).
- **SC-004**: In 100% of timeouts, the provider receives exactly 1 charge request for the payment; each `UNKNOWN` payment is settled within 2 minutes of the provider being reachable, or is visible in an alert after 24 hours.
- **SC-005**: When the competing settlement paths race 50 times, 100% of runs produce 1 transition, 1 ledger journal and 1 success event.
- **SC-006**: 100% of payments that complete after their order was cancelled end with exactly 1 refund; a refund completes within 5 minutes of the command when the provider is healthy.
- **SC-007**: In a matrix of every read and create route against every other buyer and anonymous caller, 100% of attempts to reach someone else's payment or order return "not found" with identical bodies and change nothing.
- **SC-008**: 100% of status changes to a final status have exactly 1 event, including when the process stops between commit and publish; 0 events exist for rolled-back changes.
- **SC-009**: Buyers see the final result of a normal payment within 5 seconds of the provider's answer, by push or by reading.
- **SC-010**: The ownership check reports 0 cross-domain accesses for the payment-intent code (today: 3 kinds of cross-domain access), the `orders ↔ payments` cycle is gone, and 0 secrets or card data appear in a 10,000-line log sample of the full flows.

## Assumptions

- Decisions marked `[BREAKING]`, `[CONTRACT]`, `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there. Defaults most visible here: payment requested by the buyer over HTTP with `202` instead of a message from the gateway; amount and currency from an event-fed copy of the order (no synchronous read of orders); one payment per order; never resend a charge after a timeout; per-operation breakers that ignore declines; a new status `REFUND_PENDING`; events on `payments.events` replacing `payments.responses`.
- **Pattern coverage**: P0311 → AS-39–AS-43; P0407 → AS-01, AS-15, AS-21, AS-61 (accepted now, paid later, status by read and push); P0414 → AS-03–AS-09, AS-15 (provider reference = order ID), AS-50; P0611 → AS-44–AS-56; P0617 → AS-31–AS-38. The outbox (named in the capability title) → AS-01, AS-45, AS-46.
- The platform never sees card numbers: the buyer's browser exchanges card details for a provider token (`paymentMethodId`) with the provider's hosted fields; that token is the only payment instrument data stored.
- One payment per order and no retry with a new card: a declined payment makes S10 cancel the order, and the buyer checks out again. A different payment method for the same order is therefore never needed here.
- Only full refunds are executed. Partial refunds, disputes and provider-initiated refunds are out of scope; reconciliation (S14) reports differences.
- The ledger's fee and account rules are S14's: this capability passes the payment's amount, currency, buyer and ID, and receives a journal ID back.
- Currencies are limited to two-decimal currencies so that minor units equal the provider's smallest unit without conversion.
- The order copy keeps only the orders the buyer can pay; it is kept for at least as long as payments are retained and is rebuilt by replaying the order events if lost (IX.8).
- The hold (15 minutes) is S10's; this capability only reads `reservedUntil` from the copy. A payment that completes in the last moments of a hold is refunded by the order system's rule (S10, AS-47 there).
- The 8 s, 4 s and 2 s call limits, the breaker numbers (10 s window, 50%, 10 calls, 30 s, 5 s slow call), the 6 attempts and 10 minutes, the 30 s first lookup, the 60-minute no-record limit, the 24-hour stuck and refund limits, the 60 s sweep, 24 h key TTL, 10 per minute and 120 per minute rate limits, the 2 s order-copy wait and the page size limits are configuration defaults of this spec.
- Operator-initiated refunds go through the order system (a refund command for an order) and not through a payments endpoint.
- Payment records are financial records: they are not deleted on user deletion; retention and anonymisation follow the finance rules owned by S14.

## Cross-capability contracts

**Provides**:

- HTTP (`packages/contracts` schemas in brackets):
  - `POST /payments/intents` (`Idempotency-Key` required; body `createPaymentIntentRequestSchema` `{orderId: uuid, paymentMethodId: string 1–255}`) → `202` with `Location: /api/payments/<paymentId>` and `paymentAcceptedSchema` `{paymentId, orderId, status: "PENDING", amountMinor, currency, createdAt}`; problem codes `validation_failed` 400, `order_not_found` 404, `order_not_payable` 409 (`reason: 'order_cancelled' | 'order_paid' | 'hold_expired'`), `payment_already_exists` 409 (`existingPaymentId`), `idempotency_in_flight` 409, `idempotency_key_required | idempotency_key_invalid | idempotency_key_reuse` 422, `amount_out_of_range` 422, `currency_unsupported` 422, `rate_limited` 429.
  - `GET /payments/:paymentId` → `paymentSchema` `{id, orderId, status: 'PENDING' | 'UNKNOWN' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED', amountMinor, currency, failureCode: string | null, requiresAction: boolean, clientSecret: string | null, version, createdAt, updatedAt}`; `404 payment_not_found`.
  - `GET /payments?orderId&status&limit&cursor` → `paymentPageSchema` `{items: paymentSchema[] (clientSecret always null), nextCursor: string | null}`; `400 validation_failed | invalid_cursor`.
  - Removed: `GET /payment/by-key/:idempotencyKey`, `GET /payment/:id`, `GET /payment` (singular), the payment SSE stream, and the gateway's direct write of payment requests.
- Realtime: topic `user:<userId>`, event `payment.status` `{paymentId, orderId, status, version}` (hub: S51).
- `PaymentQueryService` (R1): `getPaymentStatus(paymentRef: string): Promise<{ paymentId, paymentRef, orderId, status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED', amountMinor, currency } | null>` with the status mapping of AS-55 and the provider refresh of AS-56 (2 s limit, never throws for provider trouble). **Consumers: S10 (the webhook confirms the payment before marking the order paid; `paymentRef` is the provider's intent ID, the same ID the provider's webhook carries).**
- Events (outbox → topic `payments.events`, key `paymentId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; every payload includes `paymentVersion`; money in `…Minor`):
  - `payments.payment_succeeded` `{paymentId, paymentRef, orderId, userId, amountMinor, currency, occurredAt, paymentVersion}`.
  - `payments.payment_failed` `{paymentId, paymentRef: string | null, orderId, userId, amountMinor, currency, reasonCode: 'card_declined' | 'insufficient_funds' | 'expired_card' | 'provider_rejected' | 'provider_unavailable' | 'provider_canceled' | 'no_provider_record' | 'order_not_payable' | 'order_cancelled' | 'declined_other', occurredAt, paymentVersion}`.
  - `payments.payment_refunded` `{paymentId, paymentRef, orderId, userId, amountMinor, currency, occurredAt, paymentVersion}`.
  - **Consumers: S10 (`orders` consumer of `payments.events`), S28 (buyer notifications), S40 (analytics), S14 (reconciliation).**
- Consumers this capability runs (other capabilities publish to them): `orders.events` (own consumer group: `order.reserved`, `order.paid`, `order.cancelled`); the single-consumer message `orders.refund_requested` v1.
- Rate-limit policies (declared in S50's registry): `payments.create.user` 10/minute per user (fail closed); `payments.read.user` 120/minute per user (fail open).
- Scheduled and queued jobs (registered with S49): `payments.charge` (per payment, from the outbox command; ≤ 6 attempts, backoff), `payments.resolve-unknown` (per payment, first at +30 s), `payments.sweep-unknown` (every 60 s, concurrency 1), `payments.refund` (per payment, backoff, 24 h), `payments.cancel-intent` (per payment, backoff).
- Modules for the apps: `PaymentModule` (core: HTTP, R1 `PaymentQueryService`) and `PaymentProcessorModule` (payment-processor and worker: consumers, jobs, charge processing). Nothing else is exported from the domain's entry point for this capability: no model, status enum, DTO service, repository, provider client or breaker. (The ledger exports of S14 and the payout exports of S15 are theirs.)

**Requires**:

- **S10** (`orders`): events `order.reserved` `{orderId, userId, totalMinor, currency, shopIds, reservedUntil, orderVersion}`, `order.paid` `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines, shopOrders, orderVersion}` and `order.cancelled` `{orderId, userId, reason, previousStatus, orderVersion}` on topic `orders.events` (key `orderId`, envelope as above, `orderVersion` rising per order); the single-consumer message `orders.refund_requested` v1 `{orderId, paymentRef, amountMinor, currency, reason: 'order_cancelled'}`; S10 calls `getPaymentStatus` and consumes `payments.events`. **Differs from S10's spec**: this capability does not call `OrderQueryService.getPayableOrder` (it keeps the order copy from events instead, to avoid an `orders ↔ payments` module cycle, IV.2 and D-11); it needs S10 to keep `order.reserved` carrying `userId`, `totalMinor`, `currency` and `reservedUntil` (see `questions.md`).
- **S14** (`payments`, same domain): `LedgerService.recordPaymentCaptured({ paymentId, userId, amountMinor, currency }, tx): Promise<{ journalId }>` and `LedgerService.recordPaymentRefunded({ paymentId, amountMinor, currency }, tx): Promise<{ journalId }>`, each posting a balanced journal inside the caller's transaction, idempotent per `paymentId` (a second call returns the existing journal), failing the transaction on any imbalance; the fee and account rules live inside S14.
- **S53** (events): `outbox.append(event)` inside the domain's transaction (IX.6) and the relay to topics and queues; the consumer framework (envelope check, schema validation, per-consumer idempotency, dead-lettering) for `orders.events` and `orders.refund_requested`; single-consumer messages with redelivery and backoff.
- **S49** (jobs): delayed per-payment jobs, periodic jobs with single-run leases, retries with backoff and a dead-letter state.
- **S50** (rate limiter): the two policies above with `Retry-After`.
- **S51** (realtime): `RealtimePublisher.publish(topic, event, payload)` and the `user:<id>` topic registration.
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`; the `Idempotency-Key` facility (mandatory header, stored replay, in-flight `409`, different body `422`, 24 h TTL, per-principal scope, failures before a record exists not remembered, `Idempotency-Replayed` header); injected clock; config validation; metrics registry; graceful shutdown.
- **S01** (`identity`): `Firewall()`, `@User()` and `AuthenticatedUser = { id, role, sessionId, amr }`; guest cookies never authenticate.
- **The payment provider** (external, reached only through a port and one adapter that validates every answer): create-and-confirm a payment intent with an idempotency reference and metadata; retrieve an intent by ID; find an intent by metadata reference; cancel an intent; create a refund with an idempotency reference; list the refunds of an intent.
- **S48** (BFF) and **W03** (web): the pay step posts `POST /payments/intents`, follows `payment.status` or polls `GET /payments/:id`, and when `requiresAction` is true confirms with the provider's client library using `clientSecret`; screens that combine an order with its payment compose them through `GET /payments?orderId=` (IX.7 R2).
- **S14** (reconciliation): reports provider-initiated refunds and the contradictions counted by `payments_conflicting_provider_state_total` (AS-41) and `payments_provider_mismatch_total` (AS-22).
