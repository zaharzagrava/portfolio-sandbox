# Tasks: S14 — Double-Entry Ledger, Balanced Journals, Hot-Account Sharding, Balance Read Model, Daily PSP Reconciliation (domain `payments`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/{http,events,services}.md`, `quickstart.md`. Constitution `.specify/memory/constitution.md` v3.1.0.

**Paths**: `P/` = `packages/backend/libs/domains/payments/`; `D/` = `P/domain/`. Backend commands run from `packages/backend`. E2E: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` (condensed output; open the full log only if needed). Units: `npx jest libs/domains/payments/domain`. If one test still fails after 5 fix attempts, stop and write the blocker, attempts and hypothesis into `questions.md`.

**Rules for every task**: (0) the living-spec page changes before code; never create or edit a `*.reviewed.json`. (1) Never edit a sibling's spec; add bullets under `## Sibling-spec follow-ups` in `gaps.md`. (2) Criteria no test proves stay in quickstart "Ops artifacts" and `specs/UNVERIFIED.md` (S14 SC-004/SC-005 rows exist, status `not run`; never call them verified). (3) Never use git checkout/restore/reset/stash/clean; undo by hand-editing only the lines named. (4) `TransactionRunner.run` / `@Transactional` only; migrate touched `sequelize.transaction` sites and delete their `// S54 T037 audit` comments; never add a direct site. (5) `declareJobType` + payload contract for every job; `maxAttempts: 3` on S14 schedules and enqueues (`ledger.settle-order`: 1, by design); catch `InvalidScheduleError`.

**Test-first**: in each story the failing test tasks (one per test-plan row) come before the code tasks. Run the test, see it fail, then implement. `[P]` = different files, no dependency on an unfinished task.

**Stories** (spec.md): US1 balanced immutable journal posted once (P1, AS-01…10) · US2 sales/refunds/settlements (P1, AS-11…21) · US3 hot-account sharding (P1, AS-22…27) · US4 exact balances, read model, endpoint (P1, AS-28…37) · US5 daily reconciliation (P1, AS-38…50) · US6 operator issue queue (P2, AS-51…59) · US7 housekeeping and migration (P2, AS-60…64) · US8 safe, observable, bounded (P3, AS-65…69).

---

## Phase 1: Setup (WP-0 baseline and living page)

- [X] T001 Record baselines: run `pnpm check:table-ownership` and write the `payments` finding count (expect 3) into `specs/domains/S14-ledger-reconciliation/.ownership.baseline`; count `grep -rn "sequelize.transaction" P --include=*.ts | grep -v spec` (expect 4) into `.tx.baseline`; run `P/finance.e2e-spec.ts`, `libs/domains/marketing/ads.e2e-spec.ts` and the other `P/` specs through `test-spec.sh` and note what is green in a `## Baseline` appendix of `gaps.md` (A29)
- [X] T002 Create the living-spec page `docs/spec/capabilities/S14-ledger-reconciliation.md` BEFORE any code: rules and behaviors for journals, accounts, sharding, capture/refund/settlement, balance endpoint, reconciliation, operator API, housekeeping, with `[proof:]`/`[code:]` clauses and scope globs for the ledger/reconciliation files; run `python3 scripts/livespec/check.py` from repo root until green; create no `*.reviewed.json`
- [X] T003 Throwaway probes (delete the probe files afterwards; record answers in `research.md` under R-8): S53 behaviour for an older event version without upcast; identity's admin guard (decides whether `P/api/admin.guard.ts` exists); whether `refundRef` reaches S13's `REFUNDED` transition; `common/money/allocate` tie rule; constraint/trigger names on live `LedgerEntry` partitions; usages of `PROVIDER_FUNDS`; `grep` for `JobsService.cancel` and `GET …/payouts` callers (web, edge)
- [X] T004 Add a `## Follow-up trace` section to `gaps.md` mapping each inherited follow-up (S01 UserModel/`KNOWN_FOREIGN_ROWS`, S03 `stripeAccountId`, S10 `order.paid` split, S13 native `recordPaymentCaptured/Refunded` + `LedgerEntry.paymentId` decision + `PROVIDER_FUNDS`, S49 `declareJobType`/`maxAttempts`/`InvalidScheduleError`/`cancel`) to the task IDs below that implement and prove it; confirm `## Spec changes` still says nothing signed changes

---

## Phase 2: Foundational (WP-1, WP-2) — blocks every story

**Contracts, config, errors** 

- [X] T005 [P] Add `packages/contracts/src/payments/ledger.ts`: `balanceSchema` `{shopId uuid, currency "EUR", availableMinor int (negative allowed), asOf ISO-8601, source "read_model"|"ledger"}`; `reconciliationRunSchema`/`reconciliationRunPageSchema` and `reconciliationIssueSchema`/`reconciliationIssuePageSchema` (`items`, `nextCursor: string|null`); strict `resolveReconciliationIssueRequestSchema` (`resolution` explained|adjusted, `note` string 1–500, `adjustment?` `{currency "EUR", lines[2–10] {accountId, amountMinor int ≠ 0}}`); account/kind/currency enums; re-export from `packages/contracts/src/payments/index.ts` and `src/index.ts`
- [X] T006 [P] Add `packages/contracts/src/payments/ledger-events.ts`: `journalPostedV2` (lines with `accountId`, `shard`, `amountMinor`, `balanceAfterMinor`, `balanceVersion`), `reconciliationCompleted`, `reconciliationIssueOpened`; money fields end in `Minor`; re-export
- [X] T007 [P] Add `packages/backend/libs/common/config/ledger-config.ts` with validated settings and defaults (`LEDGER_FEE_MINOR=50` > 0, `LEDGER_SHARDS=32` in 1–256, `LEDGER_LOCK_TIMEOUT_MS=2000`, `LEDGER_STATEMENT_TIMEOUT_MS=5000`, positive timeouts, `RECONCILIATION_PAGE_SIZE=100` in 1–100, `RECONCILIATION_CATCHUP_DAYS=7` in 1–30, `stripe_secret_key` required, `LEDGER_CURSOR_SECRET` ≥ 32 bytes); startup fails naming the key (A8, A28)

**Pure domain: unit specs first (each spec fails before its module exists)**

