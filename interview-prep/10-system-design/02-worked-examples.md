# System Design: Worked Examples

Each example follows the framework: requirements → estimates → API/data → design → deep dives → trade-offs.

---

## Example 1: Ledger / payment processing service

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Recording money in the ledger](../../docs/humans/concepts/domain-payments/recording-money-in-ledger.md): LedgerService posts balanced double-entry journals as immutable LedgerEntry rows and emits a journal_posted event in the same transaction. [`ledger.service.ts`](../../packages/backend/libs/domains/payments/application/ledger.service.ts), [`recordMarketplaceSale`](../../packages/backend/libs/domains/payments/application/ledger.service.ts#L28)
> - [`PaymentService`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L29): PaymentService orchestrates payment processing with Stripe, idempotency and ledger accounting. _(payment.service.ts)_ · [Charging a card through Stripe](../../docs/humans/concepts/domain-payments/charging-a-payment.md)
<!-- theory-links:end -->

### Requirements
- Record money movements between accounts (internal + external bank transfers), show balances and history, export for audit.
- Non-functional: **no money created or lost**, no double execution, full audit trail, 99.95% availability for writes, balance reads < 100 ms p99. ~50 TPS peak, growing 10×.

### Data model (double-entry)
```sql
accounts(id, owner_id, currency, type, created_at)
transactions(id uuid PK, idempotency_key UNIQUE, type, status, created_at, external_ref UNIQUE NULL)
entries(id bigserial, transaction_id FK, account_id FK, amount_minor bigint, direction CHECK in ('debit','credit'), created_at)
-- invariant per transaction: sum(debits) = sum(credits)  (validated in the same DB tx; deferred constraint trigger)
account_balances(account_id PK, balance_minor bigint, version bigint)   -- derived, updated in same tx
```
- Entries are **append-only**. Corrections are reversal transactions.
- Balance: either summed on the fly (too slow at scale) or a **materialized balance row** updated in the same transaction with `UPDATE ... SET balance = balance + $x` (an atomic update, plus a `CHECK (balance >= 0)` for accounts that can't go negative).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LedgerEntry`](../../packages/backend/libs/domains/payments/infra/models/ledger-entry.model.ts#L85): LedgerEntry is the immutable, append-only double-entry ledger row model. _(ledger-entry.model.ts)_ · [Recording money in the ledger](../../docs/humans/concepts/domain-payments/recording-money-in-ledger.md)
> - [Signed BIGINT amount in cents: positive = credit, negative = debit](../../docs/humans/concepts/domain-payments/ledger-amount-convention.md): Amounts are stored as signed BIGINT cents, positive for credit and negative for debit. [`amount`](../../packages/backend/libs/domains/payments/infra/models/ledger-entry.model.ts#L50)
> - [Redis balance projection from ledger events](../../docs/humans/concepts/domain-payments/balance-projection.md): BalanceProjector keeps a Redis balance projection updated atomically per journal from ledger events. [`BalanceProjector`](../../packages/backend/libs/domains/payments/infra/balance.projector.ts#L26)
<!-- theory-links:end -->

### Flow: external transfer
```
POST /transfers (Idempotency-Key)
  → tx: create transaction(status=PENDING) + entries (debit user, credit "bank-clearing" account) + outbox(TransferRequested)
  → outbox relay → SQS → bank worker
      → call bank API with our transaction.id as bank reference (bank-side idempotency)
      → success: tx: status=COMPLETED + outbox(TransferCompleted)
      → definitive failure: tx: reversal entries + status=FAILED
      → unknown (timeout): status=UNKNOWN → query bank status by reference with backoff; never blindly resend
  → daily reconciliation: bank statement vs clearing account entries → mismatches to finance queue
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Settling the payment and recording the ledger](../../docs/humans/concepts/domain-payments/settle-method.md): Payments stuck in UNKNOWN are settled atomically by querying Stripe, recording the ledger and publishing via the outbox. [`PaymentResolutionJobs`](../../packages/backend/libs/domains/payments/infra/payment-resolution.jobs.ts#L29)
> - [Insert that silently skips when the idempotency key already exists](../../docs/humans/concepts/domain-payments/insert-on-conflict-do-nothing.md): executePayment starts with an insert that silently skips if the idempotency key already exists, creating the PENDING payment. [`executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L53)
> - [`PayoutJobs`](../../packages/backend/libs/domains/payments/infra/payout.jobs.ts#L33): PayoutJobs handles weekly payouts and Stripe Connect transfers with error recovery. _(payout.jobs.ts)_ · [Weekly seller payouts](../../docs/humans/concepts/domain-payments/weekly-seller-payouts.md)
<!-- theory-links:end -->

### Deep dives
- **Concurrency**: two withdrawals at once: `SELECT ... FOR UPDATE` on the balance row, or an atomic conditional update. Lock account rows in a consistent order (sorted IDs) to avoid deadlocks on transfers between two internal accounts.
- **Exactly-once effect**: idempotency key (API), unique `external_ref` (bank), inbox dedupe (consumer), status-based state machine with guarded transitions (`UPDATE ... WHERE status = 'PENDING'`).
- **Scaling**: partition `entries` by month; hot accounts (e.g. a fee account that every transaction touches) become a lock contention point, so shard them into N sub-accounts or batch-aggregate.
- **Audit**: immutable entries, `created_by`, bitemporal reporting for "as known at" questions, Object Lock S3 exports.
- **Money**: integer minor units, currency per account, FX as explicit transactions with a stored rate.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Exactly-once guarantee with UUIDv5, advisory lock, and existence check](../../docs/humans/concepts/domain-payments/exactly-once-settlement.md): A deterministic UUIDv5 journalId, an advisory lock and an existence check make settlement journals post exactly once. [`SettlementListener`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L23)
> - [Posting one balanced journal](../../docs/humans/concepts/domain-payments/post-journal.md): A journal is validated to sum to zero and its lines are inserted atomically in a single transaction. [`ledger.service.ts`](../../packages/backend/libs/domains/payments/application/ledger.service.ts)
> - [Deterministic journal id for the follow-up step of a payout](../../docs/humans/concepts/domain-payments/derive-journal-id.md): deriveJournalId produces a fixed UUIDv5 so a retried payout step cannot post twice. [`deriveJournalId`](../../packages/backend/libs/domains/payments/infra/payout.jobs.ts#L98), [`PAYOUT_NS`](../../packages/backend/libs/domains/payments/infra/payout.jobs.ts#L137)
<!-- theory-links:end -->

---

## Example 2: A/B testing platform with reliable event ingestion

### Requirements
- Define experiments with variants and traffic allocation, assign users consistently, track exposures and conversions, compute results.
- Non-functional: assignment adds < 5 ms; event ingestion handles peaks (say 2k events/s); **no lost or duplicated analytics events** (or at least measured and bounded); results within an hour.

### Assignment
- **Deterministic hashing**: `bucket = murmurhash(experimentId + ':' + userId) % 10000`, mapped to variant ranges. No DB lookup, stable across devices for logged-in users. Anonymous users get a first-party cookie ID, assigned in edge middleware for cacheable pages.
- Hashing on experiment ID + user ID gives each experiment independent assignment (no correlated buckets between experiments). Use layers or exclusion groups for mutually exclusive experiments.
- Config is cached in-process and refreshed periodically or via pub/sub. A kill switch sends everyone to control.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`assign`](../../packages/backend/libs/domains/experimentation/domain/experiments.ts#L18): assign maps a unit to an experiment variant via layer and variant bucket hashing. _(experiments.ts)_
> - [`bucketOf`](../../packages/backend/libs/domains/experimentation/domain/evaluator.ts#L53): bucketOf computes a stable hash bucket in [0,10000) for consistent assignment. _(evaluator.ts)_
<!-- theory-links:end -->

### Event pipeline
```
Browser: batch events in memory → flush every 5s / 20 events / on visibilitychange via navigator.sendBeacon
  → POST /events (ingest API: validate schema, enrich with server timestamp, user-agent, experiment assignments)
  → respond 202 fast → push to queue (SQS / Kafka)
  → consumer: dedupe by event_id (client-generated UUID) → write batches to warehouse / ClickHouse / Postgres partitioned table
```
- **Reliability**: client retries with the same `event_id`; server dedupes. The queue absorbs peaks. DLQ for invalid events. Backend-originated events (purchase confirmed) are emitted from the server via the **outbox** (more trustworthy than client events: ad blockers, tab closes).
- **Exposure logging**: log when the user *actually sees* the variant, not at assignment. Otherwise dilution biases the results.
- **Analysis**: conversion per variant, significance testing (or sequential/Bayesian to allow peeking), and the **Sample Ratio Mismatch (SRM)** check: a chi-square test that the observed split matches the configured split. SRM means the data is broken (bot filtering, redirect losses, assignment bugs).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AnalyticsService`](../../packages/backend/libs/domains/experimentation/application/analytics.service.ts#L13): AnalyticsService ingests events, logs exposures and runs SRM checks. _(analytics.service.ts)_
> - [`srmCheck`](../../packages/backend/libs/domains/experimentation/domain/stats.ts#L76): srmCheck detects sample ratio mismatch with a chi-square test on exposure counts. _(stats.ts)_
> - [`DomainEventsService`](../../packages/backend/libs/infrastructure/events/domain-events.service.ts#L15): DomainEventsService records domain events to the outbox transactionally. _(domain-events.service.ts)_
<!-- theory-links:end -->

### Trade-offs
- Client-side vs server-side assignment (flicker vs complexity). Server or edge assignment avoids flicker.
- Build vs buy (GrowthBook, Statsig, LaunchDarkly, PostHog).

---

## Example 3: Distributed rate limiter

### Requirements
Limit API calls per API key (e.g. 100/min with bursts of 20), across 30 API pods, adding < 2 ms of latency, and stay highly available.

### Design
- **Token bucket in Redis** with an atomic Lua script (see the Redis doc). Key: `rl:{apiKey}`. TTL so idle keys expire.
- Pods call Redis per request (~0.5 ms). To reduce load: a **local pre-check** (each pod gets a share of the budget, synced periodically). Less accurate but cheaper.
- Response headers: `RateLimit`, `Retry-After`, 429 with Problem Details.
- **Failure mode**: Redis is down → **fail open** (allow, with a local in-memory fallback limiter per pod) for availability, or **fail closed** for expensive or abuse-prone endpoints. Make it a deliberate per-endpoint decision.
- Redis Cluster with hash tags if a multi-key script is needed. Hot API keys hit one shard; that's acceptable because each operation is cheap.
- Layering: edge/WAF IP limits (DDoS) → gateway per-key limits → app per-tenant business limits (e.g. 5 report exports/hour).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RateLimiterService`](../../packages/backend/libs/infrastructure/rate-limit/rate-limiter.service.ts#L15): RateLimiterService enforces distributed Redis rate limits with local caching and fallback. _(rate-limiter.service.ts)_
> - [`RateLimitPolicy`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L4): RateLimitPolicy defines algorithm, limit, window, fail-mode and local-lease fraction. _(rate-limit.types.ts)_
> - [`RateLimitDecision`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L21): RateLimitDecision reports allowed, remaining, retryAfterMs and whether the source was redis, local, fallback or closed. _(rate-limit.types.ts)_
<!-- theory-links:end -->

---

## Example 4: Notification system (email/SMS/push)

### Requirements
Services trigger notifications. Respect user preferences, quiet hours, and per-channel rate limits. Retries, dedupe, templating, delivery status tracking. ~10M notifications/day (~115/s avg, peaks of 2k/s).

### Design
```
Producers ──(event: user.invited, invoice.paid)──► Notification API / topic
  → Notification service: resolve recipients, check preferences/opt-outs, render template (i18n), dedupe (key = event_id+user+channel)
  → per-channel queues (email, sms, push) — separate so SMS provider outage doesn't block email (bulkhead)
  → channel workers: provider rate limits (token bucket), retries w/ backoff, failover provider (SES → SendGrid)
  → delivery status webhooks from providers (signed) → status table → analytics
```
- Priority queues: transactional (password reset) separate from marketing.
- Scheduling: quiet hours / time zone → delayed delivery (SQS delay up to 15 min; longer via EventBridge Scheduler or a DB `send_at` + SKIP LOCKED poller).
- Idempotency at the provider level where supported. Dedupe table with TTL.
- Compliance: unsubscribe links, suppression lists (bounces/complaints).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`NotificationWorkers`](../../packages/backend/libs/domains/notifications/infra/notification-workers.service.ts#L25): NotificationWorkers consume SQS queues and deliver with deduplication and rate limiting. _(notification-workers.service.ts)_
> - [`deliveryIdFor`](../../packages/backend/libs/domains/notifications/application/notification-router.service.ts#L32): deliveryIdFor generates deterministic delivery IDs from the dedupe key, user and channel. _(notification-router.service.ts)_
> - [`NotificationRouter`](../../packages/backend/libs/domains/notifications/application/notification-router.service.ts#L46): NotificationRouter applies frequency caps and quiet hours across channels. _(notification-router.service.ts)_
<!-- theory-links:end -->

---

## Example 5: As-of (historical) reporting

### Requirements
Reconstruct prices, plan terms, and customer entitlements for any past date. Audits need "as it was known at the time" as well as "corrected history". Reports over 5 years of data, < 5 s for typical queries.

### Design
- **Bitemporal tables** for slowly changing entities (price lists, plan terms, entitlements): `valid_period tstzrange`, `recorded_period tstzrange`, exclusion constraints to prevent overlaps, GiST indexes.
- **Immutable fact tables** for events (orders, invoices, payments), partitioned by month.
- Query "as of D (as known at K)": `WHERE valid_period @> D AND recorded_period @> K`.
- **Period snapshots**: at month close, materialize aggregates (revenue per plan per month) into snapshot tables. Reports read snapshots for closed periods and compute live only for open periods. Late corrections become **adjustment rows** in the current period, referencing the original period, so closed numbers never silently change.
- Heavy analytics: replicate to a warehouse (CDC) when OLTP load becomes a concern.
- Validation: reconciliation of snapshot totals against the source of truth, and golden datasets.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CommissionRateService`](../../packages/backend/libs/domains/statements/application/commission-rate.service.ts#L34): CommissionRateService manages bitemporal commission rates with rateAsOf and history queries. _(commission-rate.service.ts)_
> - [`StatementService`](../../packages/backend/libs/domains/statements/application/statement.service.ts#L33): StatementService computes seller statements using bitemporal rate lookups and retroactive adjustments. _(statement.service.ts)_
<!-- theory-links:end -->

---

## Example 6: Multi-step form with staged answers, a quick sketch

- Clients answer step by step → `PATCH /sessions/:id/answers` writes to **Redis hash** (TTL refreshed) → on submit: validate completeness → **one transaction**: bulk insert answers + create result record + outbox(FormSubmitted) → worker computes the result (CPU-heavy: worker pool / separate deployment) → result available (poll/SSE) → email notification.
- Scale concerns: the Redis memory budget, Next.js SSR at the edge/CDN for the static question content, DB indexes on hot read paths (results by user), and HPA on the API vs the worker separately.
- Failure: Redis loss = the user re-answers (acceptable; explain why); the final submission is idempotent (`UNIQUE(session_id)`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OnboardingSessionService`](../../packages/backend/libs/domains/seller-onboarding/application/onboarding-session.service.ts#L20): OnboardingSessionService manages questionnaire drafts and the submission workflow. _(onboarding-session.service.ts)_
> - [`AnswersSchema`](../../packages/backend/libs/domains/seller-onboarding/domain/questionnaire.ts#L36): AnswersSchema validates all questionnaire answers on submit. _(questionnaire.ts)_
<!-- theory-links:end -->
