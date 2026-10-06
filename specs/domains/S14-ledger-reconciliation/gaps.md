# Gaps: S14 — current `payments` ledger code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/payments/` unless stated; line numbers are those read on 2026-10-05. Scenario IDs refer to [`spec.md`](spec.md); the questions behind each row are in [`questions.md`](questions.md). Section C is the real output of `pnpm --dir packages/backend check:table-ownership` for `payments` (run on 2026-10-05, exit 0).

Order of work is at the end (section F).

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | No running balance exists: every balance read is `SUM(amount)` over all entries (`balance()`), the payout run sums the whole table, and the invariant checker sums the whole book. No per-account version, so no version-guarded read model, no cheap payout guard | `application/ledger.service.ts:113-118`; `infra/payout.jobs.ts:53-55`; `infra/ledger-maintenance.jobs.ts:43` | FR-022, FR-023, AS-28, AS-29 |
| A2 | No hot-account sharding; no sorted lock order (there are no balance rows to lock, so nothing is deadlock-safe the day one is added); SD-20 records sharding as "not needed (D6)" | `domain/accounts.ts:7-11`; `docs/showcase/sections/SD-20-payments-ledger-reconciliation.md:26` | FR-018–FR-021, AS-22–AS-27 |
| A3 | `post()` validates only the sum and safe integers; no 2-line minimum, no 200-line cap, no zero-line refusal (zero lines are silently dropped), no currency, no account grammar, no reference, no kind allow-list; `InternalServerErrorException` is thrown for an unbalanced journal (an HTTP type from the application layer, and a 500 for a caller error) | `application/ledger.service.ts:87-95,97-104` | FR-001, FR-004, FR-008, FR-010, AS-02, AS-04, AS-05 |
| A4 | No uniqueness per (kind, reference): callers invent journal IDs (`paymentId`, `uuidv5`, `uuidv7()`), and idempotency relies on each caller (an advisory lock plus `EXISTS` in settlement, a primary key in ad billing, `ON CONFLICT` on `Payout`); the entries table cannot carry a unique journal ID because its primary key is `(id, createdAt)` and the table is partitioned | `infra/settlement.listener.ts:52-58`; `infra/payout.jobs.ts:59-72`; `marketing/infra/ad-billing.jobs.ts:92-101`; migration `20261001160000-ledger-partitioning-payouts-recon.js:40-49` | FR-005, AS-07, AS-08 |
| A5 | `recordMarketplaceSale` wraps its work in `wrapInTransaction(…, tx)` (a nested transaction opened in the application layer by a callee) and takes account IDs and a fee from the caller; returns nothing; throws `InternalServerErrorException` | `application/ledger.service.ts:28-77` | FR-006, FR-011, FR-013, AS-09, AS-11 |
| A6 | No refund journal: a refund posts nothing | `application/payment.service.ts` (no call); `infra/payment-resolution.jobs.ts:68-77` (sales only) | FR-014, AS-14–AS-16 |
| A7 | The sale debits a per-buyer account named `MERCHANT_<userId>` (wrong name, and `bisUtilsService` exists only for this); credits `CLEARING` and `PLATFORM_FEES`; no `PROVIDER_CLEARING` | `application/payment.service.ts:251-262`; `application/bis-utils.service.ts`; `bis-utils.module.ts`; `api/ledger.dto.ts:30` | FR-010, FR-012, FR-013, AS-11 |
| A8 | Two fee constants disagree (50 and 100); the fee is a code constant, not a validated setting | `domain/accounts.ts:17`; `api/ledger.dto.ts:34` | FR-011, AS-68 |
| A9 | Settlement reads fields that S10's contract renames (`total`, `paymentId`, `lines[].price/quantity`), recomputes the net as `total − fee` instead of using the sale's clearing credit, splits by line totals instead of `shopOrders[].subtotalMinor`, ignores the currency, has a `pay_` prefix hack for `paymentId`, never defers when the sale is missing, never checks a refund, and a bad payload throws out of `project()` | `infra/settlement.listener.ts:34-69` (45-48, 63) | FR-015–FR-017, AS-17–AS-21 |
| A10 | Settlement runs as a "projector" with no dead-letter reasons, no retry schedule and no zod validation of its own | `infra/settlement.listener.ts:20-38`; `finance-worker.module.ts:26` | FR-016, AS-19, AS-20 |
| A11 | `ledger.journal_posted` v1 carries deltas and no balance, shard or version; the projector dedupes with a 14-day `SET NX` marker and applies `HINCRBY`; the hash has no expiry and there is no durable copy (the domain map names Redis and DynamoDB), no lag metric, no stale metric | `application/events/ledger-events.ts:5-8`; `infra/balance.projector.ts:16,28-41` | FR-024–FR-026, AS-30, AS-31, AS-37 |
| A12 | Balance endpoint: reads Redis directly from the controller (`RedisService`, `BALANCES_KEY` imported from `infra/`), returns `{available, source}` untyped, no `currency`, no `asOf`, no durable store step, no `?currency`, no rate limit; `GET payouts` returns the `Payout` model through `findAll` (V.1) | `api/finance.controller.ts:12-17,28-39` | FR-027, AS-32–AS-36 |
| A13 | No operator API for reconciliation: no list of runs or issues, no resolve, no admin guard, no idempotency, no rate limit | (absent) | FR-038–FR-041, AS-51–AS-59 |
| A14 | Reconciliation compares provider *payment intents* to the `Payment` table (a table read by raw SQL in the ledger code), not the balance-transaction statement to journals; ignores refunds and disputes; no `CURRENCY_MISMATCH`, `DUPLICATE_AT_PROVIDER`, `INVALID_PROVIDER_RECORD`; no boundary lookup | `infra/reconciliation.jobs.ts:53-58,63-76` | FR-028–FR-031, AS-38–AS-40, AS-46, AS-47 |
| A15 | The run record has only `finishedAt`: no status, no lease, no failure code, no counts for skipped; `ON CONFLICT … DO UPDATE SET provider = EXCLUDED.provider` is a no-op upsert used to read the row; concurrent runs both proceed; a re-run `DELETE`s the issues; no unique issue key; provider failure throws with no `FAILED` record; no retry policy or timeout of its own | `infra/reconciliation.jobs.ts:43-50,79-90`; migration `…:120-139` | FR-032, FR-034, AS-41–AS-45, AS-50 |
| A16 | Day handling: yesterday is `Date.now() − 86 400 000` (a clock call in the application, constitution I.3 style); `day` is not validated; no closed-day or 90-day rule; no catch-up of missed days | `infra/reconciliation.jobs.ts:39-41` | FR-033, AS-48 |
| A17 | Paging: `paymentIntentsCreatedBetween` streams intents with `for await` (good: P0102), but the whole of our side of the day is loaded into a `Map` and results are kept in memory until the end; no page-size, backpressure or heartbeat contract, no per-call timeout visible | `infra/reconciliation.jobs.ts:56-77`; `libs/infrastructure/stripe/stripe.service.ts:212` | FR-029, AS-44 |
| A18 | No auto-resolution of timing-only issues; no `OPEN`/`RESOLVED` status (a nullable `resolvedAt` column only); no events for runs or issues; no metrics for runs or open issues | migration `…:130-139`; `infra/reconciliation.jobs.ts` | FR-035, FR-037, AS-49, AS-65 |
| A19 | Entries are "immutable" by `updatedAt: false` only; the store accepts `UPDATE` and `DELETE`; the commit-time trigger fires on `INSERT` only | `infra/models/ledger-entry.model.ts:81-86`; migration `…:60,74,100` | FR-003, AS-06 |
| A20 | Partitions: created by a monthly function and cron on the 1st; a posting into a month without a partition goes to the default partition and a later `CREATE` of that month's partition fails because the default holds rows for it; no alert, no gauge, no relocation; a journal's lines take the DB's `now()` per row, not one `postedAt` | `infra/ledger-maintenance.jobs.ts:26,36-39`; migration `…:52-64,73-74`; model `createdAt` default | FR-007, FR-042, AS-60, AS-61 |
| A21 | Invariant checker: whole-book `SUM`, a `LIMIT 100` over two days, log line plus one counter with no `check` label, no balance-vs-entries check, no read-model check or repair | `infra/ledger-maintenance.jobs.ts:42-55` | FR-043, AS-62 |
| A22 | No journal header table, no account balance table, no `postedAt`/`correctsDay`/references columns, no `orderId`, `paymentRef`, `refundRef`; `paymentId` is a foreign key to `Payment`; buyer-account legacy lines exist; `LedgerEntry_legacy` is still in the database | migration `…:44,76-78,80-82` | FR-005, FR-012, FR-022, FR-045, AS-64 |
| A23 | The model file carries unrelated clutter (`PaymentReason`, `PaymentStatus`, `PaymentWithAllFilters`, a payment `Scopes` block) and imports `UserModel` and the `Payment` model | `infra/models/ledger-entry.model.ts:18-80` | FR-046, AS-67 |
| A24 | `application/` and `api/` import `infra/` classes directly: `LedgerService` injects `LedgerEntry` (`@InjectModel`), `FinanceController` injects `RedisService`/`Payout`; no repository ports in `domain/` | `application/ledger.service.ts:6-17,20-27`; `api/finance.controller.ts:1-9` | I.2, FR-046 |
| A25 | No `Idempotency-Key`, no rate limits and no problem codes exist for any of the HTTP routes this capability needs | `api/finance.controller.ts` | FR-039–FR-041, FR-050 |
| A26 | No metrics other than `ledger_invariant_violations_total` (unlabelled); no lock-wait histogram, no rejection reasons, no projection lag, no reconciliation metrics | `infra/ledger-maintenance.jobs.ts:17` | FR-048, AS-65 |
| A27 | Statement and statement-line port missing: the provider's balance transactions are not exposed (`StripeService` lists payment intents only) | `libs/infrastructure/stripe/stripe.service.ts:212` | FR-028, AS-45, AS-46 |
| A28 | No configuration schema for fee, shard count, timeouts, provider page size, catch-up window | (absent) | FR-049, AS-68 |
| A29 | Existing tests cover happy paths with the old API and use models directly: `ShopModel`, `Payment`, `Outbox` model tokens, `seeds.createTreelike` for `BisOrder`; they call `ledger.post`, `ledger.balance`, `listener.project`, and reconcile against `Payment` rows; none covers concurrency, replay, idempotency conflicts, refunds, cross-tenant, rate limits, the HTTP balance route, or the operator API | `finance.e2e-spec.ts:1-177` (imports 1-25; tests 62-176) | all |