- [X] T008 [P] Write `D/journal.spec.ts` (table + `fast-check`): sum rule (any split sums to 0, any one-line perturbation fails), line limits 1/2/200/201, zero, fractional, `2^53`, currency `^[A-Z]{3}$`, reference 1–200 chars no control characters, kind allow-list, safe-integer boundary table, deterministic journal id from (kind, reference) distinct for distinct inputs (AS-02, 04, 05, 07)
- [X] T009 [P] Write `D/account.spec.ts`: grammar (`SHOP_<uuid>` case-insensitive stored lower-case, `…#<n>` shard syntax refused, unknown refused), class table "sharded / may go negative" per `data-model.md` (`PAYOUT_CLEARING` never negative; `AD_CHARGE`/refund may), `PAYOUT` debit guard (AS-04, AS-10)
- [X] T010 [P] Write `D/fee.spec.ts`: fee split table (amount → clearing credit `A−F`), `amount ≤ F` boundary refused, negative → `line_amount_invalid` (AS-11, AS-13)
- [X] T011 [P] Write `D/shard.spec.ts`: determinism, range `0..N-1`, spread within 75–125% over 10 000 references (`fast-check`), same index for the three hot accounts of one journal, N 32→64 keeps logical balance function (AS-23)
- [X] T012 [P] Write `D/settlement-split.spec.ts`: largest-remainder split by `subtotalMinor` with ties to lowest shop id; `fast-check`: shares sum to net, never negative, order-independent; retry schedule (6 attempts, ≈ 10 min total, bounds) (AS-17, AS-20)
- [X] T013 [P] Write `D/lock-order.spec.ts`: order by (account, shard) independent of line order (table + `fast-check`) (AS-25)
- [X] T014 [P] Write `D/balance-version.spec.ts`: version-guard table (newer, equal, older, gap) and `fast-check` (any permutation/duplication of events gives the same final state) (AS-30)
- [X] T015 [P] Write `D/reconciliation-matcher.spec.ts`: exact-match table; missing/extra/amount/currency classification; duplicate-reference detection; refund/dispute typing; line validation table (id, integer amount, currency code, type); `fast-check`: every seeded difference yields exactly one issue, identical inputs none (AS-38, 39, 40, 46)
- [X] T016 [P] Write `D/reconciliation-window.spec.ts`: UTC window `[00:00, 24:00)` incl. month/year ends and leap day; closed-day and 90-day rules; calendar validity (`02-30`, `13-01`); job backoff bounds (exponential, full jitter, ≤ 3 attempts) (AS-45, 47, 48)
- [X] T017 [P] Write `D/run-state.spec.ts` (every state × event against the legal list, `assertNever` exhaustiveness: RUNNING→COMPLETED|FAILED, FAILED→RUNNING, COMPLETED final) and `D/issue-state.spec.ts` (`OPEN → RESOLVED(explained|adjusted|auto_matched)` only) (AS-49, AS-50)
- [X] T018 Implement `D/journal.ts`, `D/account.ts`, `D/fee.ts`, `D/shard.ts`, `D/settlement-split.ts` (+ `D/settlement-retry.ts`), `D/lock-order.ts`, `D/balance-version.ts` so T008–T014 pass; no Nest/Sequelize/Stripe imports, `now`/`random` as parameters
- [X] T019 Implement `D/reconciliation-matcher.ts`, `D/reconciliation-window.ts`, `D/run-state.ts`, `D/issue-state.ts` so T015–T017 pass; run `npx jest libs/domains/payments/domain` green
- [X] T020 [P] Implement `D/ledger-errors.ts` (`JournalUnbalanced{sum}`, `JournalConflict`, `InsufficientBalance`, `LedgerBusy`, `JournalInvalid{reason}` with every reason of `contracts/services.md`, `TransactionRequired`, all `AppError` with stable `code`) and register `LEDGER_PROBLEMS` via `ProblemCatalogModule.forFeature`; remove `InternalServerErrorException` use from the application layer (A3)
- [X] T021 [P] Implement `D/ledger-metrics.ts` (names from `contracts/services.md`, bounded labels), `D/ledger-cursor.ts` (HMAC-signed base64url `{t,id}` codec, `LEDGER_CURSOR_SECRET`), `D/ledger-ports.ts` (tokens `JOURNAL_STORE`, `BALANCE_STORE`, `BALANCE_READ_MODEL`, `RECONCILIATION_STORE`, `PROVIDER_STATEMENT`, `PROVIDER_ACCOUNT_REPOSITORY` with the method shapes of `contracts/services.md`)
- [X] T022 [P] Add `P/rate-limit-policies.ts` entries `finance.balance.read` (120/60 s sliding, user, fail open), `finance.admin.read` (120/60 s, user, open), `finance.admin.write` (30/60 s, user, **closed**) through `RateLimitModule.forFeature`

**Expand migrations, models, registry (WP-2)**

