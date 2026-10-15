# Implementation Plan: S15 — Seller Payouts: Weekly Run, Reserves, Provider Transfer with Idempotency, Payout States (domain `payments`)

**Branch**: `S15-payouts` (working branch `sdd/auto`) | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S13, S14, S28, S43, S49, S50, S53 and S54 are built. `payments` already holds a working but naive payout flow, left by S14 in `infra/payout.jobs.ts` so that file compiles: one class that lists balances, creates a `Payout` row and journal per shop, and sends it, with no eligibility, no reserve, no claim step, no `SENDING`/`UNKNOWN`/`CANCELLED`, no history, no events, no destination of its own, no read API and no operator API. The plan replaces it with the shape of the spec without changing the table owner:

- **Pure rules in `domain/`**: reserve arithmetic (BigInt, round up), period (Monday of the week, bounds), payout state machine (discriminated union, exhaustive, with the `(state × event)` table), eligibility and blocking reason, destination (format, mask, cooling), job and resolver backoff, provider-answer validation, errors, metric names, ports. Table-driven unit specs plus `fast-check` for money.
- **The weekly run** (`application/payout-run.service.ts`): validate the period, record the run, page sellers by keyset (200), batch tenancy (`getShopsByIds`) and ledger (`getBalances`) calls, then one **atomic creation step per shop** (`payout-creation.service.ts`): authoritative balance → reserve/cap/minimum → insert (unique shop+period) → `postJournal(PAYOUT)` → history → `payout.created` → `enqueue('payouts.send')`, all in one `TransactionRunner.run`; a refused posting skips only that shop; shutdown stops between shops.
- **The transfer** (`payout-transfer.service.ts`): claim (`PENDING → SENDING`, committed) → provider call with **no transaction open** → result transaction (`PAID` + sent journal + event, or `FAILED` + reversal + event, or `UNKNOWN`). **Attempt fencing** (research R-3): the claim and every redelivery are conditional updates on `attempts < ctx.attempt`, so concurrent duplicates lose and a crashed or transiently failed send can be repeated with the same key. The provider port retries nothing; the job layer (S49) is the only retry layer.
- **The resolver** (`payout-resolver.service.ts`, `payouts.resolve-in-doubt`): settles stale `SENDING` (> 5 min) and `UNKNOWN` payouts by looking the transfer up by reference, re-sends with the same key at most 3 times when the provider does not know it, never fails a payout because the provider is unreachable, raises one `payout.in_doubt` after 24 h.
- **Cancel** (`payout-cancel.service.ts`): only from `PENDING`, claim-exclusive with the transfer through the same conditional update (`WHERE status='PENDING'`), reversal + history + event in one transaction.
- **Destinations and reserves** (`payout-destination.service.ts`, `payout-reserve.service.ts`): admin-only, `@Idempotent()`, history kept, masked output, 48 h cooling on a change.
- **Read API** (`payout-query.service.ts`): seller list/detail/upcoming under `ShopScoped('payouts.read')` (keyset, public statuses), operator list/runs under `AdminOnly`.
- **Audit** (`payout-audit.service.ts`, `payouts.audit-daily`): previous UTC day's `PAID` payouts against the provider by reference; every difference once as metric + event; changes nothing.
- **Provider adapter** (`infra/stripe-payout-provider.adapter.ts`) behind a `domain/` port: typed outcomes (`success | rejected{code} | transient | unknown`), 10 s timeout, `maxNetworkRetries: 0`, every answer validated, lookup by reference; `StripeService` gains `retrieveTransferByReference` and a timeout-bearing `createTransfer`.
- **Boundaries**: no `Shop`, no `User`, no `LedgerEntry` SQL, no foreign key to `Shop`; destination in a payments-owned `PayoutDestination` (copied from `ProviderAccount`/`Shop.stripeAccountId`); barrel exports only `PayoutsModule`, `PayoutsWorkerModule` for this capability; `PayoutJobs`, `payout-provider.port.ts`, the old `Payout` model shape and `deriveJournalId` leave.

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S01 | `Firewall` takes no `throttle`/`skipThrottle`; sensitive routes use `Firewall({ sensitive: true })`, not `@UseGuards(SessionNotRevokedGuard)` | WP-6: the three operator writes are `Firewall({ sensitive: true })` through a payout `AdminOnly` that wraps the S14 decorator (research R-12: if the S14 `AdminOnly` still calls plain `Firewall()`, it is **reused as-is for reads** and the writes add `Firewall({ sensitive: true })` — WP-0 probe reads `identity` to decide); no `SessionNotRevokedGuard`, no `throttle`/`skipThrottle` anywhere in the payout controllers. Proof: `payout-api.e2e-spec.ts` (revoked-session case on a write) + `grep` in quickstart |
| S03 | replace direct `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw SQL on tenancy tables with `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`; `payouts.read` excludes VIEWER; `ShopScoped` write permissions answer `403 shop_suspended` / `409 shop_offboarding` on closed shops: retest | WP-4/WP-6: `ShopQueryService.getShopsByIds` is the only tenancy call (via `ShopSummaryPort` in `domain/`); `ShopScoped('payouts.read')` on the seller routes; AS-34 gains a VIEWER-denied row; the operator routes are platform-admin, not shop-scoped, so `shop_suspended`/`shop_offboarding` does not apply to them (recorded in research R-12); seller routes are reads only (a suspended shop still reads). `ShopModel` leaves `LedgerWorkerModule`/`PayoutJobs` already (S14); verified by the ownership report |
| S03 / S14 | take over `Shop.stripeAccountId` into a table S15 owns; tenancy drops the column; `payout.jobs.ts` stops reading `Shop` | WP-2: `PayoutDestination` + copy from `ProviderAccount` **and**, if the column still exists, from `Shop.stripeAccountId` (guarded by `information_schema`), idempotent; `ProviderAccount` kept readable (legacy, unused by new code) and dropped in the contract file of a later release; `PROVIDER_ACCOUNT_REPOSITORY` provider removed from payout code. The column drop is tenancy's (sibling bullet S03). Proof: `payout-ops.e2e-spec.ts` AS-53 |
| S13 | nothing changes in the payout contract; `finance-worker.module.ts` already lost `PaymentResolutionJobs`; `payout.jobs.ts` still injected `Shop` | WP-5/WP-9: no `Shop` injection remains (S14 removed it; S15 forbids it by the ownership gate); S15 does not touch `PaymentResolutionJobs` |
| S14 | adopt `postJournal` (`PAYOUT`, `PAYOUT_REVERSAL`), `getBalances`, `listSellerBalances`; re-create `GET /shops/:shopId/payouts`; own the `Payout` model/DTO; write `ProviderAccount`; `Payout`, port and jobs registered in `LedgerWorkerModule` | WP-5/WP-6/WP-9: references become `<id>`, `<id>:sent`, `<id>` (research R-9, old references of in-flight legacy payouts are migrated safely); route re-created in `PayoutsController`; **`ProviderAccount` is superseded by `PayoutDestination`** (spec FR-028 wins over the S14 note: one destination table with cooling and history; research R-8); payout jobs move to `PayoutsWorkerModule`, `LedgerWorkerModule` loses `Payout`/`PayoutJobs`/`PayoutProvider` |
| S28 | confirm event names/payloads in `contracts/events.md` of S28 against what S15 ships | WP-1: `packages/contracts/src/payments/payout-events.ts` defines the six events; the consumed copies in `contracts/src/notifications/consumed-events.ts` (`payoutConsumedSchemas`) are checked field-by-field by a contract spec in WP-1 (fields `payoutId`, `shopId`, `amountMinor`, `currency`, `payoutVersion`, `transferRef`, `failureCode` match); sibling bullet S28 to switch the import |
| S43 | publish `payout.paid` / `payout.failed` schemas in `packages/contracts` for both consumers; `payoutVersion` and `periodStart`; topic `payouts.events` | WP-1/WP-5: schemas in `payout-events.ts` are a strict superset of `webhookPayoutEventSchemas` (`payoutId`, `periodStart`, `amountMinor`, `currency`, `transferRef`/`failureCode`, `payoutVersion`); a contract spec parses every produced payload with S43's loose schema **and** S28's strict schema (no sibling spec edited); topic `payouts.events`, key `payoutId`, via `EventsModule.forAggregates([PAYOUTS_AGGREGATE])`. Proof: `payout-ops.e2e-spec.ts` AS-50 |
| S49 | `declareJobType` with a payload contract next to the `JobPayloads` augmentation for every job; adapt to the discriminated `cancel` result; catch `InvalidScheduleError` | WP-5: four job types (`payouts.run-weekly`, `payouts.send`, `payouts.resolve-in-doubt`, `payouts.audit-daily`) each `declareJobType` + zod contract + `maxAttempts`; the schedule bootstrap catches `InvalidScheduleError` (through the existing `upsertLedgerSchedule` helper, generalized — research R-11); this domain has no `JobsService.cancel` caller (grep in WP-0; a cancelled payout leaves its queued send job in place, which finds `CANCELLED` and exits — AS-42 — so no job cancel is needed). Proof: `payout-run.e2e-spec.ts` AS-14 asserts schedule rows and contract rejection |
| rule 0 | living spec starts with the page | WP-0 creates `docs/spec/capabilities/S15-payouts.md` (rules, behaviors, `[proof:]`/`[code:]`, scope globs) **before** code and keeps `python3 scripts/livespec/check.py` green; no `*.reviewed.json` is created or edited; `## Spec changes` in `gaps.md` records that nothing signed is changed (the S14 page is a sibling's: its `Entry points` mention `payout.jobs.ts` — sibling bullet, not edited) |
| rule 1 | sibling-spec follow-ups | [gaps.md](gaps.md) `## Sibling-spec follow-ups` |
| rule 2 | unverified criteria | quickstart "Ops artifacts" + `specs/UNVERIFIED.md` rows for SC-001 (scale), SC-005 (p95 at 5 years), SC-007 (1,000 shops < 5 min) |
| rule 3 | no git checkout/restore/reset/stash/clean | all undo by hand edit (noted in task prompts) |
| rule 4 | `TransactionRunner.run` / `@Transactional`; no new `sequelize.transaction` | baseline recorded in `.ownership.baseline` = **0**, `.tx.baseline` = **0** (both already clean after S14); every S15 transaction uses `TransactionRunner.run`; gate: `grep` in quickstart + `payout-ops` boundary test; spec files that opened `sequelize.transaction` directly in tests are not in S15 files |
| gaps.md | A1–A23, B1–B10, C (D-6, D-7, D-8, D-11, D-12, D-15, D-17), D, E | "Gap coverage" below |
| Known failure classes | wiring L-001/L-004/L-010/L-015/L-018; config L-002/L-011/L-020; hollow L-003; state L-005/L-006; timing L-007; process L-017/L-019 | "Failure-class checks" below |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` domain `payments`; schemas in `packages/contracts`.

**Primary Dependencies** (all present, **no new library**): `@nestjs/sequelize`/`sequelize-typescript`; `TransactionRunner` (`@app/infrastructure/context`); `@Idempotent()` (`@app/infrastructure/idempotency`); `OutboxService.append` + `defineEvent`; `JobsService`/`@JobHandler`/`JobContext{attempt,isLastAttempt,signal}`/`declareJobType`/`upsertSchedule`; S50 `definePolicies`/`@RateLimit`; `ShopScoped`, `ShopQueryService` (tenancy); `Firewall`/`User`/`Role` (identity); `Clock`/`CLOCK`; `MetricsRegistry`; `ShutdownRegistry`; `ApiConfigService`/joi config rules; `StripeService` (thin client, gains two methods); `LedgerService` (`postJournal`, `getBalances`, `listSellerBalances`) and `LEDGER_ACCOUNTS`/`shopAccount`; zod; `fast-check` (dev).

**Storage**: PostgreSQL shared `public` schema — `Payout` (expanded), `PayoutHistory`, `PayoutRun`, `PayoutDestination`, `PayoutDestinationHistory`, `PayoutReserve`, `PayoutReserveHistory`, `PayoutAuditDay`, `PayoutAuditFinding` (nine new) — all `domain:payments`, no foreign key to another owner. Kafka `payouts.events` (produced, key `payoutId`). Redis only through S50 limiter and S54 idempotency (no payout key prefix). No DynamoDB. See [data-model.md](data-model.md).

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` — the four files of [test-plan.md](test-plan.md) (`payout-run`, `payout-transfer`, `payout-api`, `payout-ops`) + seven unit specs under `domain/` (`reserve`, `period`, `payout-state`, `eligibility`, `destination`, `backoff`, `provider-answer`; table-driven, `fast-check` for money). Real Postgres (real migrations, partitioned ledger), Redis, outbox, jobs; faked only at the edges (scriptable provider double behind the port, tenancy `ShopQueryService` double with a call log, limiter store forced down, `FakeClock`, identity/S03 fixtures).