## B. Open debt-register rows that name `payments` or S14

| Row | What it is for this capability | Replacement (IX.7 mechanism) |
|---|---|---|
| **D-6** (I.2) | `LedgerService` injects a model; the balance controller imports `infra/`; no ports in `domain/` | repository ports and tokens in `domain/` (journal, balance, read-model, reconciliation, statement), adapters in `infra/`; the service reaches them only by token (A24) |
| **D-7** (IX.4) | Other domains import payments models; payments' own ledger model imports `UserModel`; the barrel exports `LedgerEntryModel`, `PayoutModel`, `PaymentModel` | no mechanism needed inside the ledger: it needs no user data (plain `userId` on the journal). Consumers use **R1** `LedgerService` (`getBalances`, `postJournal`). After the consumers move, drop `LedgerEntryModel` from the barrel (`PaymentModel` is S13's, `PayoutModel` is S15's). The seeds (`test/seeds/types.ts:5`, `seeds.module.ts:6`, `seeds.service.ts:19`) must stop importing `LedgerEntryModel` from the barrel: raw inserts in test code only (IX.6) |
| **D-8** (X.4) | Barrel exports `BalanceProjector`, `LedgerEntryModel`, `PayoutModel`, `FinanceModule`, `FinanceWorkerModule`, `LedgerModule`, `CreateLedgerEntryDto`, `SystemAccount` (`index.ts:7-21`) | export only `LedgerModule`, `LedgerWorkerModule`, `LedgerProjectorModule`, `LedgerService`, `LEDGER_ACCOUNTS`, `shopAccount`, `LedgerJournalKind`, `JournalPosted`; `apps/projector` (`projector.module.ts:21`), `apps/worker` (`worker.module.ts:23`), `apps/core` (`core.module.ts:22`) import the modules instead of `BalanceProjector`/`FinanceModule`/`FinanceWorkerModule` |
| **D-11** (X.5) | `ledger.module.ts` registers `BisOrderModel` and `UserModel` it never uses; `ledger-entry.model.ts` ↔ `payment.model.ts` mutual associations. The orders ↔ payments cycle itself is S10/S13's | drop both registrations and the association (plain `paymentId`, `orderId` columns); settlement uses the **R3** event `order.paid` (event contract through orders' entry point is allowed, X.5) |
| **D-12** (IX.4) | No raw SQL on a table the ledger does not own remains in the ledger or reconciliation code except the reconciliation read of `Payment` (A14) | statement-versus-journal matching reads only ledger tables (journal references carry `paymentRef`/`refundRef`); no replacement needed. `payout.jobs.ts` (`Shop`) is S15's (**R1** `ShopQueryService.getShopsByIds` and a payments-owned table for the provider account id) |
| **D-15** (X.5) | payments is in the strongly connected component {catalog, discovery, experimentation, orders, payments} through D-11 | the ledger's part is removed with D-11 above |
| **D-17** (X.5) | `payment.model.ts` ↔ `ledger-entry.model.ts` file-level cycle | remove `BelongsTo(Payment)` / `ForeignKey` from the ledger model and `HasMany(LedgerEntry)` from `Payment` (shared with S13) |

