# Service contracts (R1) and ports: S14 — `payments` ledger

## Exported from `@app/domains/payments` (public entry point, X.4)

Exactly the "Provides" list of the spec; no model, no DTO class of the old API.

| Export | Kind | Consumers |
|---|---|---|
| `LedgerModule` (core, worker, payment-processor), `LedgerWorkerModule` (worker), `LedgerProjectorModule` (projector) | Nest modules | `apps/core`, `apps/worker`, `apps/payment-processor`, `apps/projector` |
| `LedgerService` | R1 provider | S13 (in-domain), S15, S36, S16, S40 |
| `LEDGER_ACCOUNTS`, `shopAccount`, `LedgerJournalKind`, `JournalPosted` | constants/types/event definition | S15, S36, S16, S40 |
| (S13's, unchanged) `PaymentModule`, `PaymentProcessorModule`, `PaymentQueryModule`, `PaymentQueryService`, `PaymentStatusView`, `paymentsRatePolicies`, `paymentsProjectors` (gains the ledger projectors) | S13 | orders, apps |

**Removed from the barrel** (D-7, D-8): `FinanceModule`, `FinanceWorkerModule`, `BalanceProjector`, `LedgerEntryModel`, `PayoutModel`, `CreateLedgerEntryDto`, `SystemAccount`, `LedgerAccountId`. Importers changed in the same change: `apps/core/src/core.module.ts` (`FinanceModule` → `LedgerModule`), `apps/worker/src/worker.module.ts` (`FinanceWorkerModule` → `LedgerWorkerModule`), `apps/projector/src/projector.module.ts`, `test/seeds/*` (raw inserts in test code only, IX.6), `finance.e2e-spec.ts` (replaced by the eight new files). `PayoutModel` leaves the barrel together with the barrel entry for `FinanceModule` once no importer outside the domain remains (WP-0 greps).

`marketing` keeps `LedgerModule`, `LedgerService`, `shopAccount`, `LEDGER_ACCOUNTS` (allowed R1 use). Because `post`/`balance` are deleted, `ad-billing.jobs.ts` and `ads.e2e-spec.ts` are adapted **in this change** to `postJournal` (`AD_CHARGE`, reference `campaignId:hour`) and `getBalances`, otherwise `marketing` would not compile; S36 keeps the rest of its follow-up (sibling bullet).

## `LedgerService` (plain values only; `tx` mandatory where stated)

```ts
recordPaymentCaptured(input: { paymentId: string; orderId: string; paymentRef: string; userId: string; amountMinor: number; currency: string }, tx: Transaction): Promise<{ journalId: string; created: boolean }>
recordPaymentRefunded(input: { paymentId: string; refundRef: string; amountMinor: number; currency: string }, tx: Transaction): Promise<{ journalId: string; created: boolean }>
postJournal(input: { kind: 'PAYOUT' | 'PAYOUT_REVERSAL' | 'AD_CHARGE' | 'ADJUSTMENT'; reference: string; currency: string; lines: { accountId: string; amountMinor: number }[] }, tx: Transaction): Promise<{ journalId: string; created: boolean }>
getBalances(input: { accountIds: string[]; currency: string }, tx?: Transaction): Promise<Map<string, { balanceMinor: number; asOf: Date }>>
listSellerBalances(input: { currency: string; minMinor: number; limit: number; after?: string }): Promise<{ items: { shopId: string; balanceMinor: number }[]; next: string | null }>
```

- Errors (`AppError` subclasses with a stable `code`, in `domain/ledger-errors.ts`): `JournalUnbalanced{sum}`, `JournalConflict`, `InsufficientBalance`, `LedgerBusy` (retryable), `JournalInvalid{reason}` (`journal_too_few_lines`, `journal_too_large`, `line_amount_zero`, `line_amount_invalid`, `journal_currency_mismatch`, `currency_invalid`, `currency_unsupported`, `account_unknown`, `kind_not_allowed`, `reference_invalid`, `amount_not_above_fee`, `sale_not_found`, `refund_amount_mismatch`, `balance_overflow`, `too_many_accounts`), `TransactionRequired`. `InsufficientBalance`, `LedgerBusy` and `balance_overflow` carry `rollbackRequired = true` (research R-4).
- Guarantees: balanced, once per (kind, reference), joins `tx` (no `sequelize.transaction`, no savepoint, no network I/O), entries + balances + outbox event atomic; `postedAt` from the injected `CLOCK`; locks taken in (account, shard) order; `lock_timeout` 2 s / `statement_timeout` 5 s on the posting's statements. A caller that posts more than one journal in one transaction must order the journals itself (none does today).
- `recordPaymentCaptured`: `amountMinor > F` else `amount_not_above_fee` (`< 0` → `line_amount_invalid`), currency `EUR` else `currency_unsupported`, non-empty `orderId`/`paymentRef` else `reference_invalid`. Lines `PROVIDER_CLEARING −A`, `CLEARING +(A−F)`, `PLATFORM_FEES +F`, one shard `s(paymentId)`; header stores `clearingMinor = A−F`. `F` from `LEDGER_FEE_MINOR`.
- `recordPaymentRefunded`: research R-7; the guards are checked before the idempotency comparison so a repeat with another amount is refused as `refund_amount_mismatch`.
- In-domain adapter change: `infra/ledger-posting.adapter.ts` passes `orderId`, `providerRef` → `paymentRef` and the provider refund id → `refundRef`. WP-0 verifies that the id of `PaymentProvider.createRefund`'s answer reaches the `REFUNDED` transition; if it does not, the transition input gains an optional `refundRef` (additive, S13-owned files touched minimally and reported).
- `LEDGER_ACCOUNTS.PROVIDER_FUNDS` (S13 pass 1) is renamed `PROVIDER_CLEARING` (spec); no persisted data uses it yet (S13's wrappers have not run against production).

## Domain ports (`domain/ledger-ports.ts`, DI tokens; `application/` imports only these)

| Token | Methods (summary) | Adapter (`infra/`) |
|---|---|---|
| `JOURNAL_STORE` | `insertHeader(h, tx) → {created, existing?}`, `insertEntries(rows, tx)`, `findHeader(kind, ref, tx)`, `findSaleByPayment/ByOrder`, `findSettlementByOrder`, `entriesOf(journalId, tx)` | `SequelizeJournalStore` |
| `BALANCE_STORE` | `apply(sortedDeltas, guard, tx) → rows`, `read(ids, currency, tx?)`, `listSellers(...)`, `nonEmptyShards(account)` | `SequelizeBalanceStore` |
| `BALANCE_READ_MODEL` | hot `get/applyIfNewer`, durable `get/query/putIfNewer` | `RedisBalanceHot`, `DynamoBalanceView` |
| `RECONCILIATION_STORE` | claim run, stage/promote issues, list pages, resolve, history, gauges | `SequelizeReconciliationStore` |
| `PROVIDER_STATEMENT` | `listLines`, `findByReference` | `StripeStatementAdapter` over `StripeService` |
| `PROVIDER_ACCOUNT_REPOSITORY` | `findAccountId(shopId)` | `SequelizeProviderAccountRepository` |
| `BALANCE_HOT_STORE`, `BALANCE_DURABLE_STORE` (built as two tokens instead of `BALANCE_READ_MODEL`) | `putIfNewer`, `get`, `overwrite` (repair only) | `RedisBalanceHot`, `DynamoBalanceView` |
| `LEDGER_MAINTENANCE_STORE`, `PROJECTION_PROGRESS`, `JOB_LOCK` (added) | partitions, invariant and backfill SQL; last projected posting time; one-runner lock | `SequelizeLedgerMaintenanceStore`, `RedisProjectionProgress`, `RedisJobLock` |
| `CLOCK` (existing `@app/common/core/clock`), `RANDOM` (existing S13 token) | injected | |

Pure modules in `domain/` (no Nest/Sequelize/Stripe imports; `now` and `random` are parameters): `journal.ts`, `account.ts`, `fee.ts`, `shard.ts`, `settlement-split.ts`, `settlement-retry.ts`, `lock-order.ts`, `balance-version.ts`, `reconciliation-matcher.ts`, `reconciliation-window.ts`, `run-state.ts`, `issue-state.ts`, `ledger-errors.ts`, `ledger-metrics.ts`.

## Metrics (names from AS-65, through `MetricsRegistry`; labels bounded)

`ledger_journals_posted_total{kind}`, `ledger_post_rejected_total{reason}`, `ledger_lock_wait_seconds{accountClass}` (histogram), `ledger_balance_projection_lag_seconds` (gauge), `ledger_projection_stale_total`, `ledger_projection_legacy_skipped_total`, `ledger_settlement_deferred_total`, `ledger_settlement_skipped_total{reason}`, `ledger_settlement_dead_lettered_total`, `ledger_consumer_dead_lettered_total{reason}`, `ledger_invariant_violations_total{check}`, `ledger_default_partition_rows` (gauge), `reconciliation_runs_total{status}`, `reconciliation_issues_open{kind}` (gauge), `reconciliation_lines_skipped_total{type}`, `reconciliation_oldest_open_issue_age_seconds` (gauge). The lag gauge is `now − postedAt` of the last applied event, set by the projector and refreshed by the checker so it keeps growing when the projector is stopped.