- [X] T023 Write a failing store-level check (in `P/ledger-posting.e2e-spec.ts` skeleton, scenarios AS-03 and AS-06 only) that proves privileged raw insert `[+100, −99]` fails at commit and `UPDATE`/`DELETE` as the app role are rejected; it fails until T025
- [X] T024 Write `packages/backend/migrations/<ts>-s14-ledger-expand.js` (timestamp > 20261011…, `SET LOCAL lock_timeout='3s'`): `LedgerJournal` (columns/types/CHECKs exactly per `data-model.md`: `kind` CHECK in SALE, REFUND, SETTLEMENT, SWEEP, PAYOUT, PAYOUT_REVERSAL, AD_CHARGE, ADJUSTMENT; `reference` TEXT NOT NULL 1–200; `currency` CHAR(3) NOT NULL CHECK `~ '^[A-Z]{3}$'`; `fingerprint` CHAR(64) NOT NULL; nullable `paymentId`, `orderId`, `paymentRef`, `refundRef`, `userId`, `clearingMinor` BIGINT, `reversesJournalId`, `correctsDay` DATE), `AccountBalance` (PK `(accountId, shard, currency)`; `balanceMinor` BIGINT NOT NULL DEFAULT 0 CHECK `abs(balanceMinor) <= 9007199254740991`; `version` BIGINT NOT NULL DEFAULT 0), `LedgerCheckpoint`, `LedgerBackfillCursor`, `ProviderAccount` (+ one-time data copy of `Shop.stripeAccountId`, no FK), `LedgerEntry.shard SMALLINT NOT NULL DEFAULT 0` and `currency CHAR(3) NOT NULL DEFAULT 'EUR'` (`NOT VALID` check), `ledger_append_only` (`BEFORE UPDATE OR DELETE`, `restrict_violation`) and `BEFORE TRUNCATE` triggers on every existing partition and journal table, replaced `ledger_ensure_partitions` (creates both triggers, calls `ledger_relocate_default(month)` when the default partition holds the month), `ledger_relocate_default` (detach default, create, move rows, re-attach, short locks)
- [X] T025 Write `packages/backend/migrations/<ts>-s14-reconciliation-expand.js`: `ReconciliationRun` gains `status` (existing rows `COMPLETED`, new default `RUNNING`, CHECK RUNNING|COMPLETED|FAILED), `startedAt`, `leaseUntil`, `failureCode` (`provider_unavailable`|`interrupted`|`internal`), `providerLines`, `ledgerJournals`, `skipped` INTEGER NOT NULL DEFAULT 0, index `(startedAt DESC, id DESC)`; `ReconciliationIssue` gains `day DATE NOT NULL`, `status` NOT NULL DEFAULT `OPEN` CHECK OPEN|RESOLVED, `resolution` NULL CHECK explained|adjusted|auto_matched, `note` TEXT NULL (≤ 500), `resolvedBy` TEXT NULL, `adjustmentJournalId` UUID NULL, UNIQUE `(runId, kind, reference)`, `kind` CHECK widened to the six kinds (keep `STATUS_MISMATCH` until contract); new insert-only `ReconciliationIssueHistory`, `ReconciliationStaging` (PK `(runId, kind, reference)`), `ReconciliationSeen(runId, reference)`
- [X] T026 Write `packages/backend/migrations/<ts>-s14-ledger-indexes.js` with `CONCURRENTLY` indexes (one statement per part): `LedgerJournal` UNIQUE `(kind, reference)`, partial `(paymentId)`, `(orderId, kind)`, `(paymentRef)`, `(refundRef)`, `(kind, postedAt)`; `LedgerEntry (accountId, shard, "createdAt")`; `AccountBalance (accountId text_pattern_ops)`. Apply all three migrations via `pnpm test:stack:migrate`
- [X] T027 Add `packages/backend/dynamodb/LedgerBalanceView.json` (HASH `accountId` S, RANGE `shard` N; attributes `currency`, `balanceMinor`, `version`, `projectedAt`; no TTL) and make the test-stack hook create it
- [X] T028 [P] Add models without associations: `P/infra/models/ledger-journal.model.ts`, `account-balance.model.ts`, `ledger-checkpoint`/`ledger-backfill-cursor`/`provider-account` models, reconciliation history/staging/seen models; update `ReconciliationRun`/`ReconciliationIssue` models; register all in `packages/backend/db/ownership.ts` as `domain:payments` (`LedgerJournal`, `AccountBalance`, `LedgerCheckpoint`, `LedgerBackfillCursor`, `ReconciliationIssueHistory`, `ReconciliationStaging`, `ReconciliationSeen`, `ProviderAccount`)
- [X] T029 Rewrite `P/infra/models/ledger-entry.model.ts`: drop `UserModel` import/association, the `Payment` association (D-17), and the unrelated clutter (`PaymentReason`, `PaymentStatus`, `PaymentWithAllFilters`, payment `Scopes`); add `shard`, `currency`; `paymentId` stays a plain UUID column holding the **payment id** (S01 follow-up, S13 decision, A23)
- [X] T030 Rewrite `P/ledger.module.ts` to register ledger models only (no `UserModel`, `BisOrderModel`, `Payment`, `Shop`); no `UserDirectoryService` injection is needed (payer is a plain `userId`); verify `pnpm check:table-ownership` lists no `UserModel`/`BisOrderModel` row for `payments` (S01 follow-up; record the output in `gaps.md` Follow-up trace). Run T023's AS-03/AS-06 checks: now green

**Checkpoint**: units green, schema and models in place; `tsc --noEmit` may still fail until callers move (WP-3…WP-10).

---

## Phase 3: US1 — balanced, immutable journal posted once (P1) 🎯 MVP

**Goal**: one posting path that validates, inserts the header unique on (kind, reference), updates sorted running balances with the non-negative guard, writes entries with one `postedAt`, emits `journal_posted` v2 through the outbox, all in the caller's transaction.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-posting` (AS-01…AS-10 + AS-03/06).

### Tests (write first, see them fail) — `P/ledger-posting.e2e-spec.ts`, describe "Ledger: balanced journals, append-only, idempotent postings and limits"

- [X] T031 [US1] AS-01: accepted journal: three entries share journal id and `postedAt`; balances moved; one `journal_posted` v2 (shard, `balanceAfterMinor`, `balanceVersion`) parsed with the contracts schema; sum 0 (helper `assertBooksHealthy` in `P/testing/ledger-fixtures.ts`)
- [X] T032 [US1] AS-02: unbalanced (−1) refused with `JournalUnbalanced`, reason counter moves, no entry/balance/outbox row
- [X] T033 [US1] AS-04: the 12 invalid-journal refusals (1 line, 201 lines, zero amount, fractional, `2^53`, currency format, mixed currency, unknown/shard-suffixed account, bad reference, kind not allowed, …) each persist nothing and count their reason
- [X] T034 [US1] AS-05: `9007199254740000` round-trips exactly; overflow refused `balance_overflow`
- [X] T035 [US1] AS-07: identical replay → `created:false` and nothing new; same (kind, reference) with different lines → `JournalConflict`
- [X] T036 [US1] AS-08: 50 identical postings at once ×20 → one `created:true`, 49 `false`, one entry set, one event, balances moved once
- [X] T037 [US1] AS-09: caller rollback leaves nothing; no `tx` → `transaction_required`; no savepoint/commit by the service; no network call observed during the posting
- [X] T038 [US1] AS-10: two 80s against 100 ×50 → exactly one wins, balance 20, never < 0 (concurrent reader samples); 101 refused `InsufficientBalance`; `AD_CHARGE` may go negative; `PAYOUT_CLEARING` guarded
- [X] T039 [US1] AS-26: lock held 5 s by a second connection → `ledger_busy` after ≈ 2 s, nothing written, repeat succeeds; no network call during locks (forced fault, gate 9)
- [X] T040 [US1] Add the `assertBooksHealthy` helper and journal fixtures to `P/testing/ledger-fixtures.ts` and boot helper `P/testing/ledger-app.ts` (real `LedgerModule`, problem+json filter, `FakeClock`); AS-28/AS-29 are tested in US4 (T070/T071)

### Implementation

- [X] T041 [US1] Implement `P/infra/journal.store.ts` (`SequelizeJournalStore`: `insertHeader` unique on (kind, reference) returning `{created, existing}`, `insertEntries` bulk with one `postedAt`, `findHeader`, `entriesOf`) and `P/infra/balance.store.ts` (`SequelizeBalanceStore.apply(sortedDeltas, guard, tx)` — one statement per row, `UPDATE … SET balanceMinor = balanceMinor + :d, version = version + 1 WHERE … AND (guard)`, upsert for new rows, `balance_overflow` on safe-integer breach); bind to the tokens in `P/ledger.module.ts`
- [X] T042 [US1] Implement `P/application/journal-posting.service.ts`: validate (pure `D/journal.ts`) → header → sorted balances (`D/lock-order.ts`) → entries (one `postedAt` from `CLOCK`) → `journalPostedV2` via `OutboxService.append`; requires `tx` (`transaction_required`), never opens a transaction or savepoint (CT-1), `SET LOCAL lock_timeout`/`statement_timeout` from config, maps lock timeout to `LedgerBusy` and `40P01` is impossible by ordering; fingerprint compare for `JournalConflict`; lock-wait histogram
- [X] T043 [US1] Implement `P/application/events/ledger-events.ts` (`defineEvent` over `journalPostedV2`, aggregate id key) and rewrite `P/application/ledger.service.ts` as the R1 facade with `postJournal` only for now (delete `post`, `balance`, `recordMarketplaceSale` later in T136); remove `@InjectModel`, `InternalServerErrorException` and `wrapInTransaction` use (A1, A3, A4, A5, A24, D-6)
- [X] T044 [US1] Run `test-spec.sh libs/domains/payments/ledger-posting`; fix until AS-01…10 and AS-26 are green

