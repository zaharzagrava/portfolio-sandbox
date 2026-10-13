# Postmortem: checkout stuck on "Payment is being processed…" (a payment that was never sent to the processor)

**Status:** fixed (`6886cde`, `77a6f03`) · **Severity:** SEV2 on the local/dev stack (the main purchase flow could never finish; nothing was ever charged) · **Date:** 2026-10-12 · **Found by:** a human clicking through checkout; every automated check was green.

## Summary
After many hours of unattended agent builds, 21 capabilities had passed their gates and the full regression checkpoint. The first manual checkout then
hung on "Payment is being processed…" for ever, and the page polled the order every few seconds with the same answer: `order RESERVED, payment PENDING`.
Two independent defects together meant the **charge request never left the database**, so the payment processor was never asked anything. Nothing
reported an error to the user, the tests, or the health check.

## Impact
- No purchase could complete on the dev stack (the happy path of the main flow).
- No money moved: the payment stayed `PENDING`, and the order reservation expired after 15 minutes.
- Undetected by 21 capability gates, a 201-suite backend sweep and 168 browser tests.

## Timeline (UTC; the machine's clock is two hours ahead)
| Time | Event |
|---|---|
| 16:02 | First manual checkout. Payment `PENDING`; the page polls `order RESERVED / payment PENDING` every few seconds. |
| 16:04 | The outbox row for the charge request is **parked** (`MAX_ATTEMPTS`, 10 attempts) without an error text. |
| 16:08 | Defect 1 fixed on the machine by hand: ElasticMQ restarted with the three missing queues. |
| 16:10 | Second checkout: still stuck. The queue exists now and stays empty. |
| 16:14 | Second row reaches attempt 10 and is parked. A probe message sent straight to the queue is accepted and consumed, so the queue and the worker are healthy. |
| about 16:20 | Defect 2 found: the row carries a `groupId`, which a standard queue refuses. Fixed and pushed. |

## Root causes
1. **A queue that did not exist.** The local queue stand-in (ElasticMQ, a small imitation of Amazon SQS) is configured by a file listing its queues.
   It lacked `payments-charge`, `orders-refund-requested` and `tenancy-invite-requested`, which the code uses. The file said, "Queues are added here
   as sections land"; nobody added these when the payments and tenancy sections landed. The only symptom was a repeated log line from the consumer
   ("The specified queue does not exist"); the API kept answering `ready`.
2. **An invalid option on a valid queue.** The charge request is written to the outbox with a `groupId` (the payment id). A message group id is only
   valid for **FIFO** queues (names ending in `.fifo`); `payments-charge` is a standard queue. The queue client checks this before sending and throws
   `groupId is for FIFO queues only`. The relay treats any failure as temporary, retries with growing delays, and parks the row after ten attempts.
   The refund request (`orders-refund-requested`) had the same mistake.

How the chain broke: payment created `PENDING` → charge request written to the outbox in the same transaction → relay tries to send it (throws on every
attempt) → row parked → the worker never receives it → the provider is never called → the status never changes → the page waits.

