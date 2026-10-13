---
id: S14
title: Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
kind: capability
status: draft
generated_at: 44c6fed
depends_on: [S10, S13, S49, S50, S53, S54]
concepts: [outbox-task-queue, transaction-runner, idempotency-key, rate-limit-policy, job-scheduler-lease, projection-and-replay, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/payments/**
  - packages/contracts/src/payments/**
---
# S14 - Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation

## Purpose
Every movement of money on the platform is one balanced, immutable journal, posted once. Sales, refunds and settlements post themselves; the accounts every sale touches are split into shards so they do not serialize the platform; balances are running totals, never a sum over history; and every closed UTC day is proven against the payment provider's statement, with differences handed to finance operators as issues. See {{concept:transaction-runner}}, {{concept:outbox-task-queue}} and {{concept:projection-and-replay}}.

## Entry points
- `LedgerService.postJournal`, `recordPaymentCaptured`, `recordPaymentRefunded`, `getBalances`, `listSellerBalances`: the in-process contract used by payments, payouts and ad billing; every posting joins the caller's transaction. [code: packages/backend/libs/domains/payments/application/ledger.service.ts#LedgerService]
- Topic `orders.events` (`order.paid`): the settlement consumer, group `ledger-settlement`. [code: packages/backend/libs/domains/payments/infra/settlement.consumer.ts#SettlementConsumer]
- Topic `ledger.events` (`ledger.journal_posted` v2): the balance read-model projector, group `ledger-balances`. [code: packages/backend/libs/domains/payments/infra/balance.projector.ts#BalanceProjector]
- `GET /shops/:shopId/balance`: a member with `payouts.read` reads the shop's available balance. [code: packages/backend/libs/domains/payments/api/balance.controller.ts#BalanceController]
- `GET /finance/reconciliation/runs`, `GET /finance/reconciliation/issues`, `POST /finance/reconciliation/issues/:issueId/resolve`: the finance operator API (platform `admin` only). [code: packages/backend/libs/domains/payments/api/reconciliation.controller.ts#ReconciliationController]
- Jobs: `payments.reconcile-daily`, `ledger.sweep-hot-accounts`, `ledger.verify-invariants`, `ledger.ensure-partitions`, `ledger.backfill-balances`, `ledger.settle-order` ({{concept:job-scheduler-lease}}). [code: packages/backend/libs/domains/payments/infra/ledger.jobs.ts#LedgerJobs]

## Rules
- **S14.R-01** A journal MUST have 2 to 200 non-zero whole-minor-unit lines in one currency whose amounts sum to exactly zero; any other journal is refused with a named reason and nothing is written. [proof: S14 AS-02, S14 AS-04] [code: packages/backend/libs/domains/payments/domain/journal.ts#validateJournal]
- **S14.R-02** The store MUST refuse at commit any journal whose lines do not sum to zero, whoever wrote it. [proof: S14 AS-03]
- **S14.R-03** Entries and journal headers MUST be append-only: the store rejects `UPDATE` and `DELETE` on every partition and on the header table; a correction is a new reversing journal. [proof: S14 AS-06]
- **S14.R-04** Money MUST be integer minor units within the safe-integer range, with a currency on every journal; a running balance outside that range is refused (`balance_overflow`). [proof: S14 AS-05] [code: packages/backend/libs/domains/payments/domain/lock-order.ts#aggregateRows]
- **S14.R-05** A journal is unique per (kind, reference), enforced by the store; its identifier is deterministic from them; an identical second posting returns the existing journal with `created: false`, a different one raises `JournalConflict`. [proof: S14 AS-07, S14 AS-08] [code: packages/backend/libs/domains/payments/domain/journal.ts#journalId]
- **S14.R-06** A posting MUST join the caller's transaction, never open or commit one, never do network I/O, and write entries, running balances and the outbox event atomically ({{concept:transaction-runner}}). [proof: S14 AS-09] [code: packages/backend/libs/domains/payments/application/journal-posting.service.ts#JournalPostingService]
- **S14.R-07** All lines of a journal MUST carry one `postedAt` taken from the injected clock. [proof: S14 AS-01]
- **S14.R-08** Callers of `postJournal` may post only `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE` and `ADJUSTMENT`; `SALE`, `REFUND`, `SETTLEMENT` and `SWEEP` are posted only by the ledger. [proof: S14 AS-04] [code: packages/backend/libs/domains/payments/domain/journal.ts#CALLER_KINDS]
- **S14.R-09** A `PAYOUT` journal that debits a seller account, and any line on `PAYOUT_CLEARING`, MUST NOT take the balance below zero, decided atomically with the balance update (`insufficient_balance`); other kinds may take a seller account negative. [proof: S14 AS-10] [code: packages/backend/libs/domains/payments/domain/account.ts#isGuarded]
- **S14.R-10** The accounts are `PROVIDER_CLEARING`, `MARKETPLACE_CLEARING` (short name `CLEARING`), `PLATFORM_FEES`, `PAYOUT_CLEARING`, `PAYOUTS_SENT` and `SHOP_<uuid>`; any other account id, and any shard suffix, is refused (`account_unknown`). [proof: S14 AS-04] [code: packages/backend/libs/domains/payments/domain/account.ts#parseAccountId]
- **S14.R-11** There is one fee rule, inside the ledger: a flat validated setting (default 50 minor units) per captured payment; a capture not above the fee is refused. [proof: S14 AS-11, S14 AS-13] [code: packages/backend/libs/domains/payments/domain/fee.ts#splitCapture]
- **S14.R-12** The buyer is never a ledger account; the payer id is a plain reference on the journal. [proof: S14 AS-11]
- **S14.R-13** `recordPaymentCaptured` posts one `SALE` journal per payment: `PROVIDER_CLEARING -A`, `MARKETPLACE_CLEARING +(A-F)`, `PLATFORM_FEES +F`, and is idempotent per payment. [proof: S14 AS-11, S14 AS-12, S14 AS-13] [code: packages/backend/libs/domains/payments/application/payment-postings.service.ts#PaymentPostingsService]
- **S14.R-14** `recordPaymentRefunded` posts one `REFUND` journal per payment that exactly reverses the sale and, when the order was settled, the shops' shares; it refuses a missing sale, another amount or currency, and is idempotent per payment. [proof: S14 AS-14, S14 AS-15, S14 AS-16]
- **S14.R-15** The settlement consumer posts one `SETTLEMENT` journal per `order.paid`: it debits the sale's clearing credit and credits each shop its share by largest remainder over `subtotalMinor`, ties to the lowest shop id. [proof: S14 AS-17] [code: packages/backend/libs/domains/payments/domain/settlement-split.ts#splitSettlement]
- **S14.R-16** The consumer validates every payload, tolerates duplicates and out-of-order delivery, dead-letters invalid payloads without effect, and defers up to 6 attempts in about 10 minutes when the sale is not there yet. [proof: S14 AS-18, S14 AS-19, S14 AS-20] [code: packages/backend/libs/domains/payments/domain/settlement-retry.ts#nextSettlementStep]
- **S14.R-17** Settlement and refund of one payment are serialized: a refunded payment is never settled, a settled-then-refunded payment is fully clawed back. [proof: S14 AS-21] [code: packages/backend/libs/domains/payments/application/settlement.service.ts#SettlementService]
- **S14.R-18** `PLATFORM_FEES`, `PROVIDER_CLEARING` and `MARKETPLACE_CLEARING` are split into `N` shards (default 32, setting 1 to 256) by a stable hash of the journal's shard key; reads present the logical account as the sum of its shards and never show a shard. [proof: S14 AS-22, S14 AS-23, S14 AS-27] [code: packages/backend/libs/domains/payments/domain/shard.ts#shardOf]
- **S14.R-19** An hourly sweep consolidates non-empty shards into shard 0 with one balanced, deterministic `SWEEP` journal per account per window. [proof: S14 AS-24] [code: packages/backend/libs/domains/payments/application/hot-account-sweep.service.ts#HotAccountSweepService]
- **S14.R-20** Every posting locks the balance rows it touches in ascending (account, shard) order, whatever the line order. [proof: S14 AS-25] [code: packages/backend/libs/domains/payments/domain/lock-order.ts#compareRows]
- **S14.R-21** A posting bounds its waits (lock 2 s, statement 5 s) and fails with the retryable `ledger_busy`. [proof: S14 AS-26, S14 AS-69]
- **S14.R-22** The ledger keeps a running balance and a version per (account, shard, currency), updated by atomic increments in the posting's transaction; no balance is computed by summing entries. [proof: S14 AS-28] [code: packages/backend/libs/domains/payments/infra/balance.store.ts#SequelizeBalanceStore]
- **S14.R-23** `getBalances` returns authoritative balances for up to 500 accounts honouring the caller's transaction; `listSellerBalances` pages seller accounts by keyset with a signed cursor. [proof: S14 AS-28, S14 AS-29]
- **S14.R-24** Each journal emits one `ledger.journal_posted` v2 event through the outbox, with each line's account, shard, amount, resulting balance and balance version. [proof: S14 AS-01] [code: packages/backend/libs/domains/payments/application/events/ledger-events.ts#JournalPosted]
- **S14.R-25** The read model applies an event line only when its balance version is newer than the stored one; it is idempotent, order-tolerant and rebuildable, and dead-letters invalid events without effect. [proof: S14 AS-30, S14 AS-31] [code: packages/backend/libs/domains/payments/domain/balance-version.ts#decideVersion]
- **S14.R-26** The read model has a hot copy with an expiry and a durable copy; a read falls back hot, durable, running balance; staleness is visible through `asOf` and a lag metric. [proof: S14 AS-33, S14 AS-37] [code: packages/backend/libs/domains/payments/application/balance-query.service.ts#BalanceQueryService]
- **S14.R-27** `GET /shops/:shopId/balance` answers members with `payouts.read` only (`availableMinor` may be negative), with the same `404` for a non-member as for an unknown shop, and is rate limited per user, failing open. [proof: S14 AS-32, S14 AS-34, S14 AS-35, S14 AS-36]
- **S14.R-28** Reconciliation reads the provider's statement of a closed UTC day through a domain port and validates every line before use. [proof: S14 AS-46] [code: packages/backend/libs/domains/payments/domain/reconciliation-matcher.ts#parseStatementLine]
- **S14.R-29** The statement is consumed as a paged, lazily advanced stream with at most one page buffered and job heartbeats. [proof: S14 AS-44] [code: packages/backend/libs/domains/payments/application/reconciliation-run.service.ts#ReconciliationRunService]
- **S14.R-30** Statement lines are matched to `SALE` and `REFUND` journals by provider reference, producing issues of kind `MISSING_IN_LEDGER`, `MISSING_AT_PROVIDER`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_AT_PROVIDER`, `INVALID_PROVIDER_RECORD`. [proof: S14 AS-38, S14 AS-39, S14 AS-40] [code: packages/backend/libs/domains/payments/domain/reconciliation-matcher.ts#classifyLine]
- **S14.R-31** Reconciliation never posts journals; it only reports. [proof: S14 AS-40]
- **S14.R-32** A run is unique per (provider, day); a `COMPLETED` run is final; concurrent attempts run once; a crashed run restarts its day with unique issues per (run, kind, reference); a failed run stores no issues. [proof: S14 AS-41, S14 AS-42, S14 AS-43, S14 AS-50] [code: packages/backend/libs/domains/payments/domain/run-state.ts#nextRunState]
- **S14.R-33** `day` is a closed UTC day within 90 days; the schedule runs the previous UTC day and catches up days without a `COMPLETED` run in the last 7. [proof: S14 AS-47, S14 AS-48] [code: packages/backend/libs/domains/payments/domain/reconciliation-window.ts#validateDay]
- **S14.R-34** A provider failure ends the run `FAILED(provider_unavailable)`; the adapter does not retry, and the job layer makes at most 3 attempts. [proof: S14 AS-45] [code: packages/backend/libs/domains/payments/infra/stripe-statement.adapter.ts#StripeStatementAdapter]
- **S14.R-35** Open `MISSING_*` issues of the previous 3 days are re-checked on each run and auto-resolved when they now match. [proof: S14 AS-49] [code: packages/backend/libs/domains/payments/domain/issue-state.ts#resolveIssue]
- **S14.R-36** A reconciled day's entries never change; a correction is a new journal in the current period that records the day it corrects. [proof: S14 AS-54]
- **S14.R-37** Runs emit `ledger.reconciliation_completed` and each new issue `ledger.reconciliation_issue_opened` through the outbox. [proof: S14 AS-38, S14 AS-39]
- **S14.R-38** The runs and issues lists are keyset pages (newest first, signed cursor, filters) for the platform `admin` role only. [proof: S14 AS-51, S14 AS-52] [code: packages/backend/libs/domains/payments/application/reconciliation-query.service.ts#ReconciliationQueryService]
- **S14.R-39** `POST .../resolve` requires `Idempotency-Key`, is admin-only, moves an `OPEN` issue to `RESOLVED` with actor, time and note; `adjusted` posts one balanced `ADJUSTMENT` journal in the same transaction ({{concept:idempotency-key}}). [proof: S14 AS-53, S14 AS-54, S14 AS-55, S14 AS-57] [code: packages/backend/libs/domains/payments/application/issue-resolution.service.ts#IssueResolutionService]
- **S14.R-40** Resolving a resolved issue answers `409 issue_already_resolved`; competing resolutions have exactly one winner; the endpoint is limited per user and fails closed ({{concept:rate-limit-policy}}). [proof: S14 AS-56, S14 AS-58, S14 AS-59]
- **S14.R-41** Entries are partitioned by month; partitions for the current month and the next 3 are created by an idempotent weekly job; the catch-all partition accepts a missing month, raises an alert and is emptied by maintenance without changing any total. [proof: S14 AS-60, S14 AS-61] [code: packages/backend/libs/domains/payments/application/partition-maintenance.service.ts#PartitionMaintenanceService]
- **S14.R-42** A daily checker verifies, for the last two closed days, that journals balance, running balances equal the entries, and the read model equals the balances; it counts violations by check, logs ids, and repairs only the read model. [proof: S14 AS-62] [code: packages/backend/libs/domains/payments/application/invariant-check.service.ts#InvariantCheckService]
- **S14.R-43** Every scheduled job runs once per schedule across replicas and is idempotent; every schedule passes `maxAttempts: 3`. [proof: S14 AS-63] [code: packages/backend/libs/domains/payments/infra/schedule-bootstrap.ts#upsertLedgerSchedule]
- **S14.R-44** Existing entries are migrated by expand and contract with a batched, resumable, idempotent backfill and a contract step that refuses unless count and checksum equal. [proof: S14 AS-64] [code: packages/backend/libs/domains/payments/application/balance-backfill.service.ts#BalanceBackfillService]
- **S14.R-45** The capability reads and writes only tables owned by payments; no association, foreign key or model registration of another domain's table. [proof: S14 AS-67]
- **S14.R-46** The public entry point exports no model, only `LedgerModule`, `LedgerWorkerModule`, `LedgerProjectorModule`, `LedgerService`, `LEDGER_ACCOUNTS`, `shopAccount`, `LedgerJournalKind`, `JournalPosted` and the S13 exports. [proof: S14 AS-67] [code: packages/backend/libs/domains/payments/index.ts#LedgerModule]
- **S14.R-47** Secrets and personal data never appear in logs, events, issues or error bodies; a `5xx` carries a generic `detail` ({{concept:problem-json-errors}}). [proof: S14 AS-66]
- **S14.R-48** Configuration is validated at startup and fails naming the setting; shutdown is graceful and every outbound call and statement has a timeout. [proof: S14 AS-68, S14 AS-69] [code: packages/backend/libs/common/config/ledger-config.ts#ledgerConfigKeys]

## Behaviors
- **S14.B-01** Given a balanced three-line journal, when it is posted, then three entries share the journal id and `postedAt`, balances move, and one `journal_posted` v2 is in the outbox. [proof: S14 AS-01]
- **S14.B-02** Given an unbalanced journal, then `JournalUnbalanced` is raised and no entry, balance or outbox row exists. [proof: S14 AS-02]
- **S14.B-03** Given 50 identical postings at once, then one answers `created: true`, 49 `created: false`, and balances move once. [proof: S14 AS-08]
- **S14.B-04** Given two debits of 80 against a balance of 100 at once, then exactly one succeeds and the balance never goes below zero. [proof: S14 AS-10]
- **S14.B-05** Given a capture of 2500 with fee 50, then `PROVIDER_CLEARING -2500`, `CLEARING +2450`, `PLATFORM_FEES +50` are posted once per payment. [proof: S14 AS-11]
- **S14.B-06** Given a refund of an unsettled sale, then the three sale accounts net to zero for the payment; given a settled sale, the shops' shares are reversed. [proof: S14 AS-14, S14 AS-15]
- **S14.B-07** Given `order.paid` for a two-shop order, then one `SETTLEMENT` journal splits the net by largest remainder and the clearing credit nets to zero. [proof: S14 AS-17]
- **S14.B-08** Given `order.paid` before the sale exists, then settlement is deferred and runs after the capture, or dead-letters after 6 attempts. [proof: S14 AS-20]
- **S14.B-09** Given 200 captures at once, then no deadlock or timeout occurs and the logical balances of the hot accounts are exact. [proof: S14 AS-22]
- **S14.B-10** Given a member of a shop, when they read its balance, then they get `balanceSchema` with `source: read_model`, or `ledger` when both stores are down, with the same number. [proof: S14 AS-32, S14 AS-33]
- **S14.B-11** Given a clean statement day, then the run is `COMPLETED` with every line matched and no issue. [proof: S14 AS-38]
- **S14.B-12** Given a statement with a missing, an extra, a different amount and a different currency, then four issues of the named kinds are opened. [proof: S14 AS-39]
- **S14.B-13** Given a provider outage on page 3, then the run is `FAILED(provider_unavailable)` with no issues stored, and the next attempt completes the day. [proof: S14 AS-45]
- **S14.B-14** Given an admin who resolves an issue as `adjusted`, then one `ADJUSTMENT` journal with `correctsDay` is posted with the issue change, history row and event in one transaction. [proof: S14 AS-54]
- **S14.B-15** Given a journal in an uncovered month, then it posts through the catch-all partition and maintenance moves it without changing a total. [proof: S14 AS-61]

## Owns
- Tables: `LedgerEntry`, `LedgerJournal`, `AccountBalance`, `LedgerCheckpoint`, `LedgerBackfillCursor`, `ReconciliationRun`, `ReconciliationIssue`, `ReconciliationIssueHistory`, `ReconciliationStaging`, `ReconciliationSeen`, `ProviderAccount`, `Payout`.
- Events: `ledger.journal_posted` (v2), `ledger.reconciliation_completed`, `ledger.reconciliation_issue_opened`.
- Read model: DynamoDB `LedgerBalanceView`, Redis `ledger:balance:<accountId>`.
- Configuration: `LEDGER_FEE_MINOR`, `LEDGER_SHARDS`, `LEDGER_LOCK_TIMEOUT_MS`, `LEDGER_STATEMENT_TIMEOUT_MS`, `RECONCILIATION_PAGE_SIZE`, `RECONCILIATION_CATCHUP_DAYS`, `LEDGER_CURSOR_SECRET`.

## Decisions
- One header row per journal, unique on (kind, reference), decides "once"; the partitioned entries table cannot carry that uniqueness.
- A posting never nests a transaction; errors raised after a first write carry `rollbackRequired` and every caller runs inside the transaction runner.
- The read model stores absolute values with versions, so replays and duplicates are harmless.
- Reconciliation stages its issues and promotes them in one transaction, so a failed run leaves none.
- The entries table has no `TRUNCATE` trap: the test cleanup truncates every table, and production denies the application role `TRUNCATE`.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): the balance page under 100 ms at the 99th percentile with 100 million entries (SC-004), and a balance change visible within 5 seconds at the 99th percentile under production-like load (SC-005).
- The Stripe calls behind the statement port (`StripeService.listBalanceTransactions`, `retrieveBalanceTransactionByReference`) are exercised only through the scriptable double; the mapping of a Stripe balance transaction to a statement line is not run against the real API.
- A refund whose provider refund id never reaches the ledger is booked under `refund:<paymentId>` and will not match the provider's `re_…` line.