**Checkpoint**: postings are correct, idempotent, bounded; MVP of the ledger.

---

## Phase 4: US2 — sales, refunds, settlements (P1)

**Goal**: native capture/refund and an `order.paid` settlement consumer; `LedgerEntry.paymentId` always holds the payment id.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-payment-postings` (AS-11…AS-21). Depends on US1.

### Tests — `P/ledger-payment-postings.e2e-spec.ts`, describe "Ledger: payment capture, refund and settlement"

- [X] T045 [US2] AS-11 capture: `SALE` lines `−2500` `PROVIDER_CLEARING` / `+2450` clearing / `+50` `PLATFORM_FEES` on `s(paymentId)`, plain references stored (`orderId`, `paymentRef`, `clearingMinor`), no buyer account, one event; calls go through the real `ledger-posting.adapter.ts` path
- [X] T046 [US2] AS-12 capture idempotent: repeat and 20 at once → `created:false`; same payment with 2600 → `JournalConflict` fails the transaction
- [X] T047 [US2] AS-13 capture refused: amounts 50, 49, 0, −1, currency `USD`, missing `orderId`/`paymentRef` each refused with its reason, transaction failed, nothing written
- [X] T048 [US2] AS-14 refund unsettled: `REFUND` lines `+2500/−2450/−50` on the sale's shards; the three accounts net 0 for the payment; sale unchanged
- [X] T049 [US2] AS-15 refund settled: lines `+2500`, `PLATFORM_FEES −50`, `SHOP_a −1225`, `SHOP_b −1225`; clearing 0; shops negative; `reversesJournalId` recorded
- [X] T050 [US2] AS-16 refund guards: `sale_not_found`, `refund_amount_mismatch`, currency mismatch, repeat/20 at once idempotent; guards checked before the idempotency comparison; nothing written on refusal
- [X] T051 [US2] AS-17 settlement: `order.paid` (contract-valid fixture from `packages/contracts`) → one `SETTLEMENT` journal `−1000/+334/+333/+333`, deterministic id, clearing 0 for the order, one event
- [X] T052 [US2] AS-18 settlement duplicates (VII.4): five at once and a later repeat → one journal, one event, later ones acknowledged
- [X] T053 [US2] AS-19 settlement payload validation (VII.4): nine invalid payload classes dead-lettered with reason and `ledger_consumer_dead_lettered_total{reason}`, no journal, next message processed
- [X] T054 [US2] AS-20 settlement before the sale: deferral chain with backoff and counter, settles after capture, dead-letter `sale_not_found` after 6 attempts (≈ 10 min total, clock-driven)
- [X] T055 [US2] AS-21 settlement vs refund: (a) refund first → no shop credit, skipped counter; (b) settle then refund → AS-15 result; (c) race ×50 → (a) or (b), all five accounts net 0 for the payment

### Implementation

- [X] T056 [US2] Add `LEDGER_ACCOUNTS.PROVIDER_CLEARING` (rename of S13's `PROVIDER_FUNDS`, update every usage found in T003) in `D/account.ts`/barrel; no persisted data uses the old name
- [X] T057 [US2] Implement `P/application/payment-postings.service.ts`: capture (`A > F` else `amount_not_above_fee`, currency `EUR` else `currency_unsupported`, non-empty `orderId`/`paymentRef` else `reference_invalid`; lines `PROVIDER_CLEARING −A`, `CLEARING +(A−F)`, `PLATFORM_FEES +F` on shard `s(paymentId)`; header `clearingMinor = A−F`, `paymentId` holds the payment id) and refund (research R-7: reverse the sale's shards, or the settled shops' shares from the settlement journal; per-payment advisory lock shared with settlement); wire native `recordPaymentCaptured({paymentId, orderId, paymentRef, userId, amountMinor, currency}, tx)` and `recordPaymentRefunded({paymentId, refundRef, amountMinor, currency}, tx)` on `LedgerService` returning `{journalId, created}`; delete S13's thin wrappers (S13 follow-up)
- [X] T058 [US2] Implement `P/application/settlement.service.ts` + `P/infra/settlement.consumer.ts` (replaces `settlement.listener.ts`): consume `order.paid` on `orders.events` (group `ledger-settlement`, zod from `packages/contracts`, natural idempotency, no `orders` import), split the sale's `clearingMinor` over `shopOrders[].subtotalMinor` (`D/settlement-split.ts`), `SETTLEMENT` journal reference `orderId`, skip when a refund exists, defer via durable job `ledger.settle-order` (`declareJobType` + payload contract next to the `JobPayloads` augmentation, `maxAttempts: 1`, 6-step schedule from `D/settlement-retry.ts`), dead-letter with reasons and metrics (S10, A9, A10)
- [X] T059 [US2] Adapt `P/infra/ledger-posting.adapter.ts` to pass `orderId`, `providerRef`→`paymentRef`, provider refund id→`refundRef` and to use `created`; if T003 found `refundRef` missing at the `REFUNDED` transition add an optional field to the transition input (minimal S13-owned edit; list it in `gaps.md` Sibling-spec follow-ups under **S13**)
- [X] T060 [US2] Delete `P/infra/settlement.listener.ts`, `P/application/bis-utils.service.ts`, `P/bis-utils.module.ts`, the `recordMarketplaceSale` caller in `P/infra/reconciliation.jobs.ts` (the whole file is rewritten in US5; keep it compiling by stubbing only until T101); remove the `Payment.ledgerEntries`/`LedgerEntry.payment` associations if any remain (D-17, D-11)
- [X] T061 [US2] Run `test-spec.sh libs/domains/payments/ledger-payment-postings`; fix until AS-11…21 are green

**Checkpoint**: money trail of a purchase is correct; S13 and S10 contracts consumed.

---

## Phase 5: US3 — hot accounts do not serialize the platform (P1)

**Goal**: three hot accounts × 32 shards, sorted lock order, hourly sweep.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-hot-accounts` (AS-22…AS-27). Depends on US1 and US2.

### Tests — `P/ledger-hot-accounts.e2e-spec.ts`, describe "Ledger: hot-account sharding, sweep and lock order"

