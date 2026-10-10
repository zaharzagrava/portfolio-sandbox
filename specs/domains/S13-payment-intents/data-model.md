# Data model: S13 — domain `payments` (payment-intent part)

Owner of every table below: `domain:payments` (`db/ownership.ts`). Amounts are integer minor units (`BIGINT`; JS `number` with a safe-integer check at the repository edge, III.8). `orderId` and `userId` are plain columns with **no foreign key and no association** to another owner (IX.4). Migrations are expand → backfill → contract (III.11); each sets `SET lock_timeout = '3s'`; index creation is `CONCURRENTLY` (those migrations run with `transaction: false`). The ledger tables (`LedgerEntry`, `Payout`, `Reconciliation*`) are S14/S15's and are not changed except the removal of the `Payment` associations (D-17).

## `Payment` (aggregate root, existing table, expanded)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK, default `uuidv7()` | exists |
| `userId` | TEXT NOT NULL | exists; owner of the payment; every read puts it in the predicate |
| **`orderId`** | TEXT NULL → unique | new; copy of `bisOrderId` (backfill); **unique index** `Payment_orderId_key` (partial `WHERE "orderId" IS NOT NULL`); the store enforces "one payment per order" (FR-004). Legacy duplicates keep `orderId` NULL on all but the earliest row (the backfill logs the count) |
| `bisOrderId` | TEXT NOT NULL | legacy; still written (= `orderId`) until the contract release; the foreign key and association are removed in this release |
| `amount` | BIGINT NOT NULL | already minor units; API and events call it `amountMinor`. A `CHECK (amount BETWEEN 1 AND 99999999)` is added `NOT VALID` then validated (old rows are checked by the validate migration; rows outside the range are reported, not rewritten) |
| **`currency`** | TEXT NOT NULL DEFAULT `'USD'` for old rows; new rows always set it | `CHECK (currency IN ('EUR','USD','GBP'))` `NOT VALID` → validate |
| `status` | `enum_Payment_status` | gains **`REFUND_PENDING`** (`ALTER TYPE … ADD VALUE IF NOT EXISTS`, own migration, committed before any code writes it); values: `PENDING, UNKNOWN, COMPLETED, FAILED, CANCELLED, REFUND_PENDING, REFUNDED` |
| **`version`** | INTEGER NOT NULL DEFAULT 1 | +1 per status move (not for `chargeAttemptedAt`, `awaitCustomer`) |
| `providerRef` | TEXT NULL | exists; the provider's intent id `pi_…`; unique partial index `Payment_providerRef_key WHERE "providerRef" IS NOT NULL` (lookup by `paymentRef` in `getPaymentStatus`, refund matching) |
| **`chargeAttemptedAt`** | TIMESTAMPTZ NULL | set by the start-of-charge conditional update; cleared only when the call was provably not sent (breaker/429) |
| **`chargeAttempts`** | INTEGER NOT NULL DEFAULT 0 | attempts counted for the 6-attempt rule |
| **`requiresAction`** | BOOLEAN NOT NULL DEFAULT false | customer action pending |
| **`clientSecret`** | TEXT NULL | only while `requiresAction`; cleared on any final status; never logged or published |
| **`paymentMethodToken`** | TEXT NULL | the provider token from the request; cleared when the status becomes final |
| **`failureCode`** | TEXT NULL | closed list (`card_declined`, `insufficient_funds`, `expired_card`, `declined_other`, `provider_rejected`, `provider_unavailable`, `provider_canceled`, `no_provider_record`, `order_not_payable`, `order_cancelled`) with a `CHECK` |
| **`nextResolveAt`** | TIMESTAMPTZ NULL | due time of the next `UNKNOWN` lookup (set on entering `UNKNOWN`, rescheduled after each lookup) |
| **`resolveChecks`** | INTEGER NOT NULL DEFAULT 0 | lookups so far (the `n` of the backoff) |
| **`unknownSince`** | TIMESTAMPTZ NULL | when the payment entered `UNKNOWN` (24-hour stuck rule) |
| **`lastStuckAlertAt`** | TIMESTAMPTZ NULL | hourly warning throttle for > 24 h `UNKNOWN` and > 24 h `REFUND_PENDING` |
| **`refundRequestedAt`** | TIMESTAMPTZ NULL | first `orders.refund_requested` seen for this payment (24 h wait cap, refund age gauge) |
| **`refundNextAt`** | TIMESTAMPTZ NULL | next refund retry time |
| `idempotencyKey` | STRING | legacy, nullable after expand, never read; dropped by the contract release |
| `createdAt`, `updatedAt` | TIMESTAMPTZ | exist |