**Target Platform**: Linux containers. `apps/core` hosts `PayoutsModule` (HTTP, R1); `apps/worker` hosts `PayoutsWorkerModule` (run, transfer, resolver, audit); `apps/local-monolith` composes both like it composes `LedgerModule`/`LedgerWorkerModule`. **No new deployable app** (I.6).

**Project Type**: web-service (backend domain) + contracts package + migrations.

**Performance Goals**: payouts page p95 < 300 ms with 5 years of weekly history for a shop (one keyset query on `(shopId, periodStart DESC, id DESC)`, ≤ 100 rows; SC-005 figure is an Ops artifact); a run over 1,000 shops < 5 min with ≤ 20 tenancy+ledger calls for listing and eligibility (5 listing pages + 5 tenancy batches + 5 balance batches = 15; SC-007 call count is proven at 450 shops in AS-12, the 5-minute figure is an Ops artifact).

**Constraints**: no network I/O inside a transaction (provider call, tenancy batch, ledger listing all outside; the in-transaction path is `getBalances(tx)`, `postJournal(tx)`, outbox, `enqueue`); every outbound call has a timeout (provider 10 s, configurable, validated > 0); one retry layer (S49 job layer for transient sends; resolver for unknown outcomes); logs and events carry ids/amounts/codes only — never the destination, provider key or request body.

