# SD-20 — Payments & Ledger: Reconciliation, Unknown Outcomes, Hot Accounts, Payouts

Status: ☑ done (typechecked; spec written, not run) · Phase 2 · Depends on: SD-29, SD-19 · Extends README #1, #3, #4, #8, #9

## Marketplace adaptation
The ledger exists (double-entry, outbox, idempotency, saga, circuit breaker). Missing for a real marketplace: daily **reconciliation against Stripe**, handling **timeouts with unknown outcome**, the **platform fee account hot spot**, and **seller payouts** (money leaves the platform).

## Existing code
`ledger/`, `LedgerEntry`, `payment/`, `stripe/` (opossum breaker), `outbox/`.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| `UNKNOWN` payment status on PSP timeout → status query by our reference with backoff, never blind resend | 10/02 Ex1 |
| **Daily reconciliation**: Stripe balance transactions (paginated, streamed) vs ledger clearing account → mismatches to `ReconciliationIssue` queue; idempotent per (date, provider) | 06/02 §5 |
| **Hot account sharding**: platform-fee account split into N sub-accounts (pick by hash of paymentId), balance = sum; periodic sweep consolidation | 10/02 Ex1 |
| **Ledger partitioning** by month (README #11) with `pg_partman`-style job (SD-29) | 03/03 §4 |
| **Seller payouts**: weekly payout run per shop (SD-29), payout = sum of available balance after reserve; ledger transfer seller-balance → payout-clearing; Stripe Connect transfer with idempotency key = payoutId | 10/02 Ex1 |
| Balance read model: per-account balance projection in **Redis + DynamoDB** (F-05) — balance page never sums entries | DOCS backlog "Read-Optimized Views" |
| Deadlock-free transfers: lock accounts in sorted order | 03/02 §7 |
| Invariant checker job: sum(debits) == sum(credits) per day; alert on drift | 03/02 §8 |

## Steps
- [x] `PaymentStatus.UNKNOWN` + resolver job.
- [x] Reconciliation service + `ReconciliationRun`, `ReconciliationIssue` models; Stripe list via async iterator (`for await`) with backpressure.
- [ ] Fee sub-accounts + sweep job. → **not needed (D6)**: ledger writes are append-only inserts and balances are projected asynchronously with atomic HINCRBY, so no hot balance row exists to shard. Would be required only with a synchronous `account_balances` row per account.
- [x] Ledger entries partitioning migration (new partitioned table + copy + swap — documented expand/contract).
- [x] Payouts: `Payout` model/state machine, weekly run job, Stripe Connect adapter (fake for tests).
- [x] Balance projector (F-05) → Redis hash `balance:{accountId}` + Dynamo durable copy.
- [x] e2e: timeout → UNKNOWN → resolved SUCCEEDED once; reconciliation flags a missing entry; payout run twice same week → one payout.

## Scale
- Target: 10k payments/s peak, 100M ledger entries/month.
- Hot path: payment write → ledger tx (append-only inserts, no hot-row update thanks to fee sub-accounts) → outbox. Balance reads → Redis (projection), never `SUM()`.
- First bottleneck & fix: fee account row lock → 32 sub-accounts; ledger table bloat → monthly partitions, detach + archive to S3 (Parquet) after 13 months.
- Partitioning: Kafka payments by paymentId; ledger by month; future shard key = accountId.
- Capacity model: 10k payments/s × 4 entries = 40k inserts/s → needs batched inserts + 2–4 write shards (accountId hash) at full target; documented, single primary handles ~10k inserts/s.
- Proof: k6 payment blast (existing `loadtest:payment`) + fee account contention metric (lock wait time) before/after sub-accounts.

## FE visualisation (phase 2)
Seller balance & payouts page, finance reconciliation issues board.

## Implementation notes (2026-10-01)
- Migration `20261001160000-ledger-partitioning-payouts-recon`: `Payment.status` + `UNKNOWN`, `Payment.providerRef`, `Shop.stripeAccountId`; **LedgerEntry → monthly RANGE partitions** (copy-and-swap; `LedgerEntry_legacy` kept), new `journalId`/`kind`, nullable `paymentId`; **deferred constraint trigger `ledger_balanced` per partition** (unbalanced journals fail at COMMIT); `ledger_ensure_partitions()`; `Payout` (UNIQUE shop+week), `ReconciliationRun` (UNIQUE provider+day), `ReconciliationIssue`.
- `LedgerService.post()` (balanced journal + `ledger.journal_posted` outbox event) and `balance()`; sales now credit `MARKETPLACE_CLEARING` (was a hard-coded `MERCHANT_some-uuid`); chart of accounts in `ledger/accounts.ts`.
- Payment processor: Stripe timeouts mark the payment `UNKNOWN` and rethrow; redelivery with the same Stripe idempotency key settles it; finalize accepts PENDING|UNKNOWN and stores `providerRef`. `StripeService`: `isUnknownOutcome`, `findPaymentIntentByIdempotencyKey` (search by metadata), `paymentIntentsCreatedBetween` (async generator), `transfer` (Connect).
- `libs/common/src/finance/`: `PaymentResolutionJobs` (every 5 min), `ReconciliationJobs` (daily, streamed, idempotent per day), `SettlementListener` (order.paid → SETTLEMENT journal, largest-remainder split, deterministic journal id + advisory lock), `PayoutJobs` (weekly fan-out + per-payout send, Connect transfer with payout id as idempotency key, reversal on definite failure), `PayoutProvider` port (Stripe Connect + fake), `BalanceProjector` (idempotent Lua HINCRBY per journal → `ledger:balances`, in `apps/projector`), `LedgerMaintenanceJobs` (partitions ahead, daily invariant check + metric), `FinanceController` (`GET /api/shops/:shopId/balance` from projection with SQL fallback, `GET .../payouts`).
- Spec `finance/finance.e2e-spec.ts`.
