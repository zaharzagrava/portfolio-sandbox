---
id: job-scheduler-lease
title: Scheduled jobs and leases
kind: concept
status: draft
defined_by: S49
---
# Scheduled jobs and leases
## Definition
Scheduled jobs and leases let a domain run background and recurring work without owning queues, locks or retry logic. Jobs live in the database. Workers lease them with row-lock skip-locked claims. Failures retry with backoff. One elected leader turns time-zone-aware cron schedules into jobs. A per-shop cap stops one shop from starving the others. The guarantee: each job runs under one live lease, and a stale worker changes nothing.

## Rules
- **job-scheduler-lease.C-01** A job MUST have exactly one [status](../terms/job-status.md) of `QUEUED`, `RUNNING`, `SUCCEEDED`, `DEAD` or `CANCELLED`, and MUST move only along the [legal transitions](../terms/job-status.md).
- **job-scheduler-lease.C-02** [Enqueue](../terms/job-enqueue.md) MUST join the caller's [open transaction](../terms/request-context.md), so the job exists if and only if the caller commits. Without a transaction, it MUST commit before the call returns.
- **job-scheduler-lease.C-03** Enqueue with an existing [idempotency key](../terms/idempotency-key.md) MUST create nothing and return the original id with [`created: false`](../terms/enqueue-created-flag.md). A key reused with a different job type MUST fail with [`IdempotencyKeyConflictError`](../terms/idempotency-key.md).
- **job-scheduler-lease.C-04** Two workers MUST NOT [claim](../terms/job-claim.md) the same job. Every write that ends or changes an [attempt](../terms/job-attempt.md) MUST be [fenced by worker and attempt number](../terms/attempt-fencing.md).
- **job-scheduler-lease.C-05** A thrown error MUST re-queue the job with a [full-jitter](../terms/jitter.md) delay of at most `min(15 min, 1 s × 2^attempts)`. At [`maxAttempts`](../terms/job-max-attempts.md), or on [`NonRetryableJobError`](../terms/non-retryable-job-error.md), the job MUST become [`DEAD`](../terms/job-status.md).
- **job-scheduler-lease.C-06** The [reaper](../terms/job-reaper.md) MUST re-queue (or, at `maxAttempts`, kill) `RUNNING` jobs with expired [leases](../terms/job-lease.md) exactly once, even with several reaper instances, and MUST NOT alter `attempts`.
- **job-scheduler-lease.C-07** A shop MUST NOT have more running jobs than the [per-shop cap](../terms/per-shop-running-cap.md) (default 5) [fleet-wide](../terms/per-shop-running-cap.md). Jobs without a shop MUST NOT be capped.
- **job-scheduler-lease.C-08** Only one [leader](../terms/scheduler-leader.md), chosen per tick by an [advisory lock ↗](../sw-external-terms.md#advisory-lock), MUST [materialise schedules](../terms/cron-schedule-materialisation.md). Each fire MUST use the key [`cron:<name>:<fireAt ISO-8601 UTC with milliseconds>`](../terms/cron-fire-key.md).

## How the capabilities use it
- {{cap:S13}} runs a periodic sweep every 60 s that resolves due `UNKNOWN` payments.
- {{cap:S32}} runs the jobs `search.refresh-popularity`, `search.backfill-shop-state` and `search.retire-previous-index`.
- {{cap:S34}} runs the job `recommendations.build-bought-together`, cron `17 3 * * *`, which builds and publishes all neighbour lists.
- {{cap:S49}} defines the concept: job storage, leases, retries, the reaper, the per-shop cap and the cron leader.

## Known gaps
- S01, S05, S10, S33 and S53 list this concept, but no line in their pages links it. Their use is not stated.
- Facts for the rules on cancel versus claim, key retention (30 days), enqueue limits and cron overlap policy exist in S49 but are not in the eight rules above.

## Used by
<!-- used-by:start -->
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
