# Data model: S14 — `payments` ledger and reconciliation

All tables are owned by `domain:payments` and registered in `packages/backend/db/ownership.ts` in the same change as the migration. No ledger model has an association or foreign key to another model (FR-046). Every migration sets `SET LOCAL lock_timeout = '3s'` and runs as its own deploy step (III.11); index builds are `CONCURRENTLY` (outside the transaction block, one statement per file part). Money is `BIGINT` minor units.

## Tables

### `LedgerJournal` (new) — the header, unique per (kind, reference)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `uuidv5(kind + ':' + reference, LEDGER_NS)`; the entries' `journalId` |
| `kind` | TEXT NOT NULL | CHECK in `SALE, REFUND, SETTLEMENT, SWEEP, PAYOUT, PAYOUT_REVERSAL, AD_CHARGE, ADJUSTMENT` |
| `reference` | TEXT NOT NULL | 1–200 chars, no control characters |
| `currency` | CHAR(3) NOT NULL | CHECK `~ '^[A-Z]{3}$'` |
| `postedAt` | TIMESTAMPTZ NOT NULL | the one clock reading; equals every entry's `createdAt` |
| `fingerprint` | CHAR(64) NOT NULL | sha-256 of currency + sorted `(accountId, shard, amount)`; conflict detection |
| `paymentId`, `orderId` | UUID NULL | plain references |
| `paymentRef`, `refundRef` | TEXT NULL | provider references (`pi_…`, `re_…`) |
| `userId` | TEXT NULL | payer, plain reference, no account (built: `TEXT`, S13 user ids are not constrained to UUID) |
| `clearingMinor` | BIGINT NULL | `SALE` only: the `CLEARING` credit settlement splits |
| `amountMinor` | BIGINT NULL | built: `SALE`/`REFUND` payment total, what the provider's statement shows (migration `…-s14-ledger-journal-amount`) |
| `reversesJournalId` | UUID NULL | `REFUND` of a settled sale: the settlement it reversed |
| `correctsDay` | DATE NULL | `ADJUSTMENT` from a resolved issue: the closed day it corrects |
| `createdAt` | TIMESTAMPTZ NOT NULL DEFAULT now() | technical |

Indexes: `UNIQUE (kind, reference)`; `(paymentId) WHERE paymentId IS NOT NULL`; `(orderId, kind) WHERE orderId IS NOT NULL`; `(paymentRef) WHERE paymentRef IS NOT NULL`; `(refundRef) WHERE refundRef IS NOT NULL`; `(kind, postedAt)`. Insert-only (same append-only trigger as entries).

### `LedgerEntry` (changed; partitioned monthly on `"createdAt"`)

Existing: `id`, `journalId`, `kind`, `paymentId`, `accountId`, `amount`, `createdAt` (PK `(id, createdAt)`).

- Expand: `shard SMALLINT NOT NULL DEFAULT 0`; `currency CHAR(3) NOT NULL DEFAULT 'EUR'` (added with a default, then `NOT VALID` check, validated later); index `(accountId, shard, "createdAt")`.
- Switch: the foreign key `paymentId → Payment` is dropped (`DROP CONSTRAINT`, short lock); `paymentId` stays as a plain UUID column (holds the **payment id**; `settlement.listener.ts`'s provider-reference write is deleted — decision for the open follow-up: the column always holds a payment id, the settlement journal references the order through the header's `orderId` and `paymentId` of the sale found for it).
- Triggers (on every partition, present and future, via `ledger_ensure_partitions`): `ledger_balanced` (existing, deferred, per row), `ledger_append_only` (`BEFORE UPDATE OR DELETE`, raises `restrict_violation`). **Built without a `TRUNCATE` trigger**: the test cleanup truncates every table; production denies the application role `TRUNCATE` (see `gaps.md` "Deviations").
- `createdAt` is the journal's `postedAt` (R-2). `LedgerEntry_legacy` stays until the contract step.

### `AccountBalance` (new) — running balance per (account, shard, currency)

| Column | Type | Notes |
|---|---|---|
| `accountId` | VARCHAR(255) | grammar below |
| `shard` | SMALLINT | 0 for every account but the three hot ones |
| `currency` | CHAR(3) | |
| `balanceMinor` | BIGINT NOT NULL DEFAULT 0 | CHECK `abs(balanceMinor) <= 9007199254740991` |
| `version` | BIGINT NOT NULL DEFAULT 0 | +1 per posting that touches the row |
| `updatedAt` | TIMESTAMPTZ NOT NULL | the posting's `postedAt` |