## C. `check:table-ownership` lines for `payments` (real run, 2026-10-05)

```
payments  (7)
  SQL   Product      owned by catalog   application/payment.service.ts                  → S13: R3 order copy (never stock SQL)
  MODEL UserModel    owned by identity  infra/models/ledger-entry.model.ts              → S14: plain userId; no association, no import
  MODEL UserModel    owned by identity  ledger.module.ts                                → S14: drop the registration; no user data needed
  MODEL BisOrderModel owned by orders   infra/models/payment.model.ts                   → S13: plain orderId, order copy via R3
  MODEL BisOrderModel owned by orders   ledger.module.ts                                → S14: drop the registration; settlement uses R3 event
  MODEL ShopModel    owned by tenancy   finance-worker.module.ts                        → S15: R1 ShopQueryService; provider account id in a payments table
  MODEL ShopModel    owned by tenancy   infra/payout.jobs.ts                            → S15: same
```

Also in the report, lines in other domains that name this domain's models (they are those domains' work, listed so the barrel cleanup is not forgotten): `MODEL PaymentModel` in `orders/api/stripe-webhook.controller.ts`, `orders/infra/models/bis-order.model.ts`, `orders/orders.module.ts` → S10/S13 (**R1** `getPaymentStatus`, payment events). Marketing's use of `LedgerService`, `LedgerModule`, `shopAccount`, `LEDGER_ACCOUNTS` (`marketing/infra/ad-billing.jobs.ts:8,35`, `marketing/ads.module.ts:6`, `marketing/ads.e2e-spec.ts:12,87,101`) is an allowed **R1** use of an exported service: S36 switches to `postJournal` and `getBalances`.

