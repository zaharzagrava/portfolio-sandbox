# Data model: S17 — Subscriptions (domain `billing`)

All tables are in `public`, owned by `domain:billing` in `packages/backend/db/ownership.ts` (rows added in the same PR as the migration), no foreign key to another domain (`subjectId` is a plain UUID). Money is `BIGINT`; existing column names (`unitAmount`, `total`, `amount`, `overagePer1000`) are **kept** (expand-only, old readers keep working) and exposed as `…Minor` by the API mappers. The migration is the existing `20261001190000-subscriptions-billing.js` plus the new expand/contract pair of research R-11.

## Existing tables (expand)

| Table | Change |
|---|---|
| `Plan` | CHECK `code ~ '^[a-z][a-z0-9-]{1,31}$'`; CHECK `audience = 'BUYER' OR code IN ('starter','pro','enterprise')`; CHECK entitlement keys ⊆ allowlist (`freeShipping, earlyAccessDrops, maxProducts, seats, auctions, apiCallsPerMonth, assistantTokensPerMonth`) and numeric values ≥ 0 via an immutable SQL function `billing_entitlements_valid(jsonb)`; seed update `starter.seats 2→5`, `pro.seats 20→25` (only where still the old value). Added `NOT VALID` then validated, so lock time stays short. |
| `Price` | `+ version INTEGER NOT NULL DEFAULT 1` (backfill `row_number() over (partition by planId, interval order by createdAt, id)`), `+ trialDays INTEGER NOT NULL DEFAULT 0 CHECK (trialDays BETWEEN 0 AND 90)`; CHECK `unitAmount BETWEEN 0 AND 100000000`; CHECK `currency = 'EUR'` (`NOT VALID`, validated after a data check); unique `(planId, interval, version)`; **trigger `billing_price_immutable`** (BEFORE UPDATE): raises unless every column other than `active` is unchanged and `NOT (OLD.active = false AND NEW.active = true)`; BEFORE DELETE raises when a subscription references the price. |
| `Subscription` | `+ statusSince TIMESTAMPTZ NOT NULL DEFAULT now()` (backfill `updatedAt`), `+ canceledAt TIMESTAMPTZ NULL`, `+ cancelReason TEXT NULL` (`shop_offboarding`, `customer`, …), `+ offboardingStartedAt TIMESTAMPTZ NULL`, `+ creditBalanceMinor BIGINT NOT NULL DEFAULT 0 CHECK (creditBalanceMinor >= 0)`; unique `(subjectType, subjectId)` partial `WHERE status <> 'CANCELED'` stays (`Subscription_one_live`); due index replaced by partial `Subscription_run_due_idx ("currentPeriodEnd","id") WHERE status IN ('TRIALING','ACTIVE')` and `Subscription_unpaid_idx ("statusSince") WHERE status = 'UNPAID'`; `paymentMethodRef` stays, never selected by read mappers. |
| `Invoice` | `+ businessKey TEXT` (backfill `renewal:<periodStart ISO ms>` for RENEWAL, `proration:<id>` for PRORATION; then `SET NOT NULL` + unique `(subscriptionId, businessKey)`; the old unique `(subscriptionId, periodStart, kind)` is dropped only in the contract migration), `+ attemptStartedAt TIMESTAMPTZ NULL`, `+ attemptUnknown BOOLEAN NOT NULL DEFAULT FALSE`, `+ manualAttempts INTEGER NOT NULL DEFAULT 0`, `+ firstFailedAt TIMESTAMPTZ NULL`, `+ paidAt TIMESTAMPTZ NULL` (backfill `updatedAt` for `PAID`), `+ createdAt` index `(subscriptionId, createdAt DESC, id DESC)` and the keyset index for subject listing (below); **trigger `billing_invoice_immutable`**: only `status` (legal edges), `attempts`, `attemptStartedAt`, `attemptUnknown`, `manualAttempts`, `firstFailedAt`, `nextAttemptAt`, `paidAt`, `updatedAt` may change; legal status edges `OPEN→PAID`, `OPEN→UNCOLLECTIBLE`, `UNCOLLECTIBLE→PAID`; no DELETE. |
| `InvoiceLine` | **trigger `billing_invoice_line_immutable`**: BEFORE UPDATE and BEFORE DELETE raise (the `ON DELETE CASCADE` from `Invoice` stays unreachable because invoices cannot be deleted). Line kinds widened by CHECK to `PLAN, USAGE, ADJUSTMENT, CREDIT, PRORATION_CREDIT, PRORATION_CHARGE` (legacy `PRORATION` rows keep their kind). |

Existing negative open `PRORATION` invoices: in the expand migration's data step, in batches of 500, `UPDATE Subscription SET creditBalanceMinor = creditBalanceMinor + abs(total)` and close the invoice (`PAID`, `paidAt = now()`, history row reason `migrated_credit`) in the same statement set per subscription (idempotent: only `WHERE status = 'OPEN' AND total < 0`). Re-running changes nothing (AS-84).

## New tables (expand)

