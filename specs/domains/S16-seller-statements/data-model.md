# Data model: S16 — Seller statements

All tables are in `public`, owned by `domain:statements` in `packages/backend/db/ownership.ts`, with no foreign key to another domain. Cross-domain references are plain UUID columns. Money is `BIGINT`, named `…Minor` in the API; legacy column names (`gross`, `commission`, `net`, `lines`, `commissionDelta`) stay until the contract migration and are renamed in the API only (AS-78).

## Existing tables (expand)

| Table | Change |
|---|---|
| `CommissionRate` | `+ changeId UUID NOT NULL` (backfill: `id`), `+ recordedBy UUID NULL`, `+ reason` made `NOT NULL` for new rows via check `char_length(reason) BETWEEN 1 AND 200` (legacy rows keep their text); category stored lower-cased (backfill `lower(btrim(category))`); index `(shopKey, category, "recordedPeriod")` for history keyset `(lower("recordedPeriod") desc, id desc)`. Exclusion constraint unchanged. |
| `AccountingPeriod` | `status` check widened to `OPEN|CLOSING|CLOSED`; `+ knowledgeCutoff TIMESTAMPTZ NULL` (backfill `closedAt` for `CLOSED`); `+ shopCount INTEGER NULL`; `+ runId UUID NULL`; trigger `statements_period_guard` (see below). |
| `StatementSnapshot` | `+ knowledgeCutoff TIMESTAMPTZ NOT NULL` (backfill `computedAt`); `+ payoutsPaidMinor BIGINT NOT NULL DEFAULT 0`; `+ adjGrossMinor, adjCommissionMinor, adjLineCount, adjPayoutsMinor` (adjustments booked in the month, frozen); `+ runId UUID NULL`. Legacy `gross/commission/net/lines/computedAt` kept. Trigger `statements_snapshot_guard`. |
| `StatementAdjustment` | `+ causeKind TEXT NOT NULL` (`rate_change`, `late_sale`, `late_payout`; backfill `rate_change`), `+ causeRef TEXT NOT NULL` (backfill `'legacy:'||reason`), `+ grossDeltaMinor, lineCountDelta, payoutsPaidDeltaMinor` (default 0; legacy `commissionDelta` mirrored to `commissionDeltaMinor`); new unique `(shopId, refersToMonth, causeKind, causeRef)`; old `UNIQUE(shopId, refersToMonth, reason)` dropped in the **contract** step. Trigger `statements_adjustment_guard` (no UPDATE/DELETE). |

## New tables (expand)

| Table | Key and columns | Notes |
|---|---|---|
| `StatementSaleFact` | PK `(orderId, lineId, orderVersion)`; `shopId UUID`, `productId UUID`, `category TEXT` (normalised), `quantity INT`, `unitPriceMinor`, `discountMinor`, `lineTotalMinor BIGINT`, `paidAt TIMESTAMPTZ`, `recordedAt TIMESTAMPTZ` (= `occurredAt`), `appliedAt TIMESTAMPTZ`, `eventId UUID` | No buyer column. Index `(shopId, paidAt, orderId, lineId)`. Check `lineTotalMinor = quantity*unitPriceMinor - discountMinor`, `0 ≤ lineTotalMinor ≤ 1000000000000`. Unpartitioned now; partition by `paidAt` month when the table passes ~200M rows (the key already contains the needed columns for a `paidAt`-first re-key via expand/contract). |
| `StatementPayoutFact` | PK `payoutId UUID`; `shopId`, `amountMinor`, `paidAt`, `payoutVersion INT`, `recordedAt`, `appliedAt`, `eventId` | Version-guarded upsert (`WHERE payoutVersion < EXCLUDED.payoutVersion`). Index `(shopId, paidAt)`. |
| `StatementLedgerFact` | PK `journalId UUID`; `orderId UUID NULL`, `postedAt`, `recordedAt`, `appliedAt`, `eventId` | Kind `SALE` only; immutable by `ON CONFLICT DO NOTHING`. Index `(orderId)`. |
| `StatementLedgerCredit` | PK `(journalId, accountId)`; `amountMinor BIGINT` | `accountId` is `SHOP_<uuid>` or `PLATFORM_FEES`; only credit lines (positive) kept; no shard stored (AS-57). |
| `StatementStreamWatermark` | PK `stream TEXT` (`orders|payouts|ledger`); `appliedThrough TIMESTAMPTZ`, `updatedAt` | Updated by each projector batch in the batch transaction: `appliedThrough = least(max occurredAt applied, ...)` when lag > 0; set to `clock.now() − 5 s` when the consumer-lag read says the partition is caught up (idle topic). Read by close checks, `GET /admin/accounting-periods/:month` and `dataAsOf`. |
| `StatementPeriodRun` | PK `runId UUID`; `month DATE`, `status` (`RUNNING|COMPLETED|FAILED`), `knowledgeCutoff`, `failureCode TEXT NULL`, `details JSONB NULL`, `batchesWritten INT`, `shopsWritten INT`, `startedAt`, `finishedAt NULL` | Partial unique index on `(month) WHERE status = 'RUNNING'`. |
| `StatementPeriodHistory` | PK `id UUID`; `month`, `fromStatus`, `toStatus`, `runId NULL`, `actor TEXT`, `at` | One row per transition (III.7). |
| `StatementFinding` | PK `id UUID`; `month`, `kind`, `shopId NULL`, `expectedMinor`, `actualMinor`, `differenceMinor`, `status` (`OPEN|CLEARED`), `openedAt`, `clearedAt NULL` | Unique `(month, kind, coalesce(shopId, '00000000-…'))`; keyset index `(month, openedAt desc, id desc)`. |