- [X] T062 [US3] AS-22: 200 captures at once ×5 → no deadlock/timeout, exact logical balances (10000 / −50000 / +40000), > 8 shards used, versions equal touch counts, lock-wait metric observed
- [X] T063 [US3] AS-23: config `LEDGER_SHARDS` 32 → 64 keeps logical balances correct
- [X] T064 [US3] AS-24: sweep → one `SWEEP` journal per account into shard 0, empty shards untouched, logical balance unchanged, repeat `created:false`, 100 captures in flight → exact total, no deadlock
- [X] T065 [US3] AS-25: 100 opposite-line-order pairs at once → all succeed, no `40P01`, exact balances
- [X] T066 [US3] AS-27: `getBalances` of `PLATFORM_FEES` equals the sum of shards; no HTTP body, error or log shows a shard number

### Implementation

- [X] T067 [US3] Wire shard choice (`D/shard.ts`, key per `data-model.md` table: `paymentId` for SALE/REFUND, `orderId` for SETTLEMENT, explicit for SWEEP) into `journal-posting.service.ts` and `payment-postings.service.ts` for `PROVIDER_CLEARING`, `CLEARING`, `PLATFORM_FEES`; logical sum over shards in `BALANCE_STORE.read`
- [X] T068 [US3] Implement `P/application/hot-account-sweep.service.ts` (one transaction per account, ≤ 31 shard rows, balanced `SWEEP` journal reference `<accountId>:<window>`) and job `ledger.sweep-hot-accounts` hourly in `P/infra/ledger.jobs.ts` (`declareJobType`, payload contract, `upsertSchedule` with `maxAttempts: 3`, catch `InvalidScheduleError`)
- [X] T069 [US3] Run `test-spec.sh libs/domains/payments/ledger-hot-accounts`; fix until AS-22…27 are green (AS-26 already in US1)

---

## Phase 6: US4 — exact balances, read model, endpoint (P1)

**Goal**: authoritative reads from `AccountBalance`; version-guarded projector to DynamoDB + Redis; `GET /shops/:shopId/balance`.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-balances` (AS-28…AS-37). Depends on US1; AS-32/36 use US2/postJournal.

### Tests — `P/ledger-balances.e2e-spec.ts`, describe "Ledger: running balances, read model and balance endpoint"

- [X] T070 [US4] AS-28: `getBalances` exact values and `asOf`, zero `LedgerEntry` queries, unknown account → 0, 501 ids `too_many_accounts`, duplicates collapsed, reads own uncommitted postings
- [X] T071 [US4] AS-29: `listSellerBalances` 45 accounts in pages 20/20/5 with no repeat/skip under concurrent postings, `minMinor` filter, `next:null`, limit 201 and tampered `after` refused
- [X] T072 [US4] AS-30 (VII.4): projector duplicate delivery → same state; older version ignored and `ledger_projection_stale_total` moves; v1 message skipped and counted; full replay into an empty store equals authoritative balances; shards project independently
- [X] T073 [US4] AS-31 (VII.4): five invalid payload classes dead-lettered with reason, stores unchanged, next message processed
- [X] T074 [US4] AS-32: member `GET /shops/:id/balance` → `200`, parsed with `balanceSchema` `{availableMinor: 1400, source: "read_model"}`; empty shop `0`; no entries-table query; one hot-store read
- [X] T075 [US4] AS-33: hot store down → durable (`read_model`); both down/empty → `ledger` with the same number; every fault leaves `200` (gate 9)
- [X] T076 [US4] AS-34: `401`; non-member `404 shop_not_found` byte-identical to unknown shop; staff `403`; non-UUID and `?currency=euro` `400`; member of `b` never sees `a`
- [X] T077 [US4] AS-35: 121st read in a minute `429` + `Retry-After`; limiter store down → still answered (fail open)
- [X] T078 [US4] AS-36: after an `AD_CHARGE` journal `availableMinor: −1000` is returned
- [X] T079 [US4] AS-37: projector running → new balance visible within 5 s (clock-driven), `asOf` not earlier than the version's commit, lag gauge; projector stopped → gauge grows, endpoint still answers

### Implementation

- [X] T080 [US4] Implement `getBalances` (≤ 500 ids, dedupe, optional `tx`) and `listSellerBalances` (keyset, `LIKE 'SHOP\_%'`, `HAVING SUM >= :min`, signed `after`) in `LedgerService`/`BALANCE_STORE`; no query touches `LedgerEntry` (A1)
- [X] T081 [US4] Implement `P/infra/balance-read-model.hot.ts` (Redis hash `ledger:balance:<accountId>` field `<shard>` value `"<version>:<balanceMinor>"`, `EXPIRE 86400` on every write, 100 ms read timeout) and `balance-read-model.durable.ts` (DynamoDB `LedgerBalanceView` conditional put-if-newer, 300 ms timeout)
- [X] T082 [US4] Rewrite `P/infra/balance.projector.ts` on S53 `Projector`: zod-validate `journalPostedV2`, version-guard (`D/balance-version.ts`) writing absolute values to both stores, `PermanentError` for invalid payloads, skip v1 (or upcast per T003), lag gauge and stale/legacy counters; add `P/ledger-projector.module.ts` and register in `paymentsProjectors` (A11)
- [X] T083 [US4] Implement `P/application/balance-query.service.ts` (hot → durable → `AccountBalance` chain, per-store timeouts, never changes status on fault) and `P/api/balance.controller.ts` (`Firewall()`, `ShopScoped('payouts.read')`, `@RateLimit('finance.balance.read')`, `ParseUUIDPipe`, query DTO `currency` = `EUR`, returns `balanceSchema`); remove `FinanceController`'s Redis/`Payout` imports and `GET payouts` (sibling bullet S15 already in `gaps.md`) (A12, A24)
- [X] T084 [US4] Run `test-spec.sh libs/domains/payments/ledger-balances`; fix until AS-28…37 are green

---

## Phase 7: US5 — daily reconciliation against the provider statement (P1)

**Goal**: paged, backpressured run per (provider, day) with lease, staging, one promotion transaction, six issue kinds, auto-close, catch-up.

**Independent test**: `test-spec.sh libs/domains/payments/reconciliation-run` (AS-38…AS-50). Depends on US1/US2 (journals).

### Tests — `P/reconciliation-run.e2e-spec.ts`, describe "Reconciliation: daily provider run" (uses `P/testing/fake-provider-statement.ts`, a scriptable double bound to `PROVIDER_STATEMENT` with a call log)

- [X] T085 [US5] AS-38 clean day: `COMPLETED`, 4 lines, 4 journals, 4 matched, 0 issues, one `reconciliation_completed`, run metric
- [X] T086 [US5] AS-39 differences in charges: four issues with details, `OPEN`, four `reconciliation_issue_opened` events, `matched` counts exact matches only, open gauge
- [X] T087 [US5] AS-40 refunds, disputes, duplicates: four issues of the named kinds/types; ledger entry count unchanged by the run
- [X] T088 [US5] AS-41 idempotent per day: second and concurrent invocations → no provider call, run and issues unchanged, one run row
- [X] T089 [US5] AS-42 one runner: two workers at once → one streams, the other reports "already running"; one run row
- [X] T090 [US5] AS-43 crashed run restarts: expired lease with 3 stale staged issues → restart, exact issue set, no duplicates, `COMPLETED`
- [X] T091 [US5] AS-44 paged/streamed: 25 000 lines / 250 pages: page n+1 requested only after page n processed (call log vs processing log), ≤ 1 page buffered, heartbeat at least every 1 000 lines, repeated lines counted once, correct counts
- [X] T092 [US5] AS-45 provider trouble (gate 9): timeout / `429` / `503` on page 3 → `FAILED(provider_unavailable)`, no issues stored, earlier days untouched, adapter retry count 0, job retries ≤ 3, recovery on attempt 2 → `COMPLETED`
- [X] T093 [US5] AS-46 untrusted provider answers: three `INVALID_PROVIDER_RECORD` (position only, no raw body), unknown type and `transfer` skipped and counted, run completes
- [X] T094 [US5] AS-47 day boundaries: 23:59:58 / 00:00:03 → no issue in either run; never posted → `MISSING_IN_LEDGER`; journal 23:59:59 vs provider 00:00:02 → no `MISSING_AT_PROVIDER` (boundary lookup by reference)
- [X] T095 [US5] AS-48 which days may run: six refused inputs create no run; default day at 02:30Z is yesterday (injected clock); catch-up runs 2 missing days oldest first
- [X] T096 [US5] AS-49 timing-only issues close: `OPEN` → `RESOLVED(auto_matched, system)` once the journal exists, history row written; unmatched stays open; only the last 3 days re-checked; gauge drops
- [X] T097 [US5] AS-50 run states: a `COMPLETED` run's counts and issues are never rewritten by a second pass

### Implementation

- [X] T098 [US5] Extend `packages/backend/libs/infrastructure/stripe/stripe.service.ts` with `listBalanceTransactions` (paged) and `retrieveBalanceTransactionByReference` (timeout 10 s, `maxNetworkRetries: 0`); thin client only
- [X] T099 [US5] Implement `P/infra/stripe-statement.adapter.ts` (`PROVIDER_STATEMENT`: validates each line with the zod/`D/reconciliation-matcher.ts` rules, yields `INVALID_PROVIDER_RECORD` by position only, skips unknown/`transfer` types, maps provider failures to a typed unavailable error, never stores raw bodies) and `P/testing/fake-provider-statement.ts`
- [X] T100 [US5] Implement `P/infra/reconciliation.store.ts` (`RECONCILIATION_STORE`: claim run with lease, stage/seen, promote in one transaction via `TransactionRunner.run`, auto-close, gauges) and `P/application/reconciliation-run.service.ts` (claim → page loop with backpressure and heartbeat → match against `LedgerJournal` references only (no `Payment` read, D-12) → stage → one promotion transaction → events/metrics → catch-up of `RECONCILIATION_CATCHUP_DAYS` days via `D/reconciliation-window.ts`; stops requesting pages on shutdown)
- [X] T101 [US5] Rewrite `P/infra/reconciliation.jobs.ts` for `payments.reconcile-daily` (clock injected, no `Date.now()`, `declareJobType` + payload contract, schedule/enqueue with `maxAttempts: 3`, catch `InvalidScheduleError`, `TransactionRunner.run`); delete its `sequelize.transaction` site and its `// S54 T037 audit` comment; remove the temporary stub from T060
- [X] T102 [US5] Run `test-spec.sh libs/domains/payments/reconciliation-run`; fix until AS-38…50 are green