## Why nothing caught it
- **A tolerant test.** The checkout journey ([`cart-checkout.spec.ts` L67](../../packages/web/tests/cart-checkout.spec.ts#L67)) waits for either
  "Payment is being processed…" **or** "Order confirmed" and passes on both. The agent that wrote it had noticed that payments did not settle on this
  stack, wrote the test to accept that, and recorded the limitation in the spec's notes.
- **The closest backend test checked the row loosely.** [`payment-intent.e2e-spec.ts` L110](../../packages/backend/libs/domains/payments/payment-intent.e2e-spec.ts#L110)
  (S13 AS-01) asserts the outbox row with `toMatchObject` (topic, type, status, `body`), which ignores extra fields, so the stray `groupId` passed.
- **Nothing sent through the queue client.** [`payment-events.e2e-spec.ts` L222-L236](../../packages/backend/libs/domains/payments/payment-events.e2e-spec.ts#L222)
  (S13 AS-46) asserts that accepting a payment leaves **only** an outbox row: no queue message, no provider call, because the relay does not run in that
  test. [`payment-charge.e2e-spec.ts` L344](../../packages/backend/libs/domains/payments/payment-charge.e2e-spec.ts#L344) tests the worker by enqueuing straight
  into a test queue, bypassing the outbox and the relay. The option check lives in the real queue client, so no test applied it to the real options.
- **Configuration not tied to code.** Nothing compared the queue names used in code with the queue definitions in the infrastructure file.
- **Silent failure.** A missing queue was a log line, a parked outbox row was a database state; neither affected the health endpoint.
- **The relay behaved as designed.** [`outbox-relay.e2e-spec.ts` L378](../../packages/backend/libs/infrastructure/outbox/outbox-relay.e2e-spec.ts#L378)
  (S53 AS-18) specifies and tests exactly "a row that fails ten times is parked, logged once, stops blocking its aggregate". The behaviour was right for
  a transient failure; here the failure was deterministic, and no test or alert told the two apart.

## Fixes
- [`6886cde`](https://github.com/zaharzagrava/portfolio-sandbox/commit/6886cde): the three queues (and their dead-letter queues) are defined in
  [`elasticmq.conf`](../../infra/docker/elasticmq/elasticmq.conf).
- [`77a6f03`](https://github.com/zaharzagrava/portfolio-sandbox/commit/77a6f03): the charge request
  ([`payment-intent.service.ts`](../../packages/backend/libs/domains/payments/application/payment-intent.service.ts), introduced in `7a0ee8c`, S13) and the
  refund request ([`refund-command.adapter.ts`](../../packages/backend/libs/domains/orders/infra/refund-command.adapter.ts), introduced in `4251a91`, S10) no
  longer carry a `groupId` (their handlers are idempotent, so ordering is not needed). The outbox now validates queue options **when the task is created**
  ([`append-with-executor.ts`](../../packages/backend/libs/infrastructure/outbox/append-with-executor.ts), `taskRow`), inside the caller's transaction, so the
  same mistake fails the first payment test instead of parking a row ten retries later.
- [`f2b4a7c`](https://github.com/zaharzagrava/portfolio-sandbox/commit/f2b4a7c): tests for the two callers (below).

## Tests around this code

Unit tests (no database or queue; they run in seconds):
- [`task-row.spec.ts`](../../packages/backend/libs/infrastructure/outbox/task-row.spec.ts) (4 tests): the rule itself. A standard queue takes no
  `groupId`, a FIFO queue needs one, the delay is 0 to 900 seconds.
- [`payment-intent.service.spec.ts`](../../packages/backend/libs/domains/payments/application/payment-intent.service.spec.ts): builds the real charge service
  with fakes for the database, captures the task it appends and runs the outbox's real option check on it.
- [`refund-command.adapter.spec.ts`](../../packages/backend/libs/domains/orders/infra/refund-command.adapter.spec.ts) (2 tests): the same for the refund request,
  plus "asks only once per payment".
- Verified by mutation: with the old `groupId` lines put back, both caller tests fail with `invalid enqueue options for payments-charge: groupId is for FIFO
  queues only` (and the same for `orders-refund-requested`); without them they pass.

Database-backed e2e suites (need the test stack: Postgres, Redis, Kafka and so on). The suites that create a payment (by calling `accept`, or through the HTTP
endpoint that calls it; found by search: `payment-intent`, `payment-events`, `payment-charge`, `payment-breaker`, `payment-read`, `payment-refund`) now go
through the same validation inside `accept`, so with the old code they would have failed at that call. **They have not been re-run since the fix** (the test stack cannot run next to the dev stack on one laptop);
the next checkpoint runs them:
- [`payment-intent.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-intent.e2e-spec.ts): S13 AS-01, the full effect of accepting a payment,
  including the pending charge row.
- [`payment-events.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-events.e2e-spec.ts): S13 AS-46, accepting leaves only an outbox row.
- [`payment-charge.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-charge.e2e-spec.ts): the worker side (idempotent charge, bad bodies to the
  dead-letter queue); it bypasses the relay.
- [`payment-breaker.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-breaker.e2e-spec.ts) and
  [`payment-read.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-read.e2e-spec.ts): create payments through `accept`.
- [`payment-refund.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-refund.e2e-spec.ts): the refund handling on the payments side (it creates
  its payments through `accept`). [`payment-transitions.e2e-spec.ts`](../../packages/backend/libs/domains/payments/payment-transitions.e2e-spec.ts) tests the
  payment's state machine (its `requestRefund` is a state transition, not the queue message) and does not touch the outbox task path. The orders-side
  refund request (`RefundCommandAdapter`) had no direct test before `f2b4a7c`.
- Relay and queue client: [`outbox-relay.e2e-spec.ts`](../../packages/backend/libs/infrastructure/outbox/outbox-relay.e2e-spec.ts) (retry, backoff, parking),
  [`outbox-tasks.e2e-spec.ts`](../../packages/backend/libs/infrastructure/outbox/outbox-tasks.e2e-spec.ts) (tasks to a recording queue) and
  [`task-queue.e2e-spec.ts`](../../packages/backend/libs/infrastructure/sqs/task-queue.e2e-spec.ts) (the SQS client against the real local queue, with its
  own queue names, not `payments-charge`).

Still missing: a test that follows one payment from `PENDING` to `COMPLETED` through the relay, the real queue and the worker, and a browser journey that
requires "Order confirmed" (follow-ups 1 and 2 in the runbook).

## What would have prevented it (follow-ups, in `docs/work/architecture/sdd-runbook.md`)
1. The checkout journey must require "Order confirmed", with the "never claims success early" case as a separate test.
2. A scripted end-to-end flow at every checkpoint that waits for the order to be PAID.
3. A check that every queue the code uses exists in the infrastructure file, and an API that refuses to report ready while one is missing.
4. A rule for agents: a test that passes both when a feature works and when it does not is a defect, and an environment limit is reported as blocked,
   never encoded as acceptable.

## Lessons
- Green gates prove that the checked things pass, not that the product works. The unchecked space between components is where this lived.
- The cheapest detector was the oldest one: someone using the product.
- Fail at the producer, loudly, in the transaction. A retry loop that ends in a parked row hides a deterministic bug as a transient one.
