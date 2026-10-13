# Event contracts: S14 — `payments` ledger

Definitions use `defineEvent` over zod schemas in `packages/contracts/src/payments/ledger-events.ts`; envelope `{eventId, type, version, occurredAt, aggregateId}` is S53's. Money is `…Minor`. No personal data: ids, references, amounts only (AS-66).

## Produced (outbox → topic `ledger.events`, key = aggregate id)

| Event | Version | Aggregate | Payload |
|---|---|---|---|
| `ledger.journal_posted` | **2** (v1 retired) | `journalId` | `{journalId, kind, currency, postedAt, lines: [{accountId, shard, amountMinor, balanceAfterMinor, balanceVersion}], paymentId?, orderId?}` |
| `ledger.reconciliation_completed` | 1 | `runId` | `{runId, provider, day, status, matched, issueCount}` |
| `ledger.reconciliation_issue_opened` | 1 | `issueId` | `{issueId, runId, day, kind, reference}` |

- `journal_posted` v2 is appended inside the posting's transaction (`OutboxService.append(event, tx)`), with `balanceAfterMinor`/`balanceVersion` of each line taken from the `RETURNING` of its balance update. One event per journal, none for `created:false`. `lines` are in lock order; `shard` appears only here (statements need it).
- `reconciliation_completed` is appended in the transaction that marks the run `COMPLETED`; `reconciliation_issue_opened` once per issue in the promotion transaction (none for auto-resolved or re-checked issues).
- v1 `journal_posted` `{kind, lines:[{accountId, amount}]}`: the balance projector skips it (research R-8). S16/S40 adopt v2 (sibling bullets).

## Consumed

| Topic / group | Event | Handler | Idempotency | Failure |
|---|---|---|---|---|
| `orders.events` / `ledger-settlement` | `order.paid` (definition built from `packages/contracts` `orderEventSchemas['order.paid']`; fields used: `orderId`, `totalMinor`, `currency`, `paymentRef`, `shopOrders[{shopOrderId, shopId, subtotalMinor}]`, `orderVersion`) | `SettlementConsumer.project` → `SettlementService.settle` | `natural`: deterministic `SETTLEMENT` id from the order | invalid payload / currency mismatch → `PermanentError(reason)`, `attempts: 1`, counter, framework DLQ `ledger-settlement.dlq`; sale missing → job chain (research R-6) |
| `ledger.events` / `ledger-balances` | `ledger.journal_posted` v2 | `BalanceProjector.project` | `versionGuard`: a line applies only when `balanceVersion` > stored | invalid payload → framework DLQ; store down → `TransientError` (partition pauses); stale → `ledger_projection_stale_total` |

`aggregateIdSchema` is `z.string().uuid()` on both consumers. The settlement consumer is registered with `ProjectionsModule.forProjectors` in `LedgerWorkerModule`; the balance projector in `LedgerProjectorModule` (hosted by `apps/projector`, exported in `paymentsProjectors`).

## Jobs (registered with S49; each `declareJobType` with a zod contract next to its `JobPayloads` augmentation)

| Job | Payload | Schedule | Options |
|---|---|---|---|
| `payments.reconcile-daily` | `{day?: 'YYYY-MM-DD'}` | `30 2 * * *` UTC | `maxAttempts: 3`, `fleetConcurrency: 1`, lease 10 min with heartbeat |
| `ledger.sweep-hot-accounts` | `{window?: ISO-hour}` | `5 * * * *` | `maxAttempts: 3`, `fleetConcurrency: 1` |
| `ledger.verify-invariants` | `{}` | `15 2 * * *` | `maxAttempts: 3`, `fleetConcurrency: 1` |
| `ledger.ensure-partitions` | `{monthsAhead?: 1–12}` | `0 3 * * 1` | `maxAttempts: 3`, `fleetConcurrency: 1` |
| `ledger.backfill-balances` | `{batch?: 1–5000}` | one-off (enqueued by operator/deploy) | `maxAttempts: 3`, resumable by cursor |
| `ledger.settle-order` | validated `order.paid` payload + `attempt` | enqueued by the consumer | `maxAttempts: 1`; the handler enqueues the next step itself |

`InvalidScheduleError` from `upsertSchedule` is caught at bootstrap and logged with the job name (no generic `Error`). Callers of `JobsService.cancel` (none in this domain) would adapt to the discriminated result.