PK `(accountId, shard, currency)`. Index `(accountId text_pattern_ops)` serves `SHOP_` keyset listing: `listSellerBalances` reads `WHERE accountId LIKE 'SHOP\_%' AND accountId > :after AND currency = :c GROUP BY accountId HAVING SUM(balanceMinor) >= :min ORDER BY accountId LIMIT :n` (seller accounts have one row each, so the group is trivial).

### `LedgerCheckpoint` (new) — bounded invariant check

`(accountId, shard, currency)` PK, `verifiedThrough TIMESTAMPTZ`, `balanceMinor BIGINT`. Written by the checker (and seeded by the backfill): `AccountBalance.balanceMinor = checkpoint.balanceMinor + SUM(entries since verifiedThrough)` evaluated in one statement (one snapshot), then the checkpoint advances to the end of the last closed day (R-11).

### `LedgerBackfillCursor` (new)

`name TEXT PK` (`'balances'`), `lastCreatedAt TIMESTAMPTZ`, `lastId UUID`, `rowsDone BIGINT`, `finishedAt TIMESTAMPTZ NULL`: resumable keyset position (AS-64).

### `ReconciliationRun` (changed)

Existing `id`, `provider`, `day`, `matched`, `issues`, `finishedAt`, UNIQUE `(provider, day)`. Added: `status TEXT NOT NULL DEFAULT 'COMPLETED'` for existing rows then default `'RUNNING'` for new ones (two steps) CHECK in `RUNNING, COMPLETED, FAILED`; `startedAt`, `leaseUntil` (TIMESTAMPTZ NULL), `failureCode TEXT NULL` (`provider_unavailable`, `interrupted`, `internal`), `providerLines`, `ledgerJournals`, `skipped` (INTEGER NOT NULL DEFAULT 0). `issues` is exposed as `issueCount`. Cursor index `(startedAt DESC, id DESC)` for the list.

### `ReconciliationIssue` (changed)