Indexes: `Payment_orderId_key` (unique, partial); `Payment_providerRef_key` (unique, partial); `idx_payment_user_created` `(userId, createdAt DESC, id DESC)` (replaces `idx_payment_user_id_desc`; keyset list); `idx_payment_unknown_due` `(nextResolveAt) WHERE status = 'UNKNOWN'` (sweep); `idx_payment_refund_due` `(refundNextAt) WHERE status = 'REFUND_PENDING'`.

Associations: **none** (no `BelongsTo(BisOrder)`, no `HasMany(LedgerEntry)`). The lazy `require('@app/domains/orders')` accessor and the `PaymentWithAllFilters.bisOrder*` scope are deleted (C3, D-11, D-17).

### State machine (`domain/payment-status.ts`, pure, `assertNever`)

```
        accept
  ∅ ───────────▶ PENDING ──succeed──────────────▶ COMPLETED ──requestRefund──▶ REFUND_PENDING ──refundSucceeded──▶ REFUNDED
                  │  ▲ │ ──fail(code)───────────▶ FAILED
                  │  │ │ ──markUnknown(reason)──▶ UNKNOWN ──succeed──▶ COMPLETED
                  │  │ │ ──cancel (no attempt)──▶ CANCELLED          ──fail(code)──▶ FAILED
                  │  └─┴────── awaitCustomer (flag only, no new version)  ◀── UNKNOWN ──awaitCustomer──▶ PENDING
terminal: FAILED, CANCELLED, REFUNDED   (COMPLETED only leaves through requestRefund)
```

Commands: `succeed`, `fail(code)`, `markUnknown(reason)`, `awaitCustomer`, `cancel`, `requestRefund`, `refundSucceeded`. Every other (status, command) pair → `InvalidPaymentTransition {from, command}`. `cancel` additionally requires "no charge attempt recorded" — a guard in the SQL (`chargeAttemptedAt IS NULL`), mirrored in the pure function by an `attempted: boolean` input.

Every move is one statement `UPDATE "Payment" SET status = :to, version = version + 1, "updatedAt" = :now, <fields of the move> WHERE id = :id AND status = :from AND version = :v` asserting one row, one `PaymentHistory` row, the ledger call for `COMPLETED`/`REFUNDED`, the outbox event for `COMPLETED|FAILED|CANCELLED|REFUNDED`, and the `afterCommit` push — all in one `TransactionRunner.run`; no network I/O inside.

## `PaymentHistory` (new, append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK (`uuidv7()`) | |
| `paymentId` | UUID NOT NULL | same owner; no FK needed but a plain index |
| `version` | INTEGER NOT NULL | the version **after** the move; unique with `paymentId` |
| `fromStatus` | TEXT NULL | `NULL` for the creating row (`∅ → PENDING`) |
| `toStatus` | TEXT NOT NULL | |
| `reason` | TEXT NULL | `provider_timeout`, `crash_recovery`, `provider_response_invalid`, `order_cancelled`, a failure code… |
| `actor` | TEXT NOT NULL | `user:<id>`, `system:processor`, `system:resolver`, `system:refresh`, `system:order-events`, `system:refund` |
| `at` | TIMESTAMPTZ NOT NULL | injected clock |

Indexes: unique `(paymentId, version)`. The repository has `insert` and `listByPayment` only; there is no update or delete method (AS-42). Backfill: one synthetic row per existing payment (`fromStatus NULL`, `toStatus = current status`, `version 1`, reason `backfill`, actor `system:migration`).