**Scale/Scope**: 3 seller routes + 2 operator reads + 3 operator writes, 6 produced events, 0 consumed events, 4 job types, 2 rate policies added (`finance.payouts.read`; `finance.admin.read/write` exist), 9 new tables + 1 expanded, 55 acceptance scenarios (four e2e files + seven unit specs; AS-37 is W04/J01's).

### Pool arithmetic and `statement_timeout` (III.12)

- No new pool; the shared S54 pool (P = 10 per instance) applies. The run holds **one connection per shop creation step** (≈ 8 statements: balance read, insert, header insert + balance updates + entries + outbox row of the posting, history, outbox, job insert) and releases it before the next shop; with the worker's `payouts.run-weekly` at `concurrency: 1` / `fleetConcurrency: 1` that is at most 1 connection from the run. `payouts.send` runs at `concurrency: 8` and holds a connection only during the claim transaction (≈ 3 statements) and the result transaction (≈ 8), **never during the provider call** (AS-29). Worst case simultaneous demand if every handler is inside a transaction at once: 8 sends + 1 run + 1 resolver + 1 audit = 11 > P = 10, but the resolver and audit hold no connection while they call the provider and each transaction lasts ≈ 10 ms, so the surplus waits in the pool queue for milliseconds (research R-13).
- Seller list/detail/upcoming: one query each (the upcoming route adds one `getBalances` and one `getShopsByIds`), ≤ 20 ms.
- Every payout statement runs under the pool-wide `db_statement_timeout_ms`; `postJournal` applies its own `lock_timeout`/`statement_timeout` (S14) and answers `LedgerBusy`, which the run turns into the `ledger_busy` skip.

## Constitution Check

*GATE: passes before Phase 0 and re-checked after Phase 1 design (below).* Each line is a "Pull Request Compliance Gate".

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I.1–I.6, Communication Matrix, no `forwardRef`, no `Scope.REQUEST`) | **Pass** | `domain/` pure (takes `now`, `random`, ports); `application/` reaches `infra/` only through tokens in `domain/payout-ports.ts` (repositories, `PAYOUT_PROVIDER`, `SHOP_SUMMARY_PORT`, `LEDGER_PORT`-style narrow adapter over `LedgerService`, `PAYOUT_JOBS_PORT`, `PAYOUT_EVENTS_PORT`); `api/` imports no `infra/` and no Redis; transactions are opened only in `application/`; no new app |
| 2 | Controllers (II.1) | **Pass** | `PayoutsController` (seller) and `PayoutsAdminController`: DTO in, one service call, DTO out; no `try/catch`, no branching on state; all problems are `AppError`s registered in `PAYOUT_PROBLEMS` |
| 3 | Data access: principal in the predicate (III.4), no network I/O in transactions (III.3), invariants in the store (III.6), conditional-update transitions + history (III.7), integer money (III.8), keyset (III.10) | **Pass** | detail by `WHERE id AND shopId` together; unique `(shopId, periodStart)`; unique `(kind, reference)` of S14; every transition `UPDATE … WHERE id AND status = :from` asserting one row + `PayoutHistory` row in the same transaction; `BIGINT` minor units, safe-integer checks, BigInt reserve math; keyset lists with signed cursors; provider call outside transactions (AS-29 proves it) |
| 4 | Migrations expand/contract with `lock_timeout` (III.11) | **Pass** | [data-model.md](data-model.md): one expand file (new columns nullable/defaulted, new tables, FK to `Shop` dropped, status CHECK widened `NOT VALID` then validated, destination copy), one contract file in a later release (drop `amount`/`providerRef`/`ProviderAccount` after a count-and-checksum guard) |
| 5 | Messaging: outbox, timeouts, retries at one layer (IV.4–IV.6) | **Pass** | six events via `OutboxService.append(event, tx)` in the transition's transaction; no consumer in this capability (no inbox needed: IV.5 n/a); provider 10 s; retries only in S49 (sends) and the resolver (lookups), never in the adapter |
| 6 | Contracts: DTOs, `packages/contracts`, problem+json, `Idempotency-Key` (V) | **Pass** | schemas in `packages/contracts/src/payments/payouts*.ts`; e2e parse every body; the three operator writes are `@Idempotent()` (24 h, replay, in-flight 409, different-body 422, missing 422); money fields end in `Minor`; no ORM model serialized |
| 7 | Web | n/a | W04 and J01 own the screens; sibling bullets for W04 (new `payoutSchema`/`upcomingPayoutSchema`) |
| 8 | Tests: VII.2/VII.3 per endpoint, test plan updated, green run recorded (VII.8/9) | **Pass (proven by WP-12)** | [test-plan.md](test-plan.md) 55 rows → 4 e2e + 7 unit; gate-9 faults forced in AS-19, 22, 36, 48, 55; old `finance.e2e-spec.ts` payout tests are **replaced scenario by scenario** (L-017: AS-01/17/23 carry the old scenarios "whole balance sent → now reserve", "no account → rejection", "provider rejection → reversal"), and the file is edited only for those blocks |
| 9 | Operational: no secrets/PII in logs, jobs single-run and idempotent, graceful shutdown (VIII) | **Pass** | AS-51/54/55; `fleetConcurrency: 1` + lease + the unique `(shopId, periodStart)`; the run registers a `ShutdownRegistry` task (order 10) that flips a stop flag |
| 10 | Database isolation (IX) | **Pass after WP-2/WP-9** | ownership findings for `payments`: baseline **0** (recorded; S14 already cleared the `Shop` rows) and stays 0; no foreign key to `Shop` (dropped by the expand migration); tables registered in `db/ownership.ts`; cross-domain facts by R1 (`getShopsByIds`) and R1 ledger exports only |
| 11 | Monorepo boundaries (X) | **Pass** | barrel (`index.ts`) gains `PayoutsModule`, `PayoutsWorkerModule`, `payoutsRatePolicies` is re-exported through `paymentsRatePolicies`; no model, port or repository exported; `payments` imports no `orders` (D-11 untouched); the Stripe client stays in `infrastructure/stripe` |