Technical tables used through their libs only: outbox (`outbox.append`), inbox (`InboxService`), job queue (`JobsService`), idempotency keys (`@Idempotent`).

## Store functions and triggers (registered in `ownership.ts`)

| Object | Rule |
|---|---|
| `statements_period_guard` (BEFORE UPDATE/DELETE on `AccountingPeriod`) | Allows exactly `OPEN→CLOSING`, `CLOSING→CLOSED`, `CLOSING→OPEN`; rejects every other status change and every DELETE (AS-34, AS-37). |
| `statements_snapshot_guard` (BEFORE UPDATE/DELETE on `StatementSnapshot`) | UPDATE always rejected; DELETE rejected when the month's period is `CLOSED` (a failed or restarted run may clear its own unpublished rows). |
| `statements_adjustment_guard` | UPDATE and DELETE always rejected. |
| `CommissionRate_no_overlap_current` | Existing exclusion constraint (AS-05). |

The tamper tests (AS-37, AS-75) use a test-only privileged helper that disables the trigger inside one session (`ALTER TABLE … DISABLE TRIGGER`) and re-enables it; production code never does.

## State machine

`OPEN → CLOSING` (close requested; sets `knowledgeCutoff`, `runId`) · `CLOSING → CLOSED` (all snapshots written and counted; same transaction as outbox + follow-up job) · `CLOSING → OPEN` (failed run). Nothing else. Implemented as `domain/period.ts#transition` (discriminated union, `assertNever`) and as conditional updates with a history row. A month with no row is `OPEN`.

Run: `RUNNING → COMPLETED | FAILED`.

## Derived (not stored)

Statement view: `own`, `adjustmentsBooked`, `adjustmentsReferencing`, `total`, `corrected`, `unpricedLineCount`, `knownAt`, `dataAsOf`. Defined in `domain/statement-view.ts`.

## Migrations

1. `…-statements-s16-expand.js` (idempotent `IF NOT EXISTS`, `lock_timeout` set): additive columns/tables above, backfills, new triggers, widened checks, new unique index on adjustments. The old reader keeps working (legacy columns untouched). Migrating twice changes nothing (AS-78).
2. `…-statements-s16-contract.js` (separate deploy step, after the retro-adjust queue is drained and the legacy reader is removed): drop `UNIQUE(shopId, refersToMonth, reason)`, make `causeKind/causeRef` columns the only identity, remove the legacy-job type.

The old migration file `20261001200000-statements-bitemporal.js` contains a direct `queryInterface.sequelize.transaction`; it is a migration, not domain code, and stays unchanged.