## `PayableOrder` (new, the order copy, R3)

| Column | Type | Notes |
|---|---|---|
| `orderId` | UUID PK | one row per order, never deleted |
| `userId` | TEXT NOT NULL | |
| `totalMinor` | BIGINT NULL | `NULL` only when the first event seen was `order.cancelled` |
| `currency` | TEXT NULL | same |
| `status` | TEXT NOT NULL, `CHECK IN ('RESERVED','PAID','CANCELLED')` | |
| `reservedUntil` | TIMESTAMPTZ NULL | |
| `orderVersion` | INTEGER NOT NULL | |
| `updatedAt` | TIMESTAMPTZ NOT NULL | |

Write: one statement, version-guarded —
`INSERT … ON CONFLICT ("orderId") DO UPDATE SET … WHERE "PayableOrder"."orderVersion" < EXCLUDED."orderVersion"`; equal or lower versions change nothing (duplicates, stale and out-of-order messages, AS-44). For `order.cancelled` the update keeps the stored amounts (`COALESCE`). Idempotency mechanism of the consumer: **version guard** (documented in the consumer, IV.5). Staleness accepted: the accept path waits up to 2 s for the copy; beyond that the answer is `404 order_not_found` (AS-12).

Payable test (pure, `domain/order-copy.ts`): `status = 'RESERVED' AND totalMinor IS NOT NULL AND now < reservedUntil`; `now == reservedUntil` is expired (AS-11).

## Technical records (not payments tables)

- Idempotency records: `@Idempotent()` (S54), scope = principal, 24 h.
- Consumer dedupe: `orders.events` uses the version guard above; `orders.refund_requested` uses the payment state (a repeat finds `REFUND_PENDING|REFUNDED`) plus job idempotency keys.
- Jobs (S49): `payments.charge`, `payments.resolve-unknown`, `payments.sweep-unknown`, `payments.refund`, `payments.cancel-intent`.
- Outbox rows: events on `payments.events` (key `paymentId`), task `payments.charge_requested` on queue `payments-charge`.
- Redis: `payments:refresh:<paymentId>` (TTL 2 s) for the refresh coalescing; key prefix owned by this domain.
- Breakers: in memory per process (not persisted).

## Ownership registry (`db/ownership.ts`)

Add: `PaymentHistory: 'domain:payments'`, `PayableOrder: 'domain:payments'`. `Payment` is already registered. The new enum value and columns need no registry row. The check must stay green (`check:table-ownership`, `--technical-only`).

## Migrations (files `packages/backend/migrations/20261011…`)

1. `payments-s13-expand-columns.js` — add the new columns (all nullable or defaulted), `CHECK`s `NOT VALID`, drop the foreign key `Payment_bisOrderId_fkey` if one exists (expand-safe: the association is gone from code in the same release; the column stays).
2. `payments-s13-enum-refund-pending.js` — `ALTER TYPE "enum_Payment_status" ADD VALUE IF NOT EXISTS 'REFUND_PENDING'` (alone in its migration, `transaction: false`).
3. `payments-s13-expand-tables.js` — create `PaymentHistory`, `PayableOrder`.
4. `payments-s13-expand-indexes.js` — the five indexes above, `CONCURRENTLY`, `transaction: false`.
5. `payments-s13-backfill-validate.js` — copy `bisOrderId → orderId` (dedupe rule), `currency` default, history rows, then `VALIDATE CONSTRAINT` for the `NOT VALID` checks.
6. Contract (a **later release**, not in this change): drop `bisOrderId`, `idempotencyKey`, `idx_payment_user_id_desc`; retire topics `payments.requests`, `payments.responses`, `payments.dlq` after the legacy consumers are gone.

The order copy is rebuildable by replaying `orders.events` (IX.8); until the consumer has caught up on an environment with in-flight reservations, those orders answer `404 order_not_found`. Deploy order: expand migrations → consumer (worker) deployed and caught up → HTTP route enabled.
