---
id: idempotency-key
title: Idempotency keys
kind: concept
status: draft
defined_by: S54
---
# Idempotency keys
## Definition
An idempotency key is a client-chosen string of 8 to 128 characters. It lets a client repeat a write request and get one effect. The platform toolkit (S54) declares it per route with `@Idempotent` and purges old keys with a job. Checkout, payment start and job enqueue use it. A retry with the same key creates no second order, charge or job. The client keeps one key for all retries of one attempt.

## Rules
- **idempotency-key.C-01** A route declared with [`@Idempotent`](../terms/idempotent-decorator.md) MUST require an `Idempotency-Key` header, and `POST /checkout` MUST answer `422 idempotency_key_required` when the key is missing.
- **idempotency-key.C-02** An `Idempotency-Key` on `POST /checkout` MUST have 8 to 128 characters.
- **idempotency-key.C-03** `POST /payments/intents` MUST require an `Idempotency-Key`, answer [`202` ↗](../sw-external-terms.md#http-202-accepted) with [`Location` ↗](../sw-external-terms.md#location-header), and MUST NOT call the [payment provider](../terms/payment-provider.md).
- **idempotency-key.C-04** [Job enqueue](../terms/job-enqueue.md) with an existing key MUST create nothing and MUST return the original id with [`created: false`](../terms/enqueue-created-flag.md).
- **idempotency-key.C-05** Under 20 [concurrent enqueue calls](../terms/job-enqueue.md) with one key, exactly one call MUST see [`created: true`](../terms/enqueue-created-flag.md).
- **idempotency-key.C-06** The UI MUST reuse the same key for every retry of one [attempt](../terms/checkout-attempt.md), including after a reload, by keeping the attempt in the tab's [session storage ↗](../sw-external-terms.md#session-storage).
- **idempotency-key.C-07** A repeated request with the same key MUST still count against the route's [rate limit](../terms/rate-limit.md), so the fourth of four identical requests at a limit of 3 gets [`429` ↗](../sw-external-terms.md#http-429-too-many-requests).

## How the capabilities use it
- {{cap:S10}} requires the key on `POST /checkout` (8 to 128 characters) and answers `422 idempotency_key_required` without it.
- {{cap:S13}} requires the key on `POST /payments/intents`, which answers `202` with `Location` and never calls the provider.
- {{cap:S49}} uses the key on enqueue to return the original job id with `created: false` and to give one winner under 20 concurrent calls.
- {{cap:S50}} counts requests that carry a key against the rate limit; the fourth request at a limit of 3 gets `429`.
- {{cap:S54}} defines the `@Idempotent` route declaration and the purge job.
- {{cap:W03}} keeps the attempt key in session storage, so a double press or reload creates one order.

## Known gaps
- The S54 page was given without lines that define the key's storage, its lifetime, the purge schedule, or the reply to a repeated key with a different request body. Rules C-01 and C-07 are inferred only from the lines of S10, S13 and S50.
- S05 and S53 list the concept, but no line links it, so they are not described.
- The 8 to 128 character limit is stated only for `POST /checkout`.

## Used by
<!-- used-by:start -->
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
<!-- used-by:end -->
