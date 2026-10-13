# Implementation Plan: S14 — Double-Entry Ledger, Balanced Journals, Hot-Account Sharding, Balance Read Model, Daily PSP Reconciliation (domain `payments`)

**Branch**: `S14-ledger-reconciliation` (working branch `sdd/auto`) | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S05, S10, S13, S49, S50, S53 and S54 are built. `payments` already holds the S13 payment flow and a first ledger: a partitioned `LedgerEntry` with a commit-time balance trigger, a `post()` that validates only the sum, balances by `SUM(amount)` over all entries, a Redis `HINCRBY` projector with a 14-day marker, thin S13 wrappers (`recordPaymentCaptured/Refunded`), a settlement listener that reads fields S10 renamed, a reconciliation job that compares provider payment intents to the `Payment` table, and a controller that reads Redis directly. The plan rebuilds the ledger in the shape of the spec without changing the table owner:

- **Pure rules in `domain/`** (journal limits, account grammar and classes, fee split, shard hash, largest-remainder split, settlement retry schedule, lock order, version guard, reconciliation matcher/window, run and issue states, errors, metric names, ports): table-driven unit specs plus `fast-check` for money and allocation (closes the D-6 part of A24).
- **One posting path**: validate (pure) → header insert unique on `(kind, reference)` → running balances updated in sorted `(account, shard)` order with the non-negative guard in the same statement → entries (one `postedAt`) → `ledger.journal_posted` v2 through the outbox. It joins the caller's transaction and never opens one (A1–A5, A19, A22).
- **Hot accounts**: three accounts × 32 shards (stable hash of the shard key), summed on read, swept hourly into shard 0 by a balanced `SWEEP` journal; `lock_timeout` 2 s / `statement_timeout` 5 s → `ledger_busy` (A2).
- **Capture, refund, settlement**: native `recordPaymentCaptured/Refunded` (fee rule inside, `PROVIDER_CLEARING` buyer side, refund reverses the shops' shares from the settlement journal); a settlement consumer on `orders.events` splitting the sale's clearing credit by `shopOrders[].subtotalMinor`, with a per-payment lock so a refund and a settlement converge, and a 10-minute deferral chain when the sale is not there yet (A5–A10).
- **Balances and read model**: authoritative `getBalances`/`listSellerBalances` from `AccountBalance`; projector writing version-guarded absolute values to DynamoDB (durable) and Redis (hot, 24 h TTL); `GET /shops/:shopId/balance` with the hot → durable → ledger chain, `balanceSchema`, rate limit (A11, A12, A25).
- **Reconciliation**: statement port + validating Stripe adapter; paged, backpressured run per `(provider, day)` with lease, staging and one promotion transaction; six issue kinds; auto-close of timing-only issues; catch-up of 7 days; admin API with idempotent resolve and one-transaction balanced adjustment (A13–A18, A27).
- **Housekeeping**: partitions ahead with default-partition relocation by rebuild, append-only triggers on all partitions, bounded invariant checker with read-model repair, sweep, resumable backfill, contract step guarded by count and checksum (A19–A21, A22).
- **Boundaries**: no `User`, `Payment`, `BisOrder` or `Shop` in ledger code; payout destination moved to a payments-owned `ProviderAccount`; barrel shrinks to the "Provides" list; the 4 direct `sequelize.transaction` sites in `payments` migrate to `TransactionRunner.run` (D-6…D-17, C4).

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S01 | drop the `UserModel` association and import in `ledger-entry.model.ts` / `ledger.module.ts`; existence checks through `UserDirectoryService` | WP-2: model rewritten without `User`; `ledger.module.ts` registers only ledger models. The ledger needs **no** user existence check (FR-012: the payer is a plain `userId` on the journal), so `UserDirectoryService` is not injected anywhere in `payments`. Proof: `ledger-ops.e2e-spec.ts` AS-67 block (no `User` import/association/SQL in ledger files) and `check:table-ownership --strict` |
| S01 | stop reading `User` via `UserModel` or raw `"User"` SQL in payments; `KNOWN_FOREIGN_ROWS` (S01 AS-81 ratchet, `identity/ownership-gates.e2e-spec.ts:17`) goes to 0 | The two `payments` rows (`ledger-entry.model.ts`, `ledger.module.ts`) disappear in WP-2. The ratchet constant is in S01's spec file (a sibling's test): not edited; sibling bullet to S01 to lower it once S05/S10/S24/S28's rows are gone too. After WP-2 the ownership report lists 0 `UserModel` rows for `payments` (recorded in WP-13) |
| S03 | take over the payment-provider account id (`Shop.stripeAccountId`) into a table payments owns; tenancy drops the column; `payout.jobs.ts` stops reading `Shop` | WP-9: `ProviderAccount` table + migration copy, `PROVIDER_ACCOUNT_REPOSITORY`, `PayoutJobs.send` reads it, `Shop` registration removed from `finance-worker.module.ts`/`LedgerWorkerModule`. The column drop is tenancy's (sibling bullet S03). Writing the table (onboarding) is S15's. Research R-12 records why the narrow half is done here. Proof: `ledger-maintenance.e2e-spec.ts` (migration copy), ownership report (2 `ShopModel` rows → 0) |
| S10 | statements stop reading order tables (R3 via CDC/outbox); settle on the `order.paid` shop split | WP-5: settlement consumes `order.paid` `shopOrders` from the contract; no order table or `BisOrder` model anywhere in ledger code. Statement code is S16's (sibling bullet S16) |
| S13 | native `recordPaymentCaptured/Refunded` with the extra fields (`orderId`, `paymentRef`, `refundRef`), `created` in the result; S14 decides what `LedgerEntry.paymentId` holds | WP-5/WP-6: internals replaced, wrappers deleted; `paymentId` column always holds the **payment id** (settlement no longer writes a provider reference); `ledger-posting.adapter.ts` passes the three new fields (in-domain glue, minimal change reported to S13's gaps); `Payment.ledgerEntries`/`LedgerEntry.payment` already removed (D-17 verified in WP-2). Proof: `ledger-payment-postings.e2e-spec.ts` AS-11…AS-16 through the real adapter path |
| S13 (pass 1) | `PROVIDER_FUNDS` account; `settlement.listener.ts` UUID guard; `ledger.module.ts` lost `User`/`BisOrder`/`Payment` | `PROVIDER_FUNDS` renamed `PROVIDER_CLEARING` (WP-2); the listener is replaced by the new consumer (WP-5); registrations verified in WP-2 |
| S49 | `declareJobType` + payload contract for every job; adapt to the discriminated `cancel` result; catch `InvalidScheduleError`; `maxAttempts: 3` on S14 schedules and enqueues | WP-8…WP-10: five jobs (+ `ledger.settle-order`, + the payout jobs this file set already declares) all declared next to their `JobPayloads` augmentation; `upsertSchedule`/`enqueue` pass `maxAttempts: 3` (`ledger.settle-order`: 1, by design); bootstrap catches `InvalidScheduleError`; this domain has no `cancel` caller (verified by grep, WP-0). Proof: `ledger-maintenance.e2e-spec.ts` AS-63 asserts each schedule row's `maxAttempts = 3` and the registered contracts reject a bad payload |
| rule 0 | living spec starts with the page | WP-0 creates `docs/spec/capabilities/S14-ledger-reconciliation.md` (rules, behaviors, `[proof:]`/`[code:]` clauses, scope globs for the ledger/reconciliation files) **before** code, and keeps `python3 scripts/livespec/check.py` green. No `*.reviewed.json` exists for S14 and none is created. `## Spec changes` in `gaps.md` records that nothing signed is changed |
| rule 3 | no git checkout/restore/reset/stash/clean | all undo is by hand edit (noted in task prompts) |
| rule 4 | `TransactionRunner.run`/`@Transactional`; migrate touched `sequelize.transaction` sites and delete their `// S54 T037 audit` comments | WP-9/WP-10: `reconciliation.jobs.ts` (1 site) and `payout.jobs.ts` (3 sites) migrate; baseline 4 → 0; no new direct site. Gate: `grep` in quickstart + AS-67 test |
| gaps.md | A1–A29, B (D-6, D-7, D-8, D-11, D-12, D-15, D-17), C (3 S14 rows), D, E, F | "Gap coverage" below |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` domain `payments`; schemas in `packages/contracts`.

**Primary Dependencies**: all present: `@nestjs/sequelize`/`sequelize-typescript`, `TransactionRunner`/`@Transactional` (`@app/infrastructure/context`), `@Idempotent()` (`…/idempotency`), `OutboxService.append`, `defineEvent`, S53 `Projector` + `ProjectionsModule.forProjectors` + `PermanentError`/`TransientError`, `JobsService`/`@JobHandler`/`declareJobType`, S50 `definePolicies`/`@RateLimit`, `ShopScoped` (tenancy), `Firewall`/`AuthenticatedUser` (identity), `Clock`/`CLOCK`, `MetricsRegistry`, `ApiConfigService`, `RedisService`, `DynamoService` (`@app/infrastructure/dynamo`), `StripeService` (thin client, gains `listBalanceTransactions` and `retrieveBalanceTransactionByReference`), `common/money/allocate`, zod, `fast-check` (dev). **No new library.**

**Storage**: PostgreSQL shared `public` schema — `LedgerJournal`, `AccountBalance`, `LedgerCheckpoint`, `LedgerBackfillCursor`, `ReconciliationIssueHistory`, `ReconciliationStaging`, `ReconciliationSeen`, `ProviderAccount` (new); `LedgerEntry`, `ReconciliationRun`, `ReconciliationIssue` (expanded) — all `domain:payments`. DynamoDB `LedgerBalanceView` (new, definition JSON in `packages/backend/dynamodb/`). Redis `ledger:balance:<accountId>`. Kafka `ledger.events` (produced, key aggregate id), `orders.events` (consumed, group `ledger-settlement`).

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` — the eight files of [test-plan.md](test-plan.md) (`ledger-posting`, `ledger-payment-postings`, `ledger-hot-accounts`, `ledger-balances`, `reconciliation-run`, `reconciliation-issues`, `ledger-maintenance`, `ledger-ops`) + eleven unit specs under `domain/` (table-driven; `fast-check` for money, split, shard spread, lock order, version-guard permutations). Real Postgres (partitions, commit trigger, append-only triggers), Redis, DynamoDB local, outbox, jobs; faked only at the edges (scriptable statement double, limiter store, hot/durable stores forced down, `FakeClock`, identity/tenancy fixtures).

**Target Platform**: Linux containers: `apps/core` hosts `LedgerModule` (HTTP, R1); `apps/worker` hosts `LedgerWorkerModule` (settlement consumer, jobs, reconciliation); `apps/projector` hosts `LedgerProjectorModule`; `apps/payment-processor` imports `LedgerModule` (S13's transition). **No new deployable app** (I.6).

**Project Type**: web-service (backend domain) + contracts package + migrations + a DynamoDB table definition.

**Performance Goals**: balance endpoint p99 < 100 ms with 100 M entries (one hot read; no history scan: SC-004, Ops artifact); a posting = 1 header insert + 2–4 balance statements + 1 bulk insert + 1 outbox insert; 200 captures at once without deadlock (AS-22); projection within 5 s p99.

**Constraints**: no network I/O inside a posting (provider, Redis, Dynamo, HTTP all outside transactions; the outbox write is the in-transaction path); every statement and outbound call has a timeout (posting 2 s/5 s; provider 10 s; hot read 100 ms; durable read 300 ms); one retry layer (the job layer for reconciliation); logs and events carry ids/references/amounts only.

**Scale/Scope**: 4 HTTP routes (1 read, 2 admin reads, 1 write), 3 produced events, 2 consumers, 6 job types, 3 rate policies, 5 R1 methods, 8 new tables + 3 expanded, 69 acceptance scenarios (eight e2e files + eleven unit specs).

### Pool arithmetic and `statement_timeout` (III.12)

- No new pool; the shared S54 pool (P = 10 per instance) applies. A posting holds a connection only inside the caller's transaction: S13's status transition (≈ 6 statements incl. ledger ≈ 10 ms) — the ledger adds the header insert, N balance statements (3 sharded system rows + ≤ 200 shop rows) and one bulk insert, ≈ 2–4 ms for a sale. At the S13 accept limit the demand stays a handful of connections.
- Reconciliation holds a connection per page transaction (≤ 100 refs lookup) and the closing transaction; the provider call (10 s) happens with **no** connection held. Settlement: one short transaction per message; worker concurrency is bounded by P.
- Sweep: one transaction per account (≤ 31 shard rows). Invariant checker: keyset pages of 5 000 entries, each its own statement under the pool-wide `db_statement_timeout_ms`; backfill: batches of 5 000, each its own transaction with `lock_timeout 3s`.
- Posting statements run with `SET LOCAL lock_timeout='2s'; statement_timeout='5s'` applied through the runner options of the transaction the *caller* opened (research R-4); on a joined transaction the posting issues them as `SET LOCAL` (transaction-scoped, restored at commit), which is not nesting.

## Constitution Check

*GATE: passes before Phase 0 and re-checked after Phase 1 design (below).* Each line is a "Pull Request Compliance Gate".

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I.1–I.6, Communication Matrix, no `forwardRef`, no `Scope.REQUEST`) | **Pass** | `domain/` pure, takes `now`/`random`; `application/` reaches `infra/` only through tokens in `domain/ledger-ports.ts` (the `@InjectModel` in `LedgerService`, the Redis/`Payout` imports in the controller are deleted: A24, D-6); controllers thin; no new app. `payout.jobs.ts` and `ad-billing.jobs.ts` are adapted to the new exports, not redesigned |
| 2 | Controllers (II.1), no HTTP `try/catch` outside the filter | **Pass** | Two thin controllers (`BalanceController`, `ReconciliationController`): DTO in, one service call, DTO out; all problems are `AppError`s with codes registered in `LEDGER_PROBLEMS`; the application layer no longer throws `InternalServerErrorException` |
| 3 | Data access: principal-scoped queries (III.4), no network I/O in transactions (III.3), store-enforced invariants (III.6), append-only ledger and integer money (III.8), keyset pagination (III.10) | **Pass** | the balance route reads only `SHOP_<shopId>` of the guard-checked shop; unique `(kind, reference)`, commit-time balance trigger, append-only triggers, non-negative guard in the balance `UPDATE`; `BIGINT` minor units with safe-integer checks; keyset lists with signed cursors; provider/Redis/Dynamo calls outside transactions |
| 4 | Migrations expand/contract with `lock_timeout` (III.11) | **Pass** | [data-model.md](data-model.md): two expand files, an index file (`CONCURRENTLY`), a resumable backfill job, a switch deploy, a guarded contract file for a later release; default-partition relocation by rebuild within 3 s locks |
| 5 | Messaging: outbox, idempotent zod-validated consumers, timeouts (IV.4–IV.6) | **Pass** | v2 event through `OutboxService.append` in the posting's transaction; consumers validate with zod (`handles`), idempotency declared (`natural` settlement, `versionGuard` projector), dead-letter reasons, retries at one layer; every outbound call has a timeout |
| 6 | Contracts: DTOs, `packages/contracts`, problem+json, `Idempotency-Key` (V) | **Pass** | schemas in `packages/contracts/src/payments/ledger*.ts`; e2e parse every body; resolve is `@Idempotent()`; money fields end in `Minor` |
| 7 | Web | n/a | W04 owns the balance card; sibling bullet for the new `balanceSchema` shape |
| 8 | Tests: VII.2/VII.3 for every endpoint, VII.4 for consumers, test plan updated, green run recorded (VII.8/9) | **Pass (proven by WP-13)** | [test-plan.md](test-plan.md) 69 rows → eight e2e files + eleven unit specs; no spec injects `ShopModel`/`UserModel`/`PaymentModel`/`BisOrderModel` or reads another domain's table; gate-9 faults forced in AS-26, 33, 35, 45, 59, 62, 69 |
| 9 | Operational: no secrets/PII in logs, jobs single-run and idempotent, graceful shutdown (VIII) | **Pass** | AS-63/66/69; `fleetConcurrency: 1` + lease + conditional claim; runner stops requesting pages on shutdown |
| 10 | Database isolation (IX) | **Pass after WP-9** | ownership findings for `payments` 3 → 0 (S14 rows) with the two `Shop` rows handled by `ProviderAccount`; no association/foreign key to a foreign owner; new tables registered; cross-domain facts by R3 event (`order.paid`) and R1 (`ShopScoped`) only |
| 11 | Monorepo boundaries (X) | **Pass** | imports via entry points; barrel shrinks; the thin Stripe client gains two listing methods, statement logic stays in `payments/infra` (X.3, X.7); `payments` imports no `orders` (X.5) |

## Complexity Tracking

| ID | Rule | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| CT-1 | "a posting never nests a transaction" vs "no partial write on `insufficient_balance`/`ledger_busy`" | A posting that fails after its first write leaves earlier writes in the caller's open transaction; a savepoint would be a nested transaction (FR-006) | savepoint per posting — forbidden by the spec; pre-checking balances before writing — races | none: documented contract, `rollbackRequired` flag, all callers use `TransactionRunner.run` (research R-4) |
| CT-2 | S15 owns payouts | `payout.jobs.ts`/`finance-worker.module.ts` are edited here (new API, `ProviderAccount`, `TransactionRunner`) | leaving `Shop` reads and raw `LedgerEntry` SQL — the old `post`/`balance` and the `LedgerEntry` sum disappear, so the file must change to compile | when S15 rewrites the payout run |
| CT-3 | settlement deferral by consumer retry | the platform's consumer backoff (200 ms–5 s) and transient pause cannot carry a 10-minute wait without stalling a partition | transient pause on the partition — head-of-line blocking of unrelated orders | none (research R-6) |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S14-ledger-reconciliation/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ http.md  events.md  services.md
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/      # inputs (gaps.md gains "## Sibling-spec follow-ups" and "## Spec changes")
└── tasks.md                                                       # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
docs/spec/capabilities/S14-ledger-reconciliation.md            # WP-0, before code (living spec page; no .reviewed.json)
specs/UNVERIFIED.md                                            # + S14 rows (SC-004, SC-005 timing)

packages/contracts/src/payments/
├── ledger.ts            # balanceSchema, reconciliationRunSchema/PageSchema, reconciliationIssueSchema/PageSchema, resolveReconciliationIssueRequestSchema, account/kind/currency enums
├── ledger-events.ts     # journalPostedV2, reconciliationCompleted, reconciliationIssueOpened
└── index.ts             # re-exported from src/index.ts

packages/backend/libs/domains/payments/
├── api/
│   ├── balance.controller.ts            # GET /shops/:shopId/balance
│   ├── reconciliation.controller.ts     # GET runs, GET issues, POST resolve
│   ├── admin.guard.ts                   # role === 'admin' (only if identity has no equivalent: WP-0 decides)
│   └── ledger.dto.ts                    # request/query DTO classes (replaces the old CreateLedgerEntryDto/SystemAccount)
├── application/
│   ├── ledger.service.ts                # R1 facade: recordPaymentCaptured/Refunded, postJournal, getBalances, listSellerBalances
│   ├── journal-posting.service.ts       # the one posting path
│   ├── payment-postings.service.ts      # capture / refund rules (fee, shards, reversal)
│   ├── settlement.service.ts            # split + serialize with refunds
│   ├── balance-query.service.ts         # read-model chain for the endpoint
│   ├── hot-account-sweep.service.ts
│   ├── invariant-check.service.ts
│   ├── partition-maintenance.service.ts
│   ├── balance-backfill.service.ts
│   ├── reconciliation-run.service.ts    # claim, stream, match, stage, promote, auto-close
│   ├── reconciliation-query.service.ts  # runs/issues pages
│   ├── issue-resolution.service.ts      # resolve + adjustment
│   └── events/ledger-events.ts          # JournalPosted v2 + reconciliation events (defineEvent on contracts)
├── domain/
│   ├── journal.ts  account.ts  fee.ts  shard.ts  settlement-split.ts  settlement-retry.ts  lock-order.ts
│   ├── balance-version.ts  reconciliation-matcher.ts  reconciliation-window.ts  run-state.ts  issue-state.ts
│   ├── ledger-errors.ts  ledger-metrics.ts  ledger-ports.ts  ledger-cursor.ts
│   └── *.spec.ts                        # eleven table-driven unit specs
├── infra/
│   ├── models/ledger-entry.model.ts (clutter, User, Payment removed)  ledger-journal.model.ts  account-balance.model.ts
│   ├── journal.store.ts  balance.store.ts  reconciliation.store.ts  provider-account.repository.ts
│   ├── balance-read-model.hot.ts  balance-read-model.durable.ts
│   ├── balance.projector.ts             # version-guarded (rewritten)
│   ├── settlement.consumer.ts           # replaces settlement.listener.ts
│   ├── stripe-statement.adapter.ts      # PROVIDER_STATEMENT
│   ├── ledger.jobs.ts                   # sweep, verify-invariants, ensure-partitions, backfill, settle-order
│   ├── reconciliation.jobs.ts           # payments.reconcile-daily (rewritten)
│   ├── payout.jobs.ts                   # adapted (postJournal, listSellerBalances, ProviderAccount, TransactionRunner)
│   ├── ledger-posting.adapter.ts        # S13 glue: passes orderId/paymentRef/refundRef
│   └── (deleted) ledger-maintenance.jobs.ts, settlement.listener.ts, application/bis-utils.service.ts, bis-utils.module.ts
├── ledger.module.ts  ledger-worker.module.ts  ledger-projector.module.ts  rate-limit-policies.ts (+ finance.* policies)  index.ts
├── testing/ (extended)  ledger-app.ts  fake-provider-statement.ts  ledger-fixtures.ts
└── ledger-posting|ledger-payment-postings|ledger-hot-accounts|ledger-balances|reconciliation-run|reconciliation-issues|ledger-maintenance|ledger-ops .e2e-spec.ts
(deleted) finance.e2e-spec.ts, finance.module.ts, finance-worker.module.ts

packages/backend/libs/common/config/ledger-config.ts                  # validated settings (AS-68)
packages/backend/libs/infrastructure/stripe/stripe.service.ts         # + balance-transaction listing/lookup (timeout 10 s, maxNetworkRetries 0)
packages/backend/migrations/2026101…-s14-*.js                         # four files (data-model.md)
packages/backend/dynamodb/LedgerBalanceView.json
packages/backend/db/ownership.ts                                      # + new tables
packages/backend/apps/{core,worker,projector}/src/*.module.ts         # module swaps
packages/backend/libs/domains/marketing/{infra/ad-billing.jobs.ts,ads.e2e-spec.ts}   # moved to postJournal/getBalances (compile fix, S36 keeps the rest)
packages/backend/test/seeds/*                                         # stop importing LedgerEntryModel (raw inserts)
```

**Structure Decision**: web-service backend domain plus contracts. No new deployable. The ledger files are separated from the S13 payment files and share only `LedgerService` (called from S13's transition inside its transaction).

## Work packages

Order follows `gaps.md` section F; each package ends with its narrowest test through `test-spec.sh` (`npx jest` for units). `/speckit-tasks` splits them.

| WP | Content | Scenarios / gaps |
|---|---|---|
| WP-0 | **Baseline and living page**: record `check:table-ownership` for `payments` = **3** and direct `sequelize.transaction` count = **4** (`.ownership.baseline`, `.tx.baseline`); run the current `finance.e2e-spec.ts`, `ads.e2e-spec.ts`, payments specs, to know what is green; probes (throwaway, deleted): S53's treatment of an older event version without upcast (R-8), identity admin guard, `refundRef` availability at the `REFUNDED` transition, `allocate()` tie rule, `LedgerEntry` constraint/trigger names on the live partitions, `PROVIDER_FUNDS` usages; `grep` for `JobsService.cancel` and `GET …/payouts` callers (web, edge). **Create the S14 living-spec page** (rules/behaviors with `[proof:]`/`[code:]`), run `python3 scripts/livespec/check.py`. | A29 (baseline), rule 0 |
| WP-1 | **Contracts, config, errors, pure domain**: `packages/contracts/src/payments/ledger*.ts`; `ledger-config.ts` + startup validation; `ledger-errors.ts` + `LEDGER_PROBLEMS`; the pure modules with their eleven unit specs (`fast-check` for journal sums, split, shard spread, lock order, version-guard permutations); rate policies; metrics module; `db/ownership.ts` rows. | A3, A8, A26, A28; AS-02, 04, 05, 07 (ID), 10 (class table), 17 (split), 23, 25, 30 (guard), 44/45/47/48/49/50 (pure parts), 68 |
| WP-2 | **Expand migrations and models**: migrations 1–3 of [data-model.md](data-model.md); append-only and balance triggers on all partitions; `ledger_ensure_partitions` / `ledger_relocate_default`; new models without associations; `LedgerEntry` model rewritten (no `User`, `Payment`, payment clutter); `ledger.module.ts` registers ledger models only; `DynamoDB` table JSON; test-stack hook so the table exists. | A19, A20 (SQL part), A22, A23; D-7, D-11, D-17; C4/C5; AS-06, AS-03, AS-60 (SQL) |
| WP-3 | **Posting core**: ports + `SequelizeJournalStore`/`SequelizeBalanceStore`; `JournalPostingService` (validate → header → sorted balances with guard → entries → outbox v2); `LedgerService.postJournal`/`getBalances`/`listSellerBalances`; bounded waits (`ledger_busy`); lock-wait histogram; `ledger-posting.e2e-spec.ts`. | A1, A3, A4, A24; AS-01…AS-10, AS-26, AS-28, AS-29 |
| WP-4 | **Hot accounts**: shard choice wired into postings, logical sum on read, `HotAccountSweepService` + job, `ledger-hot-accounts.e2e-spec.ts` (200 × 5 at once, opposite-order pairs, sweep during captures, lock-held 5 s). | A2; AS-22…AS-27 |
| WP-5 | **Capture, refund, settlement**: `PaymentPostingsService` (fee, `PROVIDER_CLEARING`, reversal from the settlement journal, per-payment lock); native `recordPaymentCaptured/Refunded`; `SettlementConsumer` + `SettlementService` + `ledger.settle-order` chain; delete `recordMarketplaceSale`, `settlement.listener.ts`, `bis-utils`; adapt `ledger-posting.adapter.ts`; `ledger-payment-postings.e2e-spec.ts`. | A5…A10; AS-11…AS-21 |
| WP-6 | **Read model and balance endpoint**: v2 event consumer (`BalanceProjector` rewritten), hot/durable adapters, `BalanceQueryService`, `BalanceController`, `finance.*` policies, lag metric; `ledger-balances.e2e-spec.ts`. | A11, A12, A25; AS-30…AS-37 |
| WP-7 | **Statement port and reconciliation run**: `StripeService` listing/lookup, `StripeStatementAdapter`, `FakeProviderStatement`, `ReconciliationRunService` (claim, paged stream, matcher, staging, promotion, auto-close, events, metrics, catch-up), rewritten `reconciliation.jobs.ts` (clock injected, `maxAttempts: 3`, `TransactionRunner`); `reconciliation-run.e2e-spec.ts`. | A14…A18, A27; AS-38…AS-50 |
| WP-8 | **Operator API**: `ReconciliationController`, `ReconciliationQueryService`, `IssueResolutionService` (conditional update + adjustment + history + event in one transaction), `@Idempotent`, policies, cursor codec; `reconciliation-issues.e2e-spec.ts`. | A13, A25; AS-51…AS-59 |
| WP-9 | **Housekeeping and payout adaptation**: `ledger.jobs.ts` (ensure-partitions with relocation, verify-invariants with checkpoints and read-model repair, sweep, backfill), contract migration (guarded); `payout.jobs.ts` moved to `postJournal`/`listSellerBalances`/`ProviderAccount`/`TransactionRunner`; `LedgerWorkerModule` without `Shop`; `declareJobType` + `maxAttempts: 3` everywhere; `ledger-maintenance.e2e-spec.ts`. | A15 (jobs), A19…A22; AS-60…AS-64; S03/S49 follow-ups |
| WP-10 | **Observability, config, shutdown, boundaries**: log fields, trace propagation, redaction, startup validation, graceful stop of the runner and consumer, barrel and module swaps (`index.ts`, `apps/*`), `marketing` and `test/seeds` adaptation, deletion of the old files (`finance.*`, `ledger.dto.ts`, `ledger-maintenance.jobs.ts`), `ledger-ops.e2e-spec.ts` incl. the static AS-67 checks. | A24, A26, A28; D-6, D-8, D-12, D-15; AS-65…AS-69 |
| WP-11 | **Backfill drill and contract guard**: `ledger-maintenance` AS-64 with legacy-shaped rows under concurrent postings; contract migration refuses on mismatch. | AS-64, E.2, E.4 |
| WP-12 | **Whole-capability run**: all eight e2e files + eleven unit specs, then dependent suites (quickstart); `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict` (payments → 0 S14 rows; record), `check:module-graph`, `check:no-wallclock`, `check:model-registry`, `python3 scripts/livespec/check.py`; fill `UNVERIFIED.md` and `gaps.md` appendices; record the green run (VII.9); write the report. | all |

## Gap coverage

| Gaps | Package | | Gaps | Package |
|---|---|---|---|---|
| A1 | WP-3 | | A16 | WP-7 |
| A2 | WP-4 | | A17 | WP-7 |
| A3, A4 | WP-1 (rules), WP-3 | | A18 | WP-7 |
| A5, A6, A7 | WP-5 | | A19, A20 | WP-2 (SQL), WP-9 (jobs) |
| A8 | WP-1 | | A21 | WP-9 |
| A9, A10 | WP-5 | | A22 | WP-2, WP-9 (backfill), WP-11 |
| A11, A12 | WP-6 | | A23 | WP-2 |
| A13 | WP-8 | | A24 | WP-3, WP-10 |
| A14, A15 | WP-7 | | A25 | WP-6, WP-8 |
| A26 | WP-1, WP-10 | | A27 | WP-7 |
| A28 | WP-1, WP-10 | | A29 | WP-0, WP-10 (old spec replaced) |
| B: D-6 → WP-3/WP-10; D-7 → WP-2, WP-10; D-8 → WP-10; D-11 → WP-2, WP-5; D-12 → WP-7 (statement vs journals only), WP-9 (`payout.jobs.ts`); D-15 → WP-10 (verified by `check:module-graph`); D-17 → WP-2 | | | C (3 S14 rows) → WP-2; the `Shop` rows → WP-9 | |
| D (contracts with others): S13 adapter fields (WP-5), S10 `order.paid` (consumed as published), S15 (sibling bullets), S36 (WP-10 compile fix + sibling), S53/S49/S50/S54 consumed, S03/S01 (`ShopScoped`, `admin`) | | | E (migrations): 1 → WP-2; 2 → WP-9; 3 → WP-3; 4 → WP-11; 5 → WP-2 | |

## Success-criteria proof

| SC | Proof |
|---|---|
| SC-001 | every concurrency scenario ends with the sum-zero/balance-equals-entries assertion helper (`assertBooksHealthy`); nightly checker AS-62 |
| SC-002 | AS-08 (50 × 20), AS-12 (20 at once), AS-18 (5 at once + later), AS-58 (50 races), AS-21c: exactly one journal |
| SC-003 | AS-22 (200 × 5): no deadlock, exact balances |
| SC-004 | **Not proven by an automated test**: no spec stores 100 M entries. AS-28/AS-32 prove "no query sums the entries" and one hot-store read; the 100 ms p99 at volume is an Ops artifact + `UNVERIFIED.md` |
| SC-005 | AS-37 proves visibility within 5 s on the frozen/advanced clock, lag metric, and the fallback with the fast store down (AS-33); the **99th-percentile figure under load** is an Ops artifact + `UNVERIFIED.md` |
| SC-006 | AS-21c (50 racing runs): all five accounts net 0 for the payment; AS-14/AS-15 |
| SC-007 | AS-44 (25 000 lines, one page buffered) and AS-41 (same day twice → same run/issues) |
| SC-008 | AS-38…AS-40 (every seeded difference → exactly one issue; clean day → none) |
| SC-009 | AS-45 (outage → `FAILED`, zero issues stored, recovery on attempt 2) |
| SC-010 | AS-54 (one request, one balanced journal, closed day untouched) |
| SC-011 | AS-67 static block + `check:table-ownership --strict` for the ledger/reconciliation files |

## Re-check after Phase 1

Design artifacts re-read against the gates: (1) layers hold — `application/` talks to tokens only; `domain/` has no framework import; (2) controllers map DTOs only; (3) every provider, Redis and Dynamo call sits outside a transaction; guards and uniqueness are the store's; (4) every added column is nullable or defaulted, indexes are `CONCURRENTLY`, the legacy drop is a later guarded file; (5) events through the outbox, consumers zod-validated with declared idempotency, deferral is a durable job chain; (6) schemas listed for every route; (8) a test row exists for every scenario; (10) eight new tables registered, no foreign-owner association, the payout destination now lives in `ProviderAccount`; (11) barrel equals the "Provides" list. **No gate fails; three named deviations (CT-1…CT-3) are recorded.** Two assumptions to confirm by probe in WP-0 are marked in the research (R-8 older-version handling, `refundRef` availability) and cannot change the design, only a field name or one adapter line.