---

## Phase 8: US6 — finance operators work the issue queue (P2)

**Goal**: admin list/resolve API, idempotent resolve with a balanced adjustment in one transaction.

**Independent test**: `test-spec.sh libs/domains/payments/reconciliation-issues` (AS-51…AS-59). Depends on US1, US5.

### Tests — `P/reconciliation-issues.e2e-spec.ts`, describe "Reconciliation: issue board and resolution"

- [X] T103 [US6] AS-51: runs newest first with cursor; issues 20/20/5 with no repeat/skip while new ones arrive; filters `status`/`kind`/`day`; `limit` 0/201, bad `status`/`kind`, tampered cursor → `400`; bodies parse with the page schemas
- [X] T104 [US6] AS-52: `401` on all three routes; seller owner `403 permission_denied` with no run/issue data in the body
- [X] T105 [US6] AS-53: resolve `explained` → `200` `RESOLVED`, resolver, time, note; no journal; open gauge drops
- [X] T106 [US6] AS-54: resolve `adjusted` → one `ADJUSTMENT` journal with deterministic id (`issue:<id>`), `postedAt` = now, `correctsDay` = `D`, linked via `adjustmentJournalId`; same transaction as issue change, history row and event; entries of day `D` and the closed run unchanged
- [X] T107 [US6] AS-55: the ten bad bodies → their statuses (`400`/`422`), issue/books/outbox unchanged
- [X] T108 [US6] AS-56: resolving a resolved (also auto-resolved) issue → `409 issue_already_resolved`; unknown id → `404 reconciliation_issue_not_found`
- [X] T109 [US6] AS-57: replay → stored `200` + `Idempotency-Replayed: true`, one journal; in flight → `409 idempotency_in_flight` + `Retry-After`; different body → `422 idempotency_key_reuse`; missing key → `422 idempotency_key_required`
- [X] T110 [US6] AS-58: two admins resolve at once ×50 → one `200`, one `409`, ≤ 1 journal, one history entry, one event
- [X] T111 [US6] AS-59 (gate 9): 31st write in a minute `429` + `Retry-After`; limiter store down → refused (fail closed), no journal

### Implementation

- [X] T112 [US6] Implement `P/application/reconciliation-query.service.ts` (keyset pages with signed cursors `(startedAt DESC, id DESC)` / `(createdAt DESC, id DESC)`, `limit` 1–200 default 50) and `P/application/issue-resolution.service.ts` (checks in the order of `contracts/http.md`; one `TransactionRunner.run`: conditional update `WHERE status='OPEN'`, `postJournal` `ADJUSTMENT` with `correctsDay`, history row, `reconciliation_issue_*` event)
- [X] T113 [US6] Implement `P/api/reconciliation.controller.ts` (`GET /finance/reconciliation/runs`, `GET /finance/reconciliation/issues`, `POST /finance/reconciliation/issues/:issueId/resolve` with `@Idempotent()`, `@RateLimit('finance.admin.read'|'finance.admin.write')`, `Firewall()` + admin guard (`P/api/admin.guard.ts` only if T003 found no identity equivalent), request DTO from `resolveReconciliationIssueRequestSchema`) and register problem codes in `LEDGER_PROBLEMS`
- [X] T114 [US6] Run `test-spec.sh libs/domains/payments/reconciliation-issues`; fix until AS-51…59 are green