**Done when**: for the files of this capability the check reports 0 findings under `--strict`; the three S14 lines above are gone; the S13 and S15 lines are the other capabilities' to remove.

## D. Contract gaps with other capabilities (what S14 needs to exist before it can be proven)

- **S13** must call the new `recordPaymentCaptured` (adds `orderId`, `paymentRef`) and `recordPaymentRefunded` (adds `refundRef`) and use the returned `created`; until then the old `recordMarketplaceSale` can be wrapped behind the same names inside the domain. S13's `gaps.md` already lists the swap (A15 there).
- **S10** must publish `order.paid` with `totalMinor`, `currency`, `paymentRef` and `shopOrders[{shopOrderId, shopId, subtotalMinor}]` on `orders.events`; until then the settlement consumer cannot read the event it listens to today.
- **S15** must adopt `postJournal` kinds `PAYOUT` / `PAYOUT_REVERSAL`, `getBalances` and `listSellerBalances`, drop its raw `LedgerEntry` SQL (`payout.jobs.ts:53`) and take over `GET /shops/:shopId/payouts`, the `Payout` model and the provider account id.
- **S36** must replace `LedgerService.post` / `balance` and `LedgerModule` with `postJournal` (kinds `AD_CHARGE`, `ADJUSTMENT`), `getBalances`, and a stable `reference` per (campaign, hour).
- **S53** must offer `outbox.append`, consumer retry-with-backoff and dead-letter reasons, and the version-guarded projector helper; the settlement deferral (AS-20) needs the delayed retry.
- **S50** must register the three `finance.*` policies; **S49** the five jobs; **S54** the idempotency facility for the resolve route.
- **S03** must keep `ShopScoped('payouts.read')`; **S01** must expose the `admin` role for the finance routes.
- **The payment provider adapter** (`libs/infrastructure/stripe`, thin client only) must gain a balance-transaction listing; the domain port and the validating adapter live in `payments`.
- `packages/contracts` gains `balanceSchema`, `reconciliationRunPageSchema`, `reconciliationIssuePageSchema`, `reconciliationIssueSchema`, `resolveReconciliationIssueRequestSchema` and the three event schemas (V.2, VII.6).

