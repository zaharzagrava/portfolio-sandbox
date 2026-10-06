  # Consistency, Distributed Transactions, Sagas, Data Synchronization

Consistency models, distributed transactions and sagas, bidirectional sync with legacy systems, ETL from third-party APIs, and reconciliation.

---

## 1. Theory you should state precisely

### CAP
During a **network partition** (P), a system must choose between **Consistency** (linearizable reads) and **Availability** (every non-failed node responds). When there's no partition, CAP says nothing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CassandraVersionedSink`](../../packages/backend/libs/infrastructure/projections/sinks/cassandra-versioned.sink.ts#L15): CassandraVersionedSink applies version-based last-write-wins writes, an availability/eventual-consistency choice for read models. _(cassandra-versioned.sink.ts)_
<!-- theory-links:end -->

### PACELC (a more useful framing)
If **P**artitioned: choose **A** or **C**. **E**lse (normal operation): choose **L**atency or **C**onsistency.
- Postgres with a sync replica is PC/EC. DynamoDB and Cassandra by default are PA/EL (tunable).

### Consistency models (strong → weak)
- **Linearizable**: behaves like a single copy; reads see the latest completed write.
- **Sequential / serializable** (transactions behave as if executed in some serial order).
- **Causal**: causally related operations are seen in order by everyone.
- **Read-your-writes, monotonic reads**: session guarantees, enough for most UX problems (the replica-lag issue).
- **Eventual**: replicas converge if updates stop.

Practical framing: *"Which invariants need strong consistency (money balance, unique username, inventory), and where does eventual consistency with clear UX work (search index, analytics, notifications)?"*

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProjectionCheckpoints`](../../packages/backend/libs/infrastructure/projections/read-your-writes.ts#L19): ProjectionCheckpoints tracks projection versions per aggregate and waits for the read model to catch up, giving read-your-writes. _(read-your-writes.ts)_
> - [`Projector`](../../packages/backend/libs/infrastructure/projections/projector.ts#L7): The Projector interface builds eventually consistent read models from Kafka events, consumed in order per partition. _(projector.ts)_
> - [Shop balance and payout history reads](../../docs/humans/concepts/domain-payments/shop-balance-read-model.md): Shop balances are read from a Redis projection of ledger journals, so they are eventually consistent with the ledger. [`BalanceProjector`](../../packages/backend/libs/domains/payments/infra/balance.projector.ts#L26), [`FinanceController`](../../packages/backend/libs/domains/payments/api/finance.controller.ts#L13)
<!-- theory-links:end -->

---

## 2. Distributed transactions

### Two-phase commit (2PC)
A coordinator asks every participant to **prepare** (vote), then **commit** or abort.
- ❌ Blocking: if the coordinator fails after prepare, participants hold locks indefinitely.
- ❌ Latency, and a hard availability coupling between all participants.
- ❌ Most modern services (SaaS APIs, SQS, many NoSQL stores) don't support XA anyway.
- Postgres supports `PREPARE TRANSACTION`, but it's rarely used in microservices.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Atomic write of aggregates and consumer offset in one Kafka transaction](../../docs/humans/concepts/domain-marketing/transactional-offset-commit.md): Aggregates and consumer offsets are committed in one Kafka transaction, which is atomic commit across two resources without 2PC. [`ClickAggregator`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L43)
<!-- theory-links:end -->

### Sagas: the standard alternative
A sequence of **local transactions**, each publishing an event or triggering the next step. If a step fails, run **compensating transactions** for the steps already completed.

**Orchestration** (a central coordinator):
```
OrderSaga orchestrator:
  1. Reserve inventory   → ok
  2. Charge payment      → FAIL
  3. Compensate: release inventory
  4. Mark order failed
