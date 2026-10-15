# Data model: S18

## `UsageSettlement` (PostgreSQL, new, `domain:billing`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `subscriptionId` | uuid NOT NULL | FK `Subscription(id)` (same domain) |
| `periodStart` | timestamptz NOT NULL | UTC, start of the billed period |
| `periodEnd` | timestamptz NOT NULL | `> periodStart` |
| `metric` | text NOT NULL | matches the metric allowlist |
| `settledQuantity` | bigint NOT NULL | forward-only, `>= 0`, `<= 2^53-1` |
| `settledAmountMinor` | bigint NOT NULL | forward-only, `>= 0`; equals `price(settledQuantity)` under the snapshot |
| `includedQuantity` | bigint NOT NULL | snapshot at first settlement |
| `overagePer1000Minor` | bigint NOT NULL | snapshot at first settlement |
| `lastInvoiceId` | uuid NOT NULL | FK `Invoice(id)`; idempotency key of `settle` |
| `closed` | boolean NOT NULL DEFAULT false | true once settled at/after `periodEnd + 91 days`; never reopened |
| `createdAt`, `updatedAt` | timestamptz NOT NULL | |

Constraints: `UNIQUE (subscriptionId, periodStart, metric)`; `CHECK (periodEnd > periodStart)`; `CHECK (settledQuantity >= 0 AND settledAmountMinor >= 0)`; `CHECK (includedQuantity >= 0 AND overagePer1000Minor >= 0)`; a trigger (or conditional-update discipline plus a `BEFORE UPDATE` trigger) rejects any update that lowers `settledQuantity` or `settledAmountMinor`, or changes the snapshot, `periodStart`, `periodEnd`, or reopens `closed`. Partial index `(subscriptionId) WHERE closed = false` for `linesFor` and the reconcile job.

State: `open → closed` only. Transitions of values: `settledQuantity` strictly non-decreasing; a zero-amount advance is allowed.

Migration: expand-only, `SET lock_timeout`, create table and indexes, register in `packages/backend/db/ownership.ts` (`UsageSettlement: 'domain:billing'`), backfill for invoices of the last 90 days: one row per `(subscription, periodStart, metric)` of `RENEWAL` invoices with `usageMeasuredAt`, `settledQuantity` = exact total of events with `ingested_at <= usageMeasuredAt`, snapshot from the invoice's price, `settledAmountMinor` = `price(settledQuantity)` (must equal the sum of that invoice's USAGE lines for the metric; a mismatch is logged and the row still uses the recomputed value). `INSERT … ON CONFLICT DO NOTHING` makes it repeatable (AS-48). The ClickHouse read in a Postgres migration is done by a one-off script `scripts/backfill-usage-settlement.ts` run by the migration task; if the usage store is unreachable the backfill fails and is re-runnable.

## `usage_events` (ClickHouse, existing, billing's)

`event_id String` (the envelope `eventId` or `llm:<aggregateId>`), `subject_id`, `metric`, `quantity UInt64`, `ts DateTime64(3,'UTC')`, `ingested_at DateTime64(3,'UTC')`. `ReplacingMergeTree`, `ORDER BY (subject_id, metric, event_id)`. Reads always `FINAL`. No schema change.

## Cached entitlement entry (Redis via `CacheService`)

Key `entitlements:v1:<SHOP|USER>:<subjectId>`; value `{entitlements, subscriptionId | null, subscriptionVersion | null, loadedAt}`; TTL 300 s; stale served up to 60 min on load error.

## Pure types (`domain/`)

- `EntitlementKey` = `freeShipping | earlyAccessDrops | maxProducts | seats | auctions | apiCallsPerMonth | assistantTokensPerMonth`; `LimitKey` = `maxProducts | seats`; `QuotaKey` = `apiCallsPerMonth | assistantTokensPerMonth` with metric map `api.calls`, `llm.assistant.tokens`.
- `FREE_SHOP`, `FREE_BUYER` constants (buyer: `{assistantTokensPerMonth: 200000}`, research R-2).
- `SettlementPlan` = `{entries: [{metric, periodStart, periodEnd, fromQuantity, toQuantity, includedQuantity, overagePer1000Minor}]}`; `UsageLine` = `{kind: 'USAGE'|'ADJUSTMENT', description, quantity, amountMinor}`.
- `UsageRecord` (validated event): `{identity, subjectId, metric, quantity, ts}`; validation errors carry one of `invalid_payload | unknown_metric | ts_in_future | too_old`.

Domain errors (`AppError`, stable `code`): `unknown_entitlement` (400), `too_many_ids` (400), `not_a_limit` (400), `not_a_quota` (400), `invalid_current_value` (400), `entitlements_unavailable` (503), `usage_unavailable` (503), `invalid_input` (400), `amount_out_of_range` (400), `settlement_conflict` (409), `entitlement_required` (403, existing), `entitlement_invalidation_failed` (503).