## E. Migrations (expand/contract, III.11)

All migrations set `lock_timeout` (≤ 3 s) and run as a separate deploy step. Registry entries (`db/ownership.ts`) are added in the same PR as each table, owner `domain:payments`; the domain map's "Owns" list gains `LedgerJournal` and `AccountBalance`.

1. **Expand**: `LedgerJournal` (journal ID, kind, reference, currency, `postedAt`, references; unique `(kind, reference)`); `AccountBalance` (account, shard, currency, `balanceMinor`, `version`; unique per key; no foreign keys); new columns on entries (`shard`, `postedAt` mirrored from `createdAt`, journal references) with no rewrite; `ReconciliationRun` gains `status`, `startedAt`, `leaseUntil`, `failureCode`, `providerLines`, `ledgerJournals`, `skipped`; `ReconciliationIssue` gains `status`, `resolution`, `note`, `resolvedBy`, `adjustmentJournalId`, `day`, unique `(runId, kind, reference)`, kinds widened (`CURRENCY_MISMATCH`, `DUPLICATE_AT_PROVIDER`, `INVALID_PROVIDER_RECORD`); the append-only guard (reject `UPDATE`/`DELETE`) on every partition and on partitions created later; the commit-time balance check kept.
2. **Backfill** (job `ledger.backfill-balances`, batches of 5 000, keyset, resumable, idempotent): journal headers from existing journal IDs, `AccountBalance` from per-account sums (legacy `MERCHANT_<uuid>` lines stay as history), mirrored `postedAt`.
3. **Switch** (code deploy): postings write headers, balances, shards, `postedAt`; reads use balances; `LedgerEntry.paymentId` foreign key dropped (`NOT VALID` first, no table lock); partition-relocation support for the default partition.
4. **Contract** (later deploy, after the verification of AS-64): drop `LedgerEntry_legacy` once count and checksum match; remove the mirrored columns no code reads; remove `STATUS_MISMATCH` from the allowed kinds.
5. `ledger_ensure_partitions` is made safe when the default partition holds rows for the month being created (detach default, create, move, re-attach, in short transactions).

## F. Suggested order of work

1. Pure domain code with tests first: `journal.ts` (validation), `account.ts`, `fee.ts`, `shard.ts`, `settlement-split.ts`, `lock-order.ts`, `balance-version.ts`, `reconciliation-matcher.ts`, `reconciliation-window.ts`, `run-state.ts`, `issue-state.ts` (all unit specs of the test plan).
2. Migrations 1–2 (expand, backfill job); registry entries; remove the model clutter, foreign keys and foreign registrations (A19, A22, A23, D-7, D-11, D-17).
3. Posting service with ports and adapters (A1, A3–A5, A24): journals, balances, shards, sorted locks, bounded waits, event v2; `ledger-posting` and `ledger-hot-accounts` specs.
4. Capture and refund (A5–A8), settlement consumer (A9, A10) with S13 and S10 changes; `ledger-payment-postings` spec.
5. Read model projector and the balance endpoint (A11, A12, A25), contracts, rate limit; `ledger-balances` spec; barrel and module cleanup (D-8).
6. Provider statement port and adapter (A27); reconciliation run, issues, catch-up, auto-resolution (A14–A18); `reconciliation-run` spec.
7. Operator API with idempotency and the adjustment (A13); `reconciliation-issues` spec.
8. Housekeeping: partitions, default-partition relocation, invariant checker, sweep job, single-run proofs (A19–A21); `ledger-maintenance` spec; contract migration after verification.
9. Observability and configuration (A26, A28); `ledger-ops` spec; `check:table-ownership --strict`, `check:boundaries`, `check:model-registry` green; record the green run (VII.9).
10. Swap callers: S13, S15, S36 to the new exports; delete `recordMarketplaceSale`, `post`, `balance`, `bis-utils` and the old exports in the same PR as the last caller.