```
- ✅ Flow is explicit in one place, easier to reason about, monitor, and version. Tools: Temporal, AWS Step Functions, or a state machine in your DB.
- ❌ The orchestrator is extra infrastructure and a central dependency.

**Choreography** (services react to each other's events):
```
OrderCreated → Inventory reserves → InventoryReserved → Payment charges → PaymentFailed → Inventory releases
```
- ✅ Loose coupling, no central component.
- ❌ The flow is implicit and spread across services, hard to debug, and risks cyclic dependencies. Works for 2–4 steps.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OrderPaymentListener`](../../packages/backend/libs/domains/orders/infra/order-payment.listener.ts#L23): OrderPaymentListener is the saga step that reacts to the payment response and updates order status. _(order-payment.listener.ts)_
> - [`ExecutePayment`](../../packages/payments/internal/payment/service.go#L46): ExecutePayment charges Stripe, decrements stock and records the ledger, with a refund as the compensation when stock runs out. _(service.go)_
> - [Refund when stock runs out after charging](../../docs/humans/concepts/domain-payments/refund-saga.md): If stock runs out after the card is charged, the service refunds the charge and marks the payment REFUNDED. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
<!-- theory-links:end -->

### Saga design concerns
- Compensations are **semantic undo**, not rollback: a refund isn't "un-charging", and an email can't be unsent. Some steps are **pivot** steps (point of no return) and others are retriable.
- **Isolation is missing**: other transactions see intermediate states. Countermeasures: **semantic locks** (`status = 'PENDING'`), commutative updates, re-reading values, ordering steps so the risky ones come last.
- Every step and compensation must be **idempotent** and retriable.
- Persist the saga state, because the orchestrator can crash mid-flow.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Insert that silently skips when the idempotency key already exists](../../docs/humans/concepts/domain-payments/insert-on-conflict-do-nothing.md): The payment row is inserted as PENDING with ON CONFLICT DO NOTHING, which acts as a semantic lock and makes the step idempotent. [`executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L53)
> - [UNKNOWN status: provider call timed out](../../docs/humans/concepts/domain-payments/unknown-status.md): The UNKNOWN status covers a provider timeout where the outcome is unclear, and a later job settles it. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33), [`Payment`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L23)
> - [`RESERVATION_HOLD_MS`](../../packages/backend/libs/domains/orders/application/checkout.service.ts#L24): RESERVATION_HOLD_MS holds stock for 15 minutes as a reservation, after which an expiry job releases it. _(checkout.service.ts)_
<!-- theory-links:end -->

---

## 3. Bidirectional synchronization

The two hard problems are infinite sync loops and conflicting edits:

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SyncService`](../../packages/backend/libs/domains/catalog-sync/application/sync.service.ts#L23): SyncService implements offline-first push/pull sync with HLC-based conflict resolution. _(sync.service.ts)_
> - [`IntegrationSyncService`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L37): IntegrationSyncService syncs products with external providers in both directions: incremental pulls, webhooks and outbound stock pushes. _(integration-sync.service.ts)_
<!-- theory-links:end -->

### 3.1 Change detection
- **CDC** from the DB log (Debezium, logical replication): captures every change, including ones made outside the app.
- **Triggers** writing to a changes table: simple, works on legacy DBs, adds write overhead.
- **Application events** (outbox): only captures changes that go through the app.
- **Polling by `updated_at`**: simplest; misses hard deletes and is vulnerable to clock or transaction-commit-order issues (use an overlap window).

### 3.2 Loop prevention (echo suppression)
A change in A syncs to B, B's change detector sees it as a "new change" and syncs it back to A, and so on forever.
- **Origin tagging**: each change carries `source_system`. A sync writer sets something like `last_modified_by = 'sync'` (or a session variable that the trigger reads: `SET LOCAL app.sync_origin = 'legacy'`), and the change detector **skips changes whose origin is the sync process itself**.
- **Version/hash comparison**: store the last synced hash per record per direction. If the incoming payload hash equals what we last wrote, it's an echo, so skip it.
- **Idempotent writes**: writing the same value twice should be a no-op that doesn't emit a change event (compare before update: `UPDATE ... WHERE (a, b) IS DISTINCT FROM ($1, $2)`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StockPushProjector`](../../packages/backend/libs/domains/catalog-sync/infra/integrations.workers.ts#L61): StockPushProjector pushes stock updates to providers with echo suppression, so changes that came from the provider are not pushed back. _(integrations.workers.ts)_
> - [`syncHash`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L33): syncHash is a SHA256 of the product metadata, so unchanged records are skipped instead of echoed. _(integration-sync.service.ts)_
<!-- theory-links:end -->

### 3.3 Conflict resolution (both sides changed the same record)
| Strategy | How | Trade-off |
|---|---|---|
| **System of record per field/entity** | e.g., legacy owns `cost_center`, new system owns `project_budget` | simplest, deterministic; requires clear ownership agreement ← usually the best answer |
| Last-writer-wins (LWW) | compare timestamps | clock skew; silently loses data |
| Version vectors | detect concurrent edits precisely | complex |
| Field-level merge | merge non-overlapping field changes | needs per-field change tracking |
| Manual resolution queue | flag conflicts for humans | slow, but right for financial data |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`winningFields`](../../packages/backend/libs/domains/catalog-sync/domain/merge.ts#L19): winningFields decides which fields win in LWW conflict resolution by comparing HLC timestamps. _(merge.ts)_
> - [`SyncOp`](../../packages/backend/libs/domains/catalog-sync/domain/merge.ts#L9): SyncOp models stock adjustment, stock count and product update operations that carry HLC timestamps for merging. _(merge.ts)_
<!-- theory-links:end -->

### 3.4 Mapping and identity
- An **ID mapping table**: `(entity_type, new_id, legacy_id, last_synced_at, last_synced_hash_new, last_synced_hash_legacy)`.
- Translate schemas through an anti-corruption layer (DDD), so legacy concepts don't leak into the new domain model.

### 3.5 Reliability
- Queue-based with retries and a DLQ. Changes per entity are applied in order (partition by entity ID).
- **Reconciliation job** (nightly): compare record counts and hashes per entity on both sides, report and auto-fix drift. This is what turns "eventually consistent" into **provably consistent**.
- Monitoring: sync lag, error rate, conflict count, drift count from reconciliation.
- **Exit plan**: bidirectional sync is a migration-phase tool (Strangler Fig pattern). Define when the legacy system becomes read-only.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IntegrationWorkers`](../../packages/backend/libs/domains/catalog-sync/infra/integrations.workers.ts#L21): IntegrationWorkers runs sync on task queues and scheduled pull and reconcile jobs. _(integrations.workers.ts)_
> - [Daily Stripe reconciliation](../../docs/humans/concepts/domain-payments/daily-reconciliation.md): A nightly job streams Stripe charges and compares them with Payment records, recording mismatches. [`ReconciliationJobs`](../../packages/backend/libs/domains/payments/infra/reconciliation.jobs.ts#L24)
<!-- theory-links:end -->

---

## 4. ETL / incremental sync from external APIs

```
watermark = load_checkpoint('crm.deals')                       # e.g., 2026-09-30T10:00:00Z
page through GET /deals?modified_since={watermark - 5min overlap}
  upsert by external_id (idempotent: ON CONFLICT (external_id) DO UPDATE ... WHERE excluded.modified_at > deals.modified_at)
  advance in-memory max(modified_at)
commit checkpoint = max(modified_at) only after the batch is durably stored
```
- **Overlap window**, because of clock skew and records committed late with older timestamps. It's safe thanks to idempotent upserts.
- **Deletes**: APIs often don't return deleted records. Use the provider's "deleted" endpoint or webhooks, or detect them in a **full reconciliation** (set difference of IDs), and soft-delete locally.
- **Rate limits**: see the API doc (distributed token bucket, Retry-After, backoff).
- **Schema drift**: validate responses (zod). Unknown fields go into a `raw jsonb` column so you can backfill later without re-fetching.
- **Backfills vs incremental**: separate job types. A backfill must not starve incremental syncs (separate queues or priorities).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IntegrationSyncService`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L37): IntegrationSyncService does incremental sync with watermark tracking, webhooks and reconciliation. _(integration-sync.service.ts)_
> - [`BACKFILL_QUEUE`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L19): BACKFILL_QUEUE keeps the initial full import separate from incremental sync. _(integration-sync.service.ts)_
> - [`SYNC_QUEUE`](../../packages/backend/libs/domains/catalog-sync/application/integration-sync.service.ts#L18): SYNC_QUEUE carries incremental and webhook-triggered sync jobs. _(integration-sync.service.ts)_
<!-- theory-links:end -->

---

## 5. Reconciliation

General pattern:
1. Two sources: expected (computed from your model) and actual (bank, invoice system, ledger).
2. Normalize them (currency, rounding, period boundaries, time zones!).
3. Match by key (transaction reference), then by fuzzy rules (amount + date ± tolerance).
4. Classify: matched, missing on A, missing on B, amount mismatch.
5. Report and alert. Auto-correct only when the rules are clear; everything else goes to human review.
6. **Period close**: freeze a period once reconciled. Later corrections go in as **adjustment entries in the current period** referencing the original period (never mutate closed periods). This links up with the as-of reporting design.

Multi-period example: quarterly volume rebates paid monthly as advances. At quarter end, compute the true quarterly amount, subtract the advances paid, and post the delta as an adjustment. Yearly works the same over quarters. Invariants: `sum(monthly advances) + adjustments == computed quarterly total`, checked automatically.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [The three types of reconciliation mismatches](../../docs/humans/concepts/domain-payments/reconciliation-issue-kinds.md): Reconciliation classifies three mismatch types between Stripe charges and Payment records. [`ReconciliationJobs`](../../packages/backend/libs/domains/payments/infra/reconciliation.jobs.ts#L24)
> - [Daily reconciliation against the raw click log](../../docs/humans/concepts/domain-marketing/daily-reconciliation.md): reconcileDay recounts each billed ad hour from the raw click log and fixes differences with a charge or an ADJUSTMENT journal. [`ad-billing.jobs.ts`](../../packages/backend/libs/domains/marketing/infra/ad-billing.jobs.ts), [`ad-billing.jobs.ts`](../../packages/backend/libs/domains/marketing/infra/ad-billing.jobs.ts)
> - [ReconciliationRun: the idempotence mechanism](../../docs/humans/concepts/domain-payments/reconciliation-run-model.md): A ReconciliationRun row per provider and day makes reruns of the daily job safe. [`ReconciliationJobs`](../../packages/backend/libs/domains/payments/infra/reconciliation.jobs.ts#L24)
<!-- theory-links:end -->

---

## 6. Clocks and ordering

- Wall clocks drift and jump (NTP). Don't use them to order events across machines.
- Use **logical clocks** (Lamport timestamps) for causality, **version numbers per aggregate** (the simple, practical choice), or hybrid logical clocks (CockroachDB).
- Postgres: `bigserial` sequences or commit-ordered change tables, not `now()`, for "what changed since".

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Hlc`](../../packages/backend/libs/domains/catalog-sync/domain/hlc.ts#L8): Hlc holds physical milliseconds, a logical counter and a node id, giving hybrid logical clocks for ordering. _(hlc.ts)_
> - [`receive`](../../packages/backend/libs/domains/catalog-sync/domain/hlc.ts#L27): receive merges local and remote clocks while preserving causality. _(hlc.ts)_
> - [`MAX_DRIFT_MS`](../../packages/backend/libs/domains/catalog-sync/domain/hlc.ts#L37): MAX_DRIFT_MS rejects clocks more than 60 seconds out of range. _(hlc.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How would you implement a cross-service operation like "create invoice, then charge, then notify"?**
A saga, orchestrated if there are several steps, with persisted state. Each step is a local transaction plus an outbox event, every step is idempotent, and compensations exist for steps that can be undone. A pending status acts as a semantic lock, and the irreversible step comes last. Monitor stuck sagas.

**Q: How do you avoid loops in bidirectional sync?**
Origin tagging: the sync writer marks its own writes, and the change detector ignores them. Last-synced hashes per direction detect echoes. Updates are skipped when nothing actually changed. Conflicts are resolved by field-level ownership (each field has one system of record), and a nightly reconciliation catches drift.

**Q: When is eventual consistency unacceptable?**
For invariants that must never be violated, even briefly: account balance can't go negative, no double booking, unique constraints, double spending. Enforce those inside one strongly consistent store (a transaction or constraint) and make everything else eventually consistent.