---

## Phase 9: US7 — housekeeping and safe migration (P2)

**Goal**: partitions ahead, default-partition relocation, bounded invariant checker with read-model repair, single-run jobs, resumable backfill, guarded contract.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-maintenance` (AS-60…AS-64). Depends on US1, US4.

### Tests — `P/ledger-maintenance.e2e-spec.ts`, describe "Ledger: partitions, invariant checker, jobs and backfill"

- [X] T115 [US7] AS-60: current + 3 months exist with commit-time check and append-only protection; second run no-op; existing partition skipped
- [X] T116 [US7] AS-61: posting into an uncovered month succeeds via the default partition, `ledger_default_partition_rows` > 0 and alert; maintenance relocates rows with counts/sums/balances unchanged, gauge 0; a `2026-10-31T23:59:59.999Z` journal sits in one partition with one `postedAt`
- [X] T117 [US7] AS-62 (gate 9): healthy → no violation; (a) unbalanced, (b) edited balance, (c) edited read-model value → `ledger_invariant_violations_total{check}` increments for exactly its check, ids logged, (c) repaired, (a)/(b) untouched, job succeeds; bounded to two closed days
- [X] T118 [US7] AS-63: two workers per job at once → one works; running twice ≡ once (sweep, checker, partitions, reconciliation); every schedule row has `maxAttempts = 3` and a registered payload contract rejecting a bad payload
- [X] T119 [US7] AS-64: legacy-shaped rows (incl. `MERCHANT_<uuid>` lines) backfilled in 5 000-row batches under concurrent postings; balances equal sums; interrupted run resumes; rerun no-op; checker green; contract migration refuses until count and checksum equal; no lock held > 3 s
- [X] T120 [US7] Provider-account takeover: `ProviderAccount` rows equal `Shop.stripeAccountId` after the expand migration (copy test, test-code raw SQL only) and `PayoutJobs` reads the new table (S03 follow-up)

### Implementation

- [X] T121 [US7] Implement `P/application/partition-maintenance.service.ts` (ensure current + 3 months with both triggers, relocation of the default via `ledger_relocate_default`, gauge) and job `ledger.ensure-partitions`; delete `P/infra/ledger-maintenance.jobs.ts` (A20)
- [X] T122 [US7] Implement `P/application/invariant-check.service.ts` (checks: journal sum 0, `AccountBalance` = checkpoint + entries since in one statement, read-model vs balance with repair; keyset pages of 5 000; advances `LedgerCheckpoint` to the end of the last closed day) and job `ledger.verify-invariants` (A21)
- [X] T123 [US7] Implement `P/application/balance-backfill.service.ts` + job `ledger.backfill-balances` (5 000-row keyset batches each its own transaction with `lock_timeout 3s`, cursor in `LedgerBackfillCursor`, headers from legacy journal ids, `AccountBalance` from per-account sums, checkpoints, read-model seed, resumable and idempotent)
- [X] T124 [US7] Register `declareJobType` + payload contract and schedules for all `P/infra/ledger.jobs.ts` jobs (`ledger.sweep-hot-accounts`, `ledger.ensure-partitions`, `ledger.verify-invariants`, `ledger.backfill-balances`, `ledger.settle-order`) next to their `JobPayloads` augmentations; `maxAttempts: 3` (settle-order 1); catch `InvalidScheduleError`; fleet concurrency 1 plus conditional claim; confirm no `JobsService.cancel` caller exists in the domain (T003)
- [X] T125 [US7] Adapt `P/infra/payout.jobs.ts`: use `postJournal` (`PAYOUT`, `PAYOUT_REVERSAL`), `listSellerBalances`, `PROVIDER_ACCOUNT_REPOSITORY` (`P/infra/provider-account.repository.ts`), `TransactionRunner.run` for its 3 direct sites (delete their `// S54 T037 audit` comments); remove `Shop` registration from `P/finance-worker.module.ts`/`P/ledger-worker.module.ts`; `declareJobType` + `maxAttempts: 3` on its jobs
- [X] T126 [US7] Write `packages/backend/migrations/<ts>-s14-ledger-contract.js` (later deploy): raises unless count and checksum of `LedgerEntry_legacy` equal migrated rows, then drops it and removes `STATUS_MISMATCH` from the issue kind check; the `LedgerEntry.paymentId → Payment` FK drop for the switch goes in the same expand-switch step or a short `DROP CONSTRAINT` migration with `lock_timeout`
- [X] T127 [US7] Run `test-spec.sh libs/domains/payments/ledger-maintenance`; fix until AS-60…64 and T120 are green

---

## Phase 10: US8 — safe, observable, well-bounded domain (P3)

**Goal**: metrics/logs/trace, no secrets, validated config, graceful shutdown, ownership and barrel boundaries.

**Independent test**: `test-spec.sh libs/domains/payments/ledger-ops` plus static gates (AS-65…AS-69).

### Tests — `P/ledger-ops.e2e-spec.ts`, describe "Ledger: observability, secrets, configuration and shutdown"

- [X] T128 [US8] AS-65: every metric of `contracts/services.md` exists and moves over the AS-01/02/22/30/38/45 flows; log lines carry `requestId`/`traceId` and `journalId`/`runId`; one trace spans posting, outbox row and projector
- [X] T129 [US8] AS-66: sentinel provider secret and buyer email absent from logs, events, outbox payloads, issue `details` and error bodies; raw provider bodies never stored; `5xx` has a generic `detail`
- [X] T130 [US8] AS-67 static block (in `ledger-ops.e2e-spec.ts`, reading source files): no `User`/`Payment`/`BisOrder`/`Shop` import, association, or raw SQL in ledger/reconciliation files; barrel exports only the "Provides" list (no model); no `sequelize.transaction` and no `S54 T037 audit` left in `P/` non-spec files; registry lists every new table under `domain:payments`
- [X] T131 [US8] AS-68: boot with fee 0/negative, shards 0/257, non-positive timeouts, missing provider key, page size 0/101, catch-up 0/31 → fails naming the setting and does not serve
- [X] T132 [US8] AS-69 (gate 9): stop during paging → no further page requested, run `FAILED(interrupted)` or lease expires, next attempt per AS-43; settlement consumer finishes its message then stops; every statement and provider call carries a timeout

### Implementation