| Table | Key and columns | Notes |
|---|---|---|
| `SubscriptionTransition` | `id UUID PK`; `subscriptionId`, `fromStatus TEXT NULL`, `toStatus TEXT`, `reason TEXT`, `actor TEXT`, `at TIMESTAMPTZ`, `version INTEGER` | unique `(subscriptionId, version)`; actor matches `^(user:[0-9a-f-]{36}\|system:billing-run\|system:dunning\|event:[0-9a-f-]{36})$`; **trigger `billing_history_append_only`** rejects UPDATE/DELETE. Rows with `from = to` record `cancel_scheduled` / `cancel_withdrawn`. |
| `InvoiceTransition` | `id UUID PK`; `invoiceId`, `fromStatus`, `toStatus`, `reason`, `at` | same append-only trigger. |
| `SubjectPlanState` | PK `(subjectType, subjectId)` (only `SHOP` is written); `tier TEXT CHECK (tier IN ('STARTER','PRO','ENTERPRISE'))`, `planVersion INTEGER NOT NULL`, `updatedAt` | The per-shop counter (R-10). Never deleted. |

Technical tables used through their libs only: outbox (`outbox.append`), inbox (`InboxService`), job queue (`JobsService`), idempotency keys (`@Idempotent`).

## Keyset listing index

Invoices of a subject span subscriptions, so listing joins `Invoice → Subscription` on `(subjectType, subjectId)`:

`SELECT i.* FROM "Invoice" i JOIN "Subscription" s ON s.id = i."subscriptionId" WHERE s."subjectType" = :t AND s."subjectId" = :id AND (i."createdAt", i.id) < (:c, :cid) ORDER BY i."createdAt" DESC, i.id DESC LIMIT :n+1`

Indexes `Subscription (subjectType, subjectId)` (plain, not only partial) and `Invoice (subscriptionId, createdAt DESC, id DESC)`. Detail: same join with `i.id = :invoiceId` so the subject is in the predicate (AS-80). The cursor is the opaque base64url of `{createdAt, id}` with a version tag; a tampered value is `400 invalid_cursor`.

## State machines

**Subscription** (`domain/subscription-status.ts`, discriminated union, `assertNever` in every `switch`): the table of spec User Story 3. API: `transition(status, trigger) → {ok: true, to} | {ok: false, error: 'illegal_transition'}`; the repository applies it as `UPDATE "Subscription" SET status = :to, "statusSince" = :now, version = version + 1 WHERE id = :id AND status = :from AND version = :v RETURNING …` (one row asserted) and inserts the `SubscriptionTransition` row with the new version, in the same transaction as the outbox rows. Non-status changes that bump `version` (price/quantity change, period advance, cancel flag) use the same version guard.

**Invoice**: `OPEN → PAID | UNCOLLECTIBLE`, `UNCOLLECTIBLE → PAID` (`domain/invoice-status.ts`); `VOID` is storable but produced by nothing.

**Attempt** (within `OPEN`): `idle → claimed(n) → settled(paid | declined | unknown)`; `unknown → settled` only via resolution. Columns: `attempts`, `attemptStartedAt` (set = claimed), `attemptUnknown`, `firstFailedAt`, `nextAttemptAt`.

## Validation rules (store and application)

- Price bounds, `currency = 'EUR'`, trial 0–90 (store + zod).
- `quantity` 1–1000; exactly 1 for a flat price (application, `422 quantity_not_applicable`).
- `paymentMethodRef` `^pm_[A-Za-z0-9_]+$`, ≤ 255 (zod); stored opaque; erased (set NULL) on `shop_deleted`.
- `creditBalanceMinor ≥ 0` (CHECK) and every decrement is `UPDATE … SET creditBalanceMinor = creditBalanceMinor - :x WHERE creditBalanceMinor >= :x` inside the renewal transaction.
- Business keys: `renewal:<periodStart ISO with ms>`, `proration:v<new version>`; unique `(subscriptionId, businessKey)`; a duplicate trigger reads the existing invoice (`INSERT … ON CONFLICT DO NOTHING RETURNING` then `SELECT`).

## Ownership registry entries (`db/ownership.ts`)

`SubscriptionTransition`, `InvoiceTransition`, `SubjectPlanState`: `domain:billing`. Functions/triggers: `billing_price_immutable`, `billing_invoice_immutable`, `billing_invoice_line_immutable`, `billing_history_append_only`, `billing_entitlements_valid` (registered like S16's store functions).

## Migrations

1. `2026101[6]…-billing-s17-expand.js` — `SET LOCAL lock_timeout = '5s'` per statement group; no `queryInterface.sequelize.transaction` wrapper across the whole file (long data steps run in separate short transactions, `TransactionRunner` is not available in migrations, so the file uses the migration runner's per-step helper as other expand migrations in the repo do — T-task checks which and keeps the S54 direct-site count unchanged); additive columns/tables/constraints/triggers; data steps idempotent and batched; seeds update; ownership rows. Deployed as its own step before the code.
2. `2026101[6]…-billing-s17-contract.js` — drops `Invoice_subscriptionId_periodStart_kind_key`, the old due index; runs after the expand code is deployed everywhere.
