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
- {{cap:J01}} Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified
- {{cap:J03}} Launch day: waiting room and seat booking, flash-sale purchase without overselling, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S04}} Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S06}} Collaborative listing drafts - real-time co-editing, versions, publish to a product
- {{cap:S07}} Bulk catalog import (multipart upload, malware scan, streamed parse, checkpoints and leases, error report)
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S11}} Flash sales (scheduled drops, bucketed fast stock, admission, never oversell, async reconciliation)
- {{cap:S12}} Order export (streamed CSV to object storage, live progress, fenced worker, retention)
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S15}} Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states
- {{cap:S16}} Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation
- {{cap:S17}} Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
- {{cap:S18}} Usage metering (late events, adjustments) and entitlement checks
- {{cap:S20}} Same-day courier dispatch (courier shift, offers, delivery state machine, tracking)
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:S22}} Launch-event booking (waiting room, admission tokens, seat holds, booking confirm, seat map, ticket limits)
- {{cap:S23}} Live launch stream (sampled comment batches, reactions, moderation, pinned commerce)
- {{cap:S24}} Product chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push)
- {{cap:S28}} Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression
- {{cap:S29}} Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
- {{cap:S30}} Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S36}} Sponsored listings (campaigns, signed click tokens, click counting, hourly billing, daily reconciliation)
- {{cap:S37}} Share and affiliate short links (codes, aliases, redirects, click attribution)
- {{cap:S38}} Feature flags and remote config (targeting, percentage rollout, local evaluation, kill switch, audit)
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S43}} Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