Existing `id`, `runId` (FK to run, **kept**: both tables are ours; the "no foreign key to another model" rule is about foreign owners), `kind`, `reference`, `details JSONB`, `resolvedAt`, `createdAt`. Added: `day DATE NOT NULL` (copy of the run's day, for filters), `status TEXT NOT NULL DEFAULT 'OPEN'` CHECK `OPEN|RESOLVED`, `resolution TEXT NULL` CHECK `explained|adjusted|auto_matched`, `note TEXT NULL` (≤ 500), `resolvedBy TEXT NULL` (user id or `system`), `adjustmentJournalId UUID NULL`. `kind` CHECK widened to the six kinds (`STATUS_MISMATCH` removed at contract: no row has it). `UNIQUE (runId, kind, reference)`. Indexes: `(status, createdAt DESC, id DESC)`, `(day)`, `(kind, status)`. Open-count gauge: `SELECT kind, count(*) … WHERE status='OPEN' GROUP BY kind`.

### `ReconciliationIssueHistory` (new)

`(id, issueId, at, actor, from, to, resolution, note)`; one row per state change (auto or operator). Insert-only.

### `ReconciliationStaging` (new, technical)

`(runId UUID, kind TEXT, reference TEXT, details JSONB, PRIMARY KEY (runId, kind, reference))`: issues collected during a run; promoted to `ReconciliationIssue` in the closing transaction, deleted with the run's lease loss or restart (R-9). Also `ReconciliationSeen(runId, reference)` for the reverse direction beyond the in-memory bound.

### `ProviderAccount` (new) — payout destination, taken over from `Shop.stripeAccountId`

`shopId UUID PK` (no foreign key), `provider TEXT NOT NULL DEFAULT 'stripe'`, `accountId TEXT NOT NULL`, `createdAt`, `updatedAt`. Migration backfills from `"Shop"` once (data migration). Read by `PayoutJobs` through a port; written by S15.

## Read-model stores (derived, rebuildable)

- **Durable**: DynamoDB table `LedgerBalanceView` (definition in `packages/backend/dynamodb/LedgerBalanceView.json`): HASH `accountId` (S), RANGE `shardNo` (N; not `shard`, a DynamoDB reserved word); attributes `currency`, `balanceMinor` (N), `version` (N), `projectedAt` (S ISO). No TTL.
- **Hot**: Redis hash `ledger:balance:<accountId>`, field `<shard>`, value `"<version>:<balanceMinor>:<projectedAtMs>:<currency>"`, `EXPIRE 86400` on every write. Only unsharded accounts are read from it.

## Account grammar and classes (`domain/account.ts`)

| Account id | Class | Sharded | May go negative | Notes |
|---|---|---|---|---|
| `PROVIDER_CLEARING` | provider clearing | yes | yes (it is a debit-side account: sales debit it) | renames S13's `PROVIDER_FUNDS` |
| `MARKETPLACE_CLEARING` (`LEDGER_ACCOUNTS.CLEARING`) | clearing | yes | yes | |
| `PLATFORM_FEES` | revenue | yes | yes (refunds) | |
| `PAYOUT_CLEARING` | payout clearing | no | **never** | guarded for every kind |
| `PAYOUTS_SENT` | payouts sent | no | yes | |
| `SHOP_<uuid>` | seller | no | yes except `PAYOUT` debit | UUID lower-case canonical form accepted case-insensitively, stored lower-case |

Anything else, and any `…#<n>` shard suffix, is `account_unknown`.

## Journal kinds and who may post them

| Kind | Poster | Reference | Shard key |
|---|---|---|---|
| `SALE` | `recordPaymentCaptured` | `paymentId` | `paymentId` |
| `REFUND` | `recordPaymentRefunded` | `paymentId` | `paymentId` (sale's) |
| `SETTLEMENT` | settlement consumer | `orderId` | `orderId` |
| `SWEEP` | sweep job | `<accountId>:<window>` | explicit shards |
| `PAYOUT`, `PAYOUT_REVERSAL` | `postJournal` (S15) | caller's | reference |
| `AD_CHARGE`, `ADJUSTMENT` | `postJournal` (S36, resolve endpoint) | caller's / `issue:<id>` | reference |

## State machines (pure, in `domain/`, `assertNever`)

- **Run**: `RUNNING → COMPLETED`, `RUNNING → FAILED`, `FAILED → RUNNING` (restart); `COMPLETED` final. Lease-expired `RUNNING → RUNNING` is a restart by claim, recorded as a new `startedAt`.
- **Issue**: `OPEN → RESOLVED(explained | adjusted | auto_matched)` only.

## Migration sequence (expand → backfill → switch → contract)

| # | File (under `packages/backend/migrations/`, timestamp > 20261011…) | Phase | Content |
|---|---|---|---|
| 1 | `…-s14-ledger-expand.js` | expand | `LedgerJournal`, `AccountBalance`, `LedgerCheckpoint`, `LedgerBackfillCursor`, `ProviderAccount` (+ data copy from `Shop`), entry columns `shard`/`currency`, `ledger_append_only` + `TRUNCATE` triggers on every existing partition, `ledger_ensure_partitions` replaced (creates both triggers, no longer fails when the default holds the month: it calls `ledger_relocate_default(month)`), `ledger_relocate_default` (R-3) |
| 1b | `…-s14-ledger-journal-amount.js` | expand | `LedgerJournal.amountMinor` |
| 2 | `…-s14-reconciliation-expand.js` | expand | run/issue columns, constraints, `ReconciliationIssueHistory`, `ReconciliationStaging`, `ReconciliationSeen`, indexes |
| 3 | `…-s14-ledger-indexes.js` | expand | `CONCURRENTLY` indexes on `LedgerJournal`, `LedgerEntry (accountId, shard, createdAt)`, `AccountBalance` |
| 4 | (job) `ledger.backfill-balances` | backfill | headers from `journalId`s (`kind` from the entry, `reference` = `journalId` text for legacy journals, `postedAt` = min `createdAt`, `paymentId`/`fingerprint` computed), `AccountBalance` from per-account sums (`MERCHANT_<uuid>` lines stay history; their balance rows are written with the rest, `account_unknown` applies to new postings only), checkpoints, read-model seed |
| 5 | (code deploy) | switch | postings write headers/balances/shards; reads use balances; FK `LedgerEntry.paymentId → Payment` dropped (`NOT VALID` skipped: it is a drop) |
| 6 | `…-s14-ledger-contract.js` | contract (later deploy) | raises unless count and checksum of `LedgerEntry_legacy` equal the migrated rows; then `DROP TABLE LedgerEntry_legacy`; `STATUS_MISMATCH` removed from the kind check |

`ownership.ts` gains: `LedgerJournal`, `AccountBalance`, `LedgerCheckpoint`, `LedgerBackfillCursor`, `ReconciliationIssueHistory`, `ReconciliationStaging`, `ReconciliationSeen`, `ProviderAccount` → `domain:payments`.