- [X] T133 [US8] Wire startup validation of `ledger-config.ts` into `P/ledger.module.ts`/`ledger-worker.module.ts`; log fields (`requestId`, `traceId`, `journalId`, `runId`), redaction, trace propagation through outbox and projector; graceful stop of the reconciliation runner and settlement consumer (A26, A28)
- [X] T134 [US8] Replace the barrel `P/index.ts` with exactly: `LedgerModule`, `LedgerWorkerModule`, `LedgerProjectorModule`, `LedgerService`, `LEDGER_ACCOUNTS`, `shopAccount`, `LedgerJournalKind`, `JournalPosted` (plus S13's unchanged exports); remove `FinanceModule`, `FinanceWorkerModule`, `BalanceProjector`, `LedgerEntryModel`, `PayoutModel`, `CreateLedgerEntryDto`, `SystemAccount`, `LedgerAccountId` (D-7, D-8); swap imports in `apps/core/src/core.module.ts`, `apps/worker/src/worker.module.ts`, `apps/projector/src/projector.module.ts`, `apps/payment-processor` (imports `LedgerModule`)
- [X] T135 [US8] Adapt consumers of the deleted `post`/`balance`: `libs/domains/marketing/infra/ad-billing.jobs.ts` and `marketing/ads.e2e-spec.ts` to `postJournal` (`AD_CHARGE`, reference `campaignId:hour`) and `getBalances`; `packages/backend/test/seeds/{types.ts,seeds.module.ts,seeds.service.ts}` stop importing `LedgerEntryModel` (raw inserts, test code only); record the S36 remainder in `gaps.md` sibling bullets (already present)
- [X] T136 [US8] Delete `P/finance.e2e-spec.ts`, `P/finance.module.ts`, `P/finance-worker.module.ts`, `P/api/ledger.dto.ts` old DTOs (replace with `P/api/ledger.dto.ts` request DTO classes if needed); delete `LedgerService.post`/`balance`/`recordMarketplaceSale` remnants; `tsc --noEmit` green for `packages/backend`
- [X] T137 [US8] Run `test-spec.sh libs/domains/payments/ledger-ops`; fix until AS-65…69 are green

---

## Phase 11: Polish and whole-capability proof (WP-12)

- [X] T138 Sibling-spec follow-ups: verify `gaps.md` `## Sibling-spec follow-ups` still matches what was built (S01, S03, S10, S13 incl. any `refundRef` transition edit, S15, S16, S36, S40, S28, S50, S53, S54, W04, J01); add bullets for anything new; do not edit any sibling spec
- [X] T139 Unverified criteria: confirm SC-004 and SC-005 (percentile) stay under "Ops artifacts" in `quickstart.md` and as the two S14 rows in `specs/UNVERIFIED.md` with status `not run`; add a row for any other criterion no test proves
- [X] T140 Run the whole capability once: `test-spec.sh libs/domains/payments`, then dependents `libs/domains/marketing`, `libs/domains/orders`, `libs/infrastructure/rate-limit`, `libs/infrastructure/idempotency`, `libs/infrastructure/events`, `libs/infrastructure/projections`, `libs/infrastructure/jobs`, `libs/domains/identity` (ownership gates), `libs/domains/tenancy`
- [X] T141 Static gates: `npx tsc --noEmit -p tsconfig.json`, `npx eslint libs/domains/payments libs/domains/marketing libs/infrastructure/stripe libs/common/config`, `(cd ../contracts && npx tsc --noEmit)`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (payments: 0 S14 rows; record against the baseline of 3), `pnpm check:module-graph`, `pnpm check:no-wallclock`, `pnpm check:model-registry`, `grep -rn "sequelize.transaction" libs/domains/payments --include=*.ts | grep -v spec` = 0 (baseline 4), `python3 scripts/livespec/check.py` from repo root
- [X] T142 Update the S14 living-spec page `[proof:]`/`[code:]` clauses to the final file names, re-run `check.py`; record the green run in `gaps.md` (VII.9) and write the implementation report listing every inherited follow-up (S01 UserModel, S03 `stripeAccountId`/`ProviderAccount`, S10 `order.paid` split, S13 native methods and `paymentId` decision, S49 `declareJobType`/`maxAttempts: 3`) with its proving task

---

## Dependencies and execution order

- Phase 1 → Phase 2 (blocks all). Inside Phase 2: T005–T007, T008–T017 [P]; T018 after T008–T014; T019 after T015–T017; T024→T025→T026 (T028–T030 after T024/T025).
- US1 (Phase 3) after Phase 2 → MVP. US2 after US1. US3 after US1 and US2 (shard wiring touches capture). US4 after US1 (AS-36 uses `postJournal` only). US5 after US2 (journals to match) and may run in parallel with US3/US4. US6 after US5. US7 after US1 and US4 (read-model repair, backfill). US8 last (barrel and deletions need every caller moved).
- Within a story: test tasks first (all [P]-style independent scenarios in one file are written together), then store → service → controller/consumer → run.
- Rule 4 per file: `reconciliation.jobs.ts` (1 site, T101) and `payout.jobs.ts` (3 sites, T125) migrate when touched; baseline 4 → 0.

## Parallel examples

- Phase 2: T005, T006, T007 and the nine unit specs T008–T017 touch different files and run together.
- After US2: US3 (T062–T069), US4 (T070–T084) and US5 (T085–T102) can be staffed in parallel; they share only `ledger.module.ts` and `ledger.service.ts` (serialize those edits).
- US6 test tasks T103–T111 are independent scenarios in one file; write them in one pass.

## Implementation strategy

- **MVP**: Phase 1, Phase 2, US1 (T001–T044): a correct, idempotent, bounded posting path. Then US2 for the money trail of a purchase.
- **Incremental**: US3 → US4 → US5 (all P1) → US6/US7 (P2) → US8 (P3) → Phase 11. Each phase ends with its narrowest `test-spec.sh` run; the whole capability suite runs once at T140.
- **Stop rule**: after 5 failed fixes of the same test, write the blocker into `questions.md` and stop.

## Gap coverage (every `gaps.md` item has a task)

A1 T041/T080 · A2 T067/T068 · A3 T020/T042 · A4 T041 · A5 T043/T057 · A6 T048–T050/T057 · A7 T056/T060 · A8 T007/T010 · A9 T058 · A10 T058 · A11 T082 · A12 T083 · A13 T113 · A14 T100 · A15 T100/T101 · A16 T095/T101 · A17 T091/T100 · A18 T096/T112 · A19 T023/T024 · A20 T116/T121 · A21 T117/T122 · A22 T024/T123 · A23 T029 · A24 T043/T083 · A25 T022/T113 · A26 T021/T133 · A27 T098/T099 · A28 T007/T133 · A29 T001/T136 · D-6 T043 · D-7 T134/T135 · D-8 T134 · D-11 T030/T060 · D-12 T100/T125 · D-15 T141 · D-17 T029/T060 · C (3 S14 rows) T030 · Shop rows T125 · D contracts T059/T135/T138 · E1 T024–T026 · E2 T123 · E3 T042/T126 · E4 T126/T119 · E5 T024.
