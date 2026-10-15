# Gaps: S15 — Seller payouts (domain `payments`)

What the current code gets wrong or lacks against [`spec.md`](spec.md). This is the implementation agent's to-do list. References are `file:line` under `packages/backend/libs/domains/payments/` unless stated. Decisions behind each item are in [`questions.md`](questions.md).

**Note on the ownership check.** `pnpm --dir packages/backend check:table-ownership` could not be run in the spec session (the command needed an approval that an unattended run cannot give). The findings below were therefore derived by reading the payout code, the module wiring and the barrel; the implementation agent MUST run the check first, record its output for the payments rows, and add any row not listed here.

## A. Behaviour gaps

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Ineligible shops get a payout row and a journal, then are reversed at send time; no eligibility gates (verification flag, shop status, destination, cooling) and no named skip reasons | `infra/payout.jobs.ts:61-77, 86` | FR-003, AS-09 |
| A2 | No reserve: the whole available balance is paid | `infra/payout.jobs.ts:52-56, 62-63` | FR-011, FR-012, AS-04, AS-05 |
| A3 | Minimum is a SQL `HAVING` on the raw sum before any reserve; no check of the amount after the reserve; no per-payout cap | `infra/payout.jobs.ts:20, 54-55` | FR-006, AS-06, AS-07 |
| A4 | Balances come from a raw `SUM` over every `SHOP_%` entry and the balance is trusted from that listing, not re-read inside the creation transaction | `infra/payout.jobs.ts:52-56, 58-60` | FR-002, AS-10 |
| A5 | The run loads every shop at once (no keyset paging) and runs shops sequentially with no per-shop error isolation: one failing shop aborts the run | `infra/payout.jobs.ts:57-79` | FR-002, FR-007, AS-11, AS-12 |
| A6 | No run record, no counts, no skip reasons, no resumable state; `periodStart` accepted as any string; no `period_invalid` | `infra/payout.jobs.ts:50-51, 129-134` | FR-001, FR-008, FR-010, AS-13, AS-47 |
| A7 | Payout creation and the queue entry are one transaction, but the event (`payout.created`) and history row do not exist | `infra/payout.jobs.ts:59-76` | FR-004, FR-043, AS-01, AS-16 |
| A8 | No claim step: the send job reads the payout and calls the provider with `PENDING` still set, so two deliveries can both reach the provider (only the provider's key protects against a double) | `infra/payout.jobs.ts:80-92` | FR-013, AS-18 |
| A9 | No `SENDING`, `UNKNOWN` or `CANCELLED` states, no resolver, no 24 h in-doubt signal; a timeout is rethrown and retried by the job layer with no state, so a payout can stay `PENDING` indefinitely | `infra/models/payout.model.ts:5`, `infra/payout.jobs.ts:105-108` | FR-017, FR-018, FR-022, AS-20–AS-22, AS-27 |
| A10 | Rejection is recognised by `definite` flag or `err.type === 'StripeInvalidRequestError'` (provider-specific, untyped); any other error is rethrown; a rejected provider answer after a lost success could reverse a payout that was paid | `infra/payout.jobs.ts:105-126`, `infra/payout-provider.port.ts:34-40` | FR-016, FR-019, AS-23, AS-24 |
| A11 | The provider's answer is not validated (amount, currency, destination, reference); the port returns only `{providerRef}` | `infra/payout-provider.port.ts:15-24` | FR-020, AS-25 |
| A12 | No provider timeout (10 s) and no lookup by reference; the Stripe call has no explicit timeout and the load-test branch returns a fake id | `libs/infrastructure/stripe/stripe.service.ts:222-229` | FR-016, FR-018, AS-20 |
| A13 | The destination is read at send time from `Shop.stripeAccountId`, so a change after creation redirects an existing payout; no snapshot, no cooling, no operator route | `infra/payout.jobs.ts:83-90` | FR-023, FR-028, FR-029, AS-26, AS-38, AS-39 |
| A14 | Journals go through `LedgerService.post` with ad hoc deterministic IDs (`deriveJournalId`), not S14's `postJournal` (once per `(kind, reference)`); the sent step and reversal use kind `PAYOUT` / `PAYOUT_REVERSAL` but with locally derived IDs and without the atomic non-negative guard | `infra/payout.jobs.ts:70, 98, 117, 138-141`, `application/ledger.service.ts:90-110` | FR-027, AS-10, AS-44 |
| A15 | Conditional updates exist (`WHERE status = 'PENDING'`) but there is no history row and no version, and no event leaves for any transition | `infra/payout.jobs.ts:93-95, 111-114` | FR-024, FR-044, AS-27, AS-50 |
| A16 | `GET /shops/:shopId/payouts` returns the ORM model, newest 52, unpaged; no DTO; no detail route; no upcoming route; no rate-limit policy | `api/finance.controller.ts:35-39` | FR-031–FR-035, AS-31–AS-36 |
| A17 | No operator API: no destination, reserve, cancel, admin list, run list; no `Idempotency-Key` handling | (absent) | FR-036–FR-041, AS-38–AS-48 |
| A18 | No daily payout audit against the provider | (absent) | FR-042, AS-49 |
| A19 | No metrics for payouts; the only signal is a `logger.warn` that may carry the provider message | `infra/payout.jobs.ts:127` | FR-051, FR-052, AS-51 |
| A20 | Configuration constants are hard-coded (`MIN_PAYOUT_MINOR`, schedule, lease) with no validation; no config for reserve, cap, cooling, timeouts | `infra/payout.jobs.ts:20, 46, 49` | FR-048, AS-54 |
| A21 | The run has no cooperative stop on shutdown | `infra/payout.jobs.ts:49-79` | FR-049, AS-55 |
| A22 | Money columns and fields named `amount` / `failureReason` as untyped `number` (BIGINT read as number); no `reserveHeldMinor`, `destinationSnapshot`, `attempts`, `payoutVersion` | `infra/models/payout.model.ts:15-33` | FR-046, Key Entities, AS-53 |
| A23 | Existing test asserts the old behaviour (whole balance sent, reversal when no account, models injected directly, `ShopModel.update({stripeAccountId})`) | `finance.e2e-spec.ts:98-126` | rewrite as `payout-run`, `payout-transfer` (AS-01, AS-17, AS-23) |

## B. Boundary and structure gaps (constitution I, IV, IX, X)

| # | Gap | Where | Replaced by |
|---|---|---|---|
| B1 | `PayoutJobs` injects `ShopModel` from tenancy to read `stripeAccountId` (IX.4: injecting another domain's model; D-7) | `infra/payout.jobs.ts:5, 38, 83` | S15-owned `PayoutDestination` (migration copies `Shop.stripeAccountId`, tenancy drops it); shop status and `payoutsEnabled` by **R1** `ShopQueryService.getShopsByIds` |
| B2 | `FinanceWorkerModule` registers `Shop` in `forFeature` (IX.4; D-7) | `finance-worker.module.ts:4, 23` | removed; `PayoutsWorkerModule` registers only payout tables |
| B3 | Raw SQL reads `LedgerEntry` from the payout code (`SUM … LIKE 'SHOP\_%'`); S14 owns ledger access and the balance read model | `infra/payout.jobs.ts:52-56` | **R1** `LedgerService.listSellerBalances` / `getBalances` (S14 exports) |
| B4 | `Payout.shopId REFERENCES "Shop"` is a cross-domain foreign key (IX.4) | migration `migrations/20261001160000-ledger-partitioning-payouts-recon.js:108` | expand/contract: drop the foreign key (plain ID column), keep the unique `(shopId, periodStart)` |
| B5 | `api/` imports an `infra/` model and Redis directly (I.2; D-6) | `api/finance.controller.ts:6-9, 17-21` | `application/` payout query service behind a domain repository port; the balance route stays with S14 |
| B6 | `infra/payout.jobs.ts` orchestrates use cases (transactions, journals, enqueue) inside `infra/` (I.1: only `application/` orchestrates) and uses `new Date()` (I.3 for domain logic) | `infra/payout.jobs.ts:51, 59, 81-126` | use cases in `application/` (run, create, transfer, resolve, cancel), pure rules in `domain/` (reserve, period, state machine, eligibility, destination), job handlers thin in `infra/`; injected clock |
| B7 | The provider port is declared in `infra/` next to its adapter instead of a `domain/` port with an injection token (I.1, IV.8) | `infra/payout-provider.port.ts` | `domain/payout-provider.port.ts` (token) + adapter in `infra/` validating answers |
| B8 | Barrel exports `PayoutModel`, `FinanceModule`, `FinanceWorkerModule` (D-7, D-8, X.4) | `index.ts:9-11` | export only `PayoutsModule`, `PayoutsWorkerModule` |
| B9 | Payout and ledger are mixed in `finance.*` modules; the SD-20 name no longer matches the capability split | `finance.module.ts`, `finance-worker.module.ts` | split into `PayoutsModule` / `PayoutsWorkerModule` (S14 owns `Ledger*Module`) |
| B10 | `PayoutStatus` is a string union without exhaustive switches (III.7) | `infra/models/payout.model.ts:5` | discriminated union in `domain/`, `assertNever` in every switch |

## C. Open debt-register rows naming `payments` or S15

| Row | Rule | Share that S15 pays | Mechanism that replaces it |
|---|---|---|---|
| D-6 | I.2 | `api/finance.controller.ts` imports `infra/` model; `infra/payout.jobs.ts` holds use cases; port in `infra/` | repository ports in `domain/`, adapters in `infra/`, use cases in `application/` (B5–B7) |
| D-7 | IX.4 | `ShopModel` injected in `PayoutJobs` and `FinanceWorkerModule`; `PayoutModel` exported from the barrel (consumed only by tests and seeds) | **R1** `ShopQueryService.getShopsByIds`; own `PayoutDestination` table; drop `PayoutModel` from the barrel and from the seeds |
| D-8 | X.4 | barrel exports (`FinanceModule`, `FinanceWorkerModule`; `BalanceProjector` is S14's) | apps import `PayoutsModule` / `PayoutsWorkerModule` only (B8) |
| D-11 | X.5 | orders ↔ payments cycle through `PaymentModel` / `BisOrderModel`; S15 has no part in it (the payout code touches neither); `ledger.module.ts:9` imports `BisOrderModel` unused by payouts | S10, S13, S14 pay it; S15 MUST NOT add an import of `@app/domains/orders` or any model of it |
| D-12 | IX.4 | raw SQL on tables owned by another domain: `Shop` reads (via model, B1) and the foreign key in B4. `LedgerEntry` raw SQL is not cross-domain (same owner) but violates the S14/S15 boundary (B3) | **R1** `getShopsByIds` (shop facts), **R1** `LedgerService` (balances, postings); no SQL against another domain's table |
| D-15 | X.5 | payments is a member of the {catalog, discovery, experimentation, orders, payments} component through D-11; S15 adds no edge | none needed from S15 (kept clean by B-rows above) |
| D-17 | X.5 | file-level cycle payment ↔ ledger-entry models; not a payout file | S13 / S14; S15 introduces no model-to-model association |

## D. `check:table-ownership` lines for this domain (derived by reading; run the command to confirm)

| Kind | File:line | Finding | Replacement |
|---|---|---|---|
| MODEL | `infra/payout.jobs.ts:38` | `@InjectModel(Shop)` — `Shop` owned by tenancy | **R1** `getShopsByIds`; own `PayoutDestination` |
| MODEL | `finance-worker.module.ts:23` | `SequelizeModule.forFeature([Payout, Shop, Payment])` — `Shop` (tenancy) and `Payment` (own, but S13's) | register `Payout`, `PayoutHistory`, `PayoutRun`, `PayoutDestination`, `PayoutReserve` only |
| MODEL | `finance.e2e-spec.ts:25, 98-102` | test injects `Shop` and sets `stripeAccountId` | replace with the S03 `ShopQueryService` test double and S15's destination route/fixture |
| SQL (same owner, boundary) | `infra/payout.jobs.ts:52-56` | raw `LedgerEntry` read | **R1** `listSellerBalances` / `getBalances` |
| SQL (same owner) | `infra/payout.jobs.ts:60-66` | raw insert into `Payout` (own table) | repository port in `domain/` implemented in `infra/` (D-6) |
| FK | migration `20261001160000…js:108` | `Payout.shopId → Shop` | drop (B4) |

## E. Work order for the implementation agent

1. Run `pnpm --dir packages/backend check:table-ownership` and record the payments rows; confirm section D.
2. Contract-first: add `payoutSchema`, `payoutDetailSchema`, `upcomingPayoutSchema`, the admin and run schemas, and the six event schemas to `packages/contracts`.
3. Expand migration: new columns and tables (`PayoutHistory`, `PayoutRun`, `PayoutDestination`, `PayoutReserve`), statuses, `reserveHeldMinor`, `destinationSnapshot`, `attempts`, `payoutVersion`; backfill history and destinations from `Shop.stripeAccountId`; keep old columns readable (AS-53); drop the `Shop` foreign key. Add the new tables to `db/ownership.ts` in the same PR.
4. Domain: `reserve`, `period`, `payout-state` (discriminated union, exhaustive), `eligibility`, `destination`, `backoff`, `provider-answer`, with their table-driven and `fast-check` unit specs.
5. Application: run, create-payout (atomic step), transfer (claim → call → result), resolver, cancel, operator commands, queries; ports in `domain/`; injected clock; no provider call inside a transaction.
6. Infra: repositories, Stripe adapter behind the port (timeout, typed outcomes, lookup by reference), job handlers, event contracts, controllers, rate-limit and idempotency wiring.
7. Replace `finance.e2e-spec.ts` payout tests with the four e2e specs named in `test-plan.md`; update the old test's `5000` expectation (reserve now applies).
8. Remove `PayoutModel`, `FinanceModule`, `FinanceWorkerModule` from the barrel; update apps and seeds that import them; delete `deriveJournalId` and the namespace constant.
9. Coordinate: S03 drops `Shop.stripeAccountId` after the backfill (contract step); S14 removes its payouts route and exports; S28 and S16 subscribe to `payouts.events`.
10. Run the static gates (`tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict` for the payout files, `check:model-registry`) and the four e2e specs, and record the green run (VII.9).

## Sibling-spec follow-ups

- **S03**: after S15's expand migration has copied `Shop.stripeAccountId` into `PayoutDestination` (verified by S15 AS-53), tenancy may drop the column in its contract step and stop selecting it. S15 reads shop facts only through `ShopQueryService.getShopsByIds` (`status`, `payoutsEnabled`); a change to those `ShopSummaryDto` fields or to the `ACTIVE` status value breaks the eligibility gate.
- **S14**: `ProviderAccount` (with `PROVIDER_ACCOUNT_REPOSITORY` and `SequelizeProviderAccountRepository`) is superseded by S15's `PayoutDestination`; nothing reads it after S15 and S15's contract migration drops it, so S14 should add no readers. Two S14-owned specs reference the moved payout classes (`ledger-maintenance.e2e-spec.ts` probe module imports `PayoutJobs`/`FakePayoutProvider`/`Payout`; `payment-boundary.e2e-spec.ts` lists `PayoutModel` among removed exports): S15 edits only those imports and reports it. The S14 living page names `payout.jobs.ts` among the ledger's entry points: S14 should repoint it.
- **S16**: consume `payout.paid` from topic `payouts.events` (key `payoutId`, schema in `packages/contracts/src/payments/payout-events.ts`); discard by `payoutVersion`; amounts are `amountMinor`, the paid day is `paidAt`.
- **S28**: switch the import of the payout schemas from `contracts/src/notifications/consumed-events.ts` to `packages/contracts/src/payments/payout-events.ts` (same field names); topic `payouts.events`; also consume `payout.in_doubt` and `payout.discrepancy_detected` for the finance alert.
- **S43**: `webhookPayoutEventSchemas` may import the shared `payout.paid` / `payout.failed` schemas from `packages/contracts/src/payments/payout-events.ts` (a superset of what S43 declares); topic name and key are fixed.
- **W04 / J01**: the seller payouts page calls `GET /shops/:shopId/payouts` (new `payoutPageSchema`, public statuses `PENDING | IN_TRANSIT | PAID | FAILED | CANCELLED`, keyset `nextCursor`) and `GET /shops/:shopId/payouts/upcoming` (`upcomingPayoutSchema`); the old unpaged array body no longer exists.
- **S49**: S15 relies on `JobContext.attempt` being incremented by every claim, including a lease-reaped redelivery (`job-claim.sql.ts`, `job-reaper.service.ts`). If that behaviour changes, S15's attempt fence (research R-3) must be revisited.
- **S54**: S15 relies on "a request that failed validation does not consume its `Idempotency-Key`" and on `Idempotency-Replayed` (AS-41).

- **S03** (retest result, new): tenancy's status gate refuses every permission outside its short allow-list (`shop.read`, `members.read`, `shop.export`) on a closed shop, so `payouts.read` answers `403 shop_suspended` on a suspended shop and `409 shop_offboarding` on a deleting one (S15 `payout-api.e2e-spec.ts` AS-34 pins it). If sellers should still read their payouts while suspended, tenancy adds `payouts.read` to `WHILE_SUSPENDED`; S15 needs no change. W04/J01 must show those two codes.
- **S14**: S15 edited four S14-owned files in `payments/`, same owner and import-level: `ledger-worker.module.ts` (payout providers moved to `PayoutsWorkerModule`), `ledger-maintenance.e2e-spec.ts` (the probe module and the weekly-payout half of the ProviderAccount copy test left; those scenarios are now `payout-run` AS-01/AS-02 and `payout-transfer` AS-17/AS-23, L-017), `api/admin-only.decorator.ts` (`AdminOnly({ sensitive: true })`, default unchanged) and `api/balance.controller.ts` (`ShopIdFormatGuard` is exported). `finance.e2e-spec.ts` had no payout block left (S14 had rewritten it to ledger-level postings), so A23 needed no edit there. The S14 living page still lists `Payout` and `ProviderAccount` among its tables and `payout.jobs.ts` among its entry points: S14 should repoint them to `docs/spec/capabilities/S15-payouts.md`.
- **S54 / config**: `PAYOUT_*` settings and the `payouts` config rules are registered in `libs/common/config` (`payout-config.ts`); nothing else in config changed.

## Ownership check output (T001)

`pnpm check:table-ownership` (no `--strict`) before any change: **0 findings for `payments`** (S14 had already removed the `Shop` rows; the 23 findings listed belong to other domains: seller-onboarding, statements, ...). `.tx.baseline` = 0 direct `sequelize.transaction` sites in the payments domain, and still 0 after S15 (`payout-ops` AS-52 scans the payout files for it).

## Baseline (T002)

Before any S15 change `finance.e2e-spec.ts` had 2 failing tests of 4 (`a captured payment settles ...` and `daily reconciliation flags ...`, both `JournalInvalid: The currency is not supported` in `PaymentPostingsService.capture`): not an S15 test and not touched. S15 did not change their result.

## Runtime proofs (T095, T096)

- `nest build worker` and `nest build core` compile; `core` booted alone (`PayoutsController` and `PayoutsAdminController` mapped, `/health/ready` `200`, both payout route families `401` without a session); `worker` booted alone (`PayoutsCoreModule` and `PayoutsWorkerModule` initialized, the four `payouts.*` handlers in the `JobRegistry` line, no refused schedule logged).
- `check:module-graph` passes for `core`, `worker` and `local-monolith` (the monolith composes the two), and `apps/local-monolith` wiring specs are part of the dependents run below.
- The built `local-monolith` bundle was started once on port 8011 with the `start:dev:monolith` environment: it printed its banner and the Kafka partitioner notice and had not reached "successfully started" when the 100 s limit ended it, while an older monolith process that this run did not start was already holding port 8000. That start is therefore **inconclusive, not a pass**; it is listed in `specs/UNVERIFIED.md`-style follow-up below, not described as verified. A second attempt (T100) could not launch the bundle (the command was not permitted in this session), so the proof is recorded as `not run` in `specs/UNVERIFIED.md` and in quickstart "Ops artifacts" (T101). A monolith that this run did not start answers `/health/ready` 200 on port 8000, but it is not proven to run this build.
- The `JobSchedule` rows (`payouts.run-weekly` at `0 6 * * 1 Europe/Warsaw`, and the resolver and audit schedules) are proven by `payout-run.e2e-spec.ts` AS-14 (registered twice, one row; the DST week's next fire at `2026-10-26T05:00:00.000Z`).

## Deviations from the plan, and why

- The provider port returns the **raw answer** (`{kind:'answered', answer}`) and `validateProviderAnswer` runs in `PayoutTransferService` (application), not in the Stripe adapter: the double sits behind the port, so the wrong-amount/garbage cases of AS-25 can only be tested if validation is on the application side of it. Behaviour is the spec's.
- `listSellerBalances` already returns the balances, so the run makes no extra page-level `getBalances` prefilter; the authoritative read is the one inside the creation transaction (research R-2). AS-12 counts the three listing pages and the three tenancy calls.
- The contract spec of the event schemas lives in `libs/domains/payments/payout-contracts.spec.ts` (the `contracts` package has no jest runner); the contract migration is in `migrations/contract/` so `db:migrate` does not run it with the expand step (its guard would pass on an empty table and drop `amount`).
- `PayoutsCoreModule` (shared providers of the two modules, the pattern of `PaymentsCoreModule`) is internal and not exported from the barrel.
- AS-15 and AS-55 stop the run with the job signal (and the shutdown registry task) rather than killing the process; a killed process leaves the run `RUNNING`, and the next execution restarts it the same way.
- No topic/doctor list names the new tables (the doctor derives them from the migrations; `seeds.clean` truncates every table); no queue-server reload is needed (no SQS queue added). Topic `payouts.events` is registered by `EventsModule.forAggregates([PAYOUTS_AGGREGATE])`.

## Final run (T096–T098)

- T097: the runner's stack is the one that started empty (`fresh-run.sh --here`: monolith ready, doctor-live healthy); on it `payout-run` 27/27 and `payout-ops` 23/23 pass. A throwaway second stack cannot run beside the `payment_system_*` containers, so a from-zero stack of our own was not built.
- Payments, fresh processes per batch: `payout-*` 4 suites / 101 tests green. `ledger-*`: 4 of 6 suites fail, `payment-*`: 11 of 13 suites fail, `finance` + `reconciliation-*`: 2 of 3 suites fail. Cause of 40 of the 44 `payment-*` failures and of every sampled `ledger-*`/`finance`/`reconciliation-*` failure: `JournalInvalid: The currency is not supported` (the platform currency defaults to USD, those S13/S14 specs book EUR; also noted in W07 questions.md); the rest of the `payment-*` ones are a 60 s hook timeout, `database went away`/`Revocation check unavailable` under load and knock-on assertions after the first throw. None is in an S15 file; S13/S14 own them.
- One S15-caused failure found and fixed: `ledger-ops` S14 AS-67 pins the payments barrel; the two new exports `PayoutsModule` and `PayoutsWorkerModule` were added to its list (passes now).
- Dependents: `tenancy` 208/208, `jobs` 97/97, `idempotency`+`rate-limit`+`outbox`+`events` 197 passed/1 skipped, `stripe` has no e2e specs (0 matches, nothing to run). `marketing`+`identity`: 20 failures in 3 marketing S37/S38 suites (`link-filter timeout`, ioredis offline) under load; those 3 suites alone: 114/114 green. `developer-platform`+`notifications`: 10 failed / 678 passed in 5 suites. The 8 S42 failures (`public-api-logs-usage`, `public-api-limits`, `developer-platform-consumers`) are `Unknown table expression identifier 'api_requests'` from ClickHouse: the test stack lacks that table (L-011, the doctor should compare it); the 2 S28 failures (`notifications-inbox` AS-56, `notifications-catalog` AS-87) were not read in detail. None touches a file S15 changed; S42/S28 should confirm.
- Topic `payouts.events` is registered by `EventsModule.forAggregates([PAYOUTS_AGGREGATE])` (bootstrap, not on demand); no queue added.

## Spec changes

None. S15 creates `docs/spec/capabilities/S15-payouts.md` (a new living-spec page; no `*.reviewed.json` is created or edited) and changes nothing a human signed.

## Gate repairs

- The gate failed in S13/S14 payment specs (`payment-breaker`, `payment-intent`, `payment-unknown`, `payment-ops`, `ledger-*`, `reconciliation-run`, `finance`) with `JournalInvalid: currency_unsupported`. Cause: the ledger books in the platform currency (`PlatformSettings.currency`, default `USD`, introduced by W07), while those specs and the payments fixtures price everything in `EUR`. Code is right; the payments test harnesses (`testing/ledger-app.ts`, `payments-app.ts`, `payout-app.ts`) did not set `PLATFORM_CURRENCY`. They now pass `PLATFORM_CURRENCY: 'EUR'` (a spec's own `env` still overrides). No test was changed or weakened. Re-run: `libs/domains/payments` 26 suites / 354 tests pass; `npx tsc --noEmit` clean.