## Failure-class checks (known classes from earlier runs of this loop)

| Lesson | What S15 does about it |
|---|---|
| L-018 / L-015 / L-004 (boot on its own, start the real app) | WP-12 starts `apps/core`, `apps/worker` and `apps/local-monolith` for real (`quickstart.md` "Boot" block) after the module swap; `PayoutsWorkerModule` imports everything it injects (`StripeModule`, `EventsModule.forAggregates`, `LedgerModule`, tenancy's `ShopBatchReadModule`, `RateLimitModule` is core-only) so the worker boots without the monolith's globals; a spec compiles `PayoutsModule` and `PayoutsWorkerModule` standalone (`Test.createTestingModule` with only the module and the real DB), failing on any missing provider |
| L-010 (first-use creation idempotent) | destination/reserve upserts are `INSERT … ON CONFLICT`; the run record is upserted by `periodStart`; the audit marker by `day`; no "create on first use" route returns 500 on a repeat (409/replay semantics from `@Idempotent()`) |
| L-001 (queue option validated where the message is created) | the outbox events have no FIFO-only option; `enqueue` options are validated by `validateEnqueueOptions` at creation inside the creation step (so an invalid option fails the shop's transaction, not a later relay); AS-16 forces the enqueue failure |
| L-002 / L-020 / L-011 (queues, tables, topics exist in the stack) | no SQS queue is added (the job table is the queue); the new Kafka topic `payouts.events` and the nine new tables are added to the test-stack doctor lists by WP-2/WP-5 (`quickstart.md` runs `pnpm test:stack:doctor`-equivalent: the migration harness plus a table/topic existence assertion in `payout-ops` AS-52); no queue-server reload is needed |
| L-003 (a test must be able to fail) | no "A or B" assertions: every scenario asserts one outcome; a provider double that cannot simulate a fault reports **blocked** instead of passing (WP-0 checks the double covers timeout, 429/5xx, reset, garbage, lookup found/not-found/reversed, crash-after-success, block-mid-call) |
| L-005 / L-006 (shared state) | every e2e creates its own shops (fresh UUIDs), balances (journals posted in the test) and clock; `clean()` truncates payout tables before each test; the browser suite is W04/J01's and untouched |
| L-007 (timing) | clock is frozen/advanced by the test; no sleeps; `Promise.all` races use the runner's timeouts |
| L-008 (big suites) | WP-12 runs the four e2e files one process at a time and the whole capability once at the end (`test-spec.sh libs/domains/payments`) |
| L-013 (damage cleanup) | the crash/stop faults (AS-15, 19, 55) restore the injected fault switches in `afterEach`; the unknown/in-doubt payouts the tests create are truncated by `clean()` |
| L-017 (scenarios, not files) | the payout blocks of `finance.e2e-spec.ts` are deleted only after AS-01/17/23 cover their scenarios (checked by a mapping table in tasks) |
| L-019 / L-012 | final checkpoint runs the boot proofs and the whole suite with scripts (`quickstart.md`); `scripts/qa/fresh-run.sh` listed as the empty-stack proof (Ops artifact if the runner lacks it) |

## Complexity Tracking

| ID | Rule | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| CT-1 | "retries at exactly one layer" (IV.6) vs two waiting loops (job retry for transient sends; resolver for unknown outcomes) | the spec itself separates them: a *transient* answer means "the provider said no, try again" (job layer, 5 attempts, same key); an *unknown* outcome means "ask, never resend blindly" (resolver, lookups with backoff, ≤ 3 same-key re-sends). They act on disjoint states (`SENDING` in-flight vs `UNKNOWN`) and never retry the same operation at two layers | one loop only — would either resend an unknown outcome blindly or poll after a definite 503 | none (documented in research R-3) |
| CT-2 | I.1 "only `application/` orchestrates" for job handlers | `@JobHandler` classes must live in `infra/` (S49 discovery); they stay thin: parse payload, call one use case, map the result (no transaction, no ledger call) | handlers in `application/` — would import `@nestjs`-decorated job metadata into the use-case layer | none |
| CT-3 | superseding `ProviderAccount` (S14) with `PayoutDestination` leaves two tables for one fact until the contract release | S14's table has no cooling, history or version; renaming it in place is a single-step rename of a table still read by deployed code (III.11) | extending `ProviderAccount` — would force its S14-owned repository/port (`PROVIDER_ACCOUNT_REPOSITORY`) to change under S14's tests | the contract migration of the release after AS-53's verification |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S15-payouts/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ http.md  events.md  services.md
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/    # inputs (gaps.md gains "## Sibling-spec follow-ups" and "## Spec changes")
└── tasks.md                                                     # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
docs/spec/capabilities/S15-payouts.md                         # WP-0, before code (living spec page; no .reviewed.json)
specs/UNVERIFIED.md                                           # + S15 rows (SC-001 scale, SC-005, SC-007)

packages/contracts/src/payments/
├── payouts.ts           # payoutSchema, payoutDetailSchema, upcomingPayoutSchema, adminPayoutSchema(+Page), payoutRunPageSchema, destination/reserve request+response, cancel request, query schemas, status enums
├── payout-events.ts     # six event payload schemas (superset of S43's and S28's copies)
└── index.ts             # re-exported from src/index.ts

packages/backend/libs/domains/payments/
├── api/
│   ├── payouts.controller.ts            # GET /shops/:shopId/payouts, /upcoming, /:payoutId   (ShopScoped('payouts.read'))
│   ├── payouts-admin.controller.ts      # GET /finance/payouts, /finance/payouts/runs; PUT destination, reserve; POST cancel
│   └── payout.dto.ts                    # request/query DTO classes (class-validator) mirroring the contracts
├── application/
│   ├── payout-run.service.ts            # period check, run record, paging, eligibility, per-shop isolation, stop flag
│   ├── payout-creation.service.ts       # the atomic step (balance → rules → insert → journal → history → event → enqueue)
│   ├── payout-transfer.service.ts       # claim → provider → result; attempt fencing; outcome mapping
│   ├── payout-resolver.service.ts       # stale SENDING + UNKNOWN: lookup, re-send ≤ 3, in-doubt event
│   ├── payout-cancel.service.ts
│   ├── payout-destination.service.ts
│   ├── payout-reserve.service.ts
│   ├── payout-query.service.ts          # seller list/detail/upcoming, operator list/runs
│   ├── payout-audit.service.ts
│   ├── payout-transition.service.ts     # the one place a status changes: conditional update + history + version + event (+ journal)
│   └── events/payout-events.ts          # defineEvent over contracts schemas; PAYOUTS_AGGREGATE
├── domain/
│   ├── reserve.ts  period.ts  payout-state.ts  eligibility.ts  destination.ts  payout-backoff.ts  provider-answer.ts
│   ├── payout-errors.ts  payout-metrics.ts  payout-cursor.ts  payout-ports.ts
│   └── *.spec.ts                        # seven unit specs (reserve, period, payout-state, eligibility, destination, backoff, provider-answer)
├── infra/
│   ├── models/payout.model.ts (rewritten)  payout-history.model.ts  payout-run.model.ts  payout-destination.model.ts
│   │          payout-destination-history.model.ts  payout-reserve.model.ts  payout-reserve-history.model.ts  payout-audit-day.model.ts
│   ├── payout.repository.ts  payout-run.repository.ts  payout-destination.repository.ts  payout-reserve.repository.ts  payout-audit.repository.ts
│   ├── stripe-payout-provider.adapter.ts   # PAYOUT_PROVIDER: typed outcomes, 10 s, validation, lookup
│   ├── tenancy-shop-summary.adapter.ts     # SHOP_SUMMARY_PORT over ShopQueryService.getShopsByIds (≤ 200 per call)
│   ├── ledger-payout.adapter.ts            # PAYOUT_LEDGER over LedgerService (postJournal, getBalances, listSellerBalances)
│   └── payout.jobs.ts                      # thin @JobHandler classes: run-weekly, send, resolve-in-doubt, audit-daily + schedule bootstrap (rewritten)
├── payouts.module.ts  payouts-worker.module.ts  rate-limit-policies.ts (+ finance.payouts.read)  index.ts (barrel)
├── testing/ (extended)  fake-payout-provider.ts  fake-shop-summary.ts  payout-app.ts  payout-fixtures.ts
└── payout-run|payout-transfer|payout-api|payout-ops .e2e-spec.ts
(deleted) infra/payout-provider.port.ts (+ FakePayoutProvider), infra/provider-account.repository.ts (contract step), the payout blocks of finance.e2e-spec.ts, deriveJournalId

packages/backend/libs/common/config/payout-config.ts            # validated settings (AS-54)
packages/backend/libs/infrastructure/stripe/stripe.service.ts   # + createTransfer(timeout, no retry), retrieveTransferByReference
packages/backend/migrations/2026101…-s15-payouts-expand.js, …-s15-payouts-contract.js
packages/backend/db/ownership.ts                                # + new tables
packages/backend/apps/{core,worker,local-monolith}/src/*.module.ts   # module swaps
```

**Structure Decision**: web-service backend domain plus contracts and two migration files. No new deployable. Payout files are separated from ledger files; they share only `LedgerService` (called inside the payout transactions).

## Work packages

Order follows `gaps.md` section E; each package ends with its narrowest test through `test-spec.sh` (`npx jest` for units). `/speckit-tasks` splits them.

| WP | Content | Scenarios / gaps |
|---|---|---|
| WP-0 | **Baseline and living page**: run `check:table-ownership` and record `payments` rows (expect 0 = `.ownership.baseline`), count direct `sequelize.transaction` sites (expect 0 = `.tx.baseline`); run the current `finance.e2e-spec.ts`, `ledger-maintenance.e2e-spec.ts`, `payment-boundary.e2e-spec.ts` to know what is green; throwaway probes (deleted): `Firewall({sensitive})` and the S14 `AdminOnly`, `ctx.attempt` after a lease-reaped redelivery, whether Kafka topics are created on demand in the test stack, `ShopQueryService.getShopsByIds` limit, Stripe SDK transfer-lookup by `transfer_group`/metadata, grep for `JobsService.cancel` and `GET …/payouts` callers (web, edge, seeds), grep for users of `PayoutModel`/`PayoutProvider`/`PROVIDER_ACCOUNT_REPOSITORY`. **Create the S15 living-spec page**, run `python3 scripts/livespec/check.py`. | A23 (baseline), rule 0 |
| WP-1 | **Contracts, config, errors, pure domain**: `packages/contracts/src/payments/payouts*.ts` + contract specs against S28/S43 copies; `payout-config.ts` + startup validation; `payout-errors.ts` + `PAYOUT_PROBLEMS`; the seven pure modules with their unit specs; `payout-metrics.ts`; rate policy `finance.payouts.read`; `db/ownership.ts` rows. | A19 (names), A20, A22, B10; AS-04, 13 (pure), 25 (pure), 27, 38/39 (pure), 54 |
| WP-2 | **Expand migration and models**: the expand file of [data-model.md](data-model.md) (columns, tables, status CHECK widened, `Shop` FK dropped, destination copy, history backfill, `amount`→`amountMinor` dual-write trigger), models without associations, `Payout` model rewritten, `payments-models.ts` registration. | A22, B4; AS-52 (FK), AS-53 |
| WP-3 | **Ports, repositories, transition core**: `payout-ports.ts`, the five repositories, `PayoutTransitionService` (conditional update + history + version + event + optional journal), `LedgerPayoutAdapter`, `TenancyShopSummaryAdapter`, `PayoutEventsPort`. | A15, A14, B5–B7; AS-27 (integration), AS-50 |
| WP-4 | **The weekly run**: `PayoutCreationService`, `PayoutRunService`, run record, eligibility, stop flag + `ShutdownRegistry` task, `payout.jobs.ts` run handler + schedule bootstrap (`declareJobType`, `InvalidScheduleError` caught), `fake-shop-summary`, fixtures; `payout-run.e2e-spec.ts`. | A1–A7, A20, A21; AS-01…AS-16, AS-55, AS-39 (run half) |
| WP-5 | **Provider adapter and transfer**: `StripeService` additions, `StripePayoutProviderAdapter` (+ `fake-payout-provider`), `PayoutTransferService` (claim, attempt fencing, outcome mapping, answer validation, metrics), send handler, `declareJobType`; `payout-transfer.e2e-spec.ts` (AS-17…AS-26, 28, 29). | A8, A10–A13 (adapter), A14, A15; AS-17…AS-26, AS-28, AS-29 |
| WP-6 | **Resolver**: `PayoutResolverService`, `payouts.resolve-in-doubt` job (scheduled every minute, `fleetConcurrency: 1`), in-doubt event once, backoff from the pure module; AS-19 (stale), 20, 21, 22, 30 in `payout-transfer.e2e-spec.ts`. | A9; AS-19…AS-22, AS-30 |
| WP-7 | **Seller and operator API**: `PayoutsController`, `PayoutsAdminController`, query/cancel/destination/reserve services, cursor codec, policies, `@Idempotent()`, problem registrations; `payout-api.e2e-spec.ts`. | A16, A17; AS-31…AS-36, AS-38…AS-48 |
| WP-8 | **Audit**: `PayoutAuditService`, `payouts.audit-daily` job, `PayoutAuditDay` marker, discrepancy events and metrics; `payout-ops.e2e-spec.ts` audit block. | A18; AS-49 |
| WP-9 | **Modules, apps, barrel, deletions**: `PayoutsModule`, `PayoutsWorkerModule`; `LedgerWorkerModule` loses `Payout`/`PayoutJobs`/`PayoutProvider`; `apps/core`, `apps/worker`, `apps/local-monolith` swaps; `index.ts`; delete `payout-provider.port.ts`, old `payout.jobs.ts` body, `deriveJournalId`, the payout blocks of `finance.e2e-spec.ts` (after AS-01/17/23 pass), update `payment-boundary.e2e-spec.ts` barrel list and `ledger-maintenance.e2e-spec.ts` probe module (S14-owned specs: edited only for the import of the moved class, reported). | B1–B3, B6–B9, D-6, D-7, D-8, D-12 |
| WP-10 | **Observability, config, boundaries**: log fields and redaction, metrics gauges (`payout_in_doubt_age_seconds`), startup validation wired, `payout-ops.e2e-spec.ts` (AS-50…AS-54: events, metrics/logs, boundaries incl. standalone module compile, migration twice, configuration). | A19, A20; AS-50…AS-54 |
| WP-11 | **Contract migration** (guarded, shipped as a file for the later release; its guard is tested with legacy-shaped rows). | AS-53, E |
| WP-12 | **Whole-capability run**: four e2e files + seven units, then dependents (quickstart); `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:no-wallclock`, `check:model-registry`, `python3 scripts/livespec/check.py`; **boot proofs** of `apps/core`, `apps/worker`, `apps/local-monolith`; fill `UNVERIFIED.md` and the `gaps.md` appendices; record the green run (VII.9); write the report. | all |

## Gap coverage

| Gaps | Package | | Gaps | Package |
|---|---|---|---|---|
| A1, A2, A3 | WP-1 (rules), WP-4 | | A14, A15 | WP-3, WP-5 |
| A4, A5, A6, A7 | WP-4 | | A16, A17 | WP-7 |
| A8, A9 | WP-5, WP-6 | | A18 | WP-8 |
| A10, A11, A12 | WP-5 | | A19, A20 | WP-1, WP-10 |
| A13 | WP-2, WP-7 | | A21 | WP-4 |
| A22 | WP-2 | | A23 | WP-0 (baseline), WP-9 (old test replaced) |
| B1 (Shop in jobs) | WP-3 (`SHOP_SUMMARY_PORT`), WP-9 | | B2 (`Shop` in worker module) | WP-9 |
| B3 (raw `LedgerEntry` SQL) | WP-3/WP-4 | | B4 (FK to `Shop`) | WP-2 |
| B5 (api imports infra/Redis) | WP-7 | | B6 (use cases in `infra/`, `new Date()`) | WP-3…WP-6 |
| B7 (port in `infra/`) | WP-3, WP-5 | | B8 (barrel) | WP-9 |
| B9 (module split) | WP-9 | | B10 (exhaustive union) | WP-1 |
| C: D-6 → WP-3/WP-7/WP-9; D-7 → WP-3/WP-9; D-8 → WP-9; D-11/D-15/D-17 → no S15 edge (verified by `check:module-graph`/ownership in WP-12); D-12 → WP-3 | | | D (ownership lines) → WP-9, verified WP-12 | |
| E (work order) → WP-0…WP-12 in the same order | | | Follow-ups table above → WP-1, 2, 4, 5, 7, 9 | |

## Success-criteria proof

| SC | Proof |
|---|---|
| SC-001 | AS-02/03/15 at 20 shops × 20 races, AS-12 at 450 shops; every concurrency scenario ends with `assertBooksHealthy`; the **1,000-shop** figure is an Ops artifact + `UNVERIFIED.md` (the logic is size-independent, the count is not run) |
| SC-002 | AS-18 (10 deliveries × 20) |
| SC-003 | `assertBooksHealthy` (sum of lines = 0, clearing = sum of non-final payouts) at the end of AS-16, 18, 19, 23, 30, 42, 44 |
| SC-004 | AS-20/21/22 (no new key, resolver settles, alert at 24 h on the advanced clock) |
| SC-005 | AS-31/32/35 prove visibility on commit (read-your-write, no cache) and a single indexed query; the **p95 < 300 ms at 5 years** figure is an Ops artifact + `UNVERIFIED.md` |
| SC-006 | AS-09 (all five gates keep the balance and appear in the run summary) |
| SC-007 | AS-12 proves ≤ 3 tenancy calls and batched ledger reads at 450 shops; the **5-minute at 1,000 shops** figure is an Ops artifact + `UNVERIFIED.md` |
| SC-008 | AS-38…AS-42 (one request each, history with actor and reason, replay changes nothing) |
| SC-009 | AS-49 (five seeded kinds appear once; clean day none) |
| SC-010 | AS-52 (static ownership + FK) and AS-51 (no destination/key in logs, events, seller bodies) |

## Re-check after Phase 1

Design artifacts re-read against the gates: (1) layers hold — `application/` talks to tokens only, `domain/` has no framework import; (2) controllers map DTOs only; (3) the provider call, tenancy batches and ledger listing sit outside every transaction, transitions are conditional updates, uniqueness is the store's; (4) every added column is nullable or defaulted, the legacy drop is a later guarded file; (5) events through the outbox in the transition's transaction; (6) schemas listed for every route, writes are `@Idempotent()`; (8) a test row exists for every scenario; (10) nine new tables registered, no foreign key to a foreign owner, destination in a payments table; (11) barrel is the "Provides" list. **No gate fails; three named deviations (CT-1…CT-3) are recorded.** Three assumptions are confirmed by probes in WP-0 and can change only a field name or one adapter line: R-3 (`ctx.attempt` increases on reaped redelivery — verified in `job-claim.sql.ts:184`, probe only confirms), R-6 (Stripe transfer lookup by `transfer_group`), R-12 (`Firewall({sensitive})` signature).
