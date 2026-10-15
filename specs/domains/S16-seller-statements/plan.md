# Implementation Plan: S16 — Seller statements (domain `statements`)

**Branch**: `S16-seller-statements` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md` (A1–A32, B1–B6, C1–C7, D1–D8), `questions.md` (defaults accepted as written; no human edits found), constitution v3.1.0, the follow-ups listed under "Follow-ups from built specs" below.

## Summary

Rebuild `libs/domains/statements` from a service that joins `BisOrder`/`BisOrderItem`/`Product` with raw SQL into the layered, event-fed, bitemporal domain the spec describes:

- **Facts in (R3).** Three projectors in `StatementsProjectorModule` (`order.paid`, `payout.paid`, `ledger.journal_posted` v2) copy facts into statements-owned tables. Sale facts are append-only per `(orderId, lineId, orderVersion)` with `recordedAt = occurredAt`. No query touches another domain's table (closes D-12, C1–C4).
- **Pricing in the store.** One SQL shape prices a month: sale facts `LEFT JOIN LATERAL` the best-matching bitemporal `CommissionRate` row (so an unpriced line is counted, never dropped). Commission arithmetic is defined once in `domain/commission.ts`; the SQL aggregate uses the same integer formula and a parity test pins them together.
- **Bitemporal rates.** The existing `CommissionRate` table and exclusion constraint stay; `setRate` becomes a serialised, idempotent, injected-clock use case with change IDs, no-op detection, default-gap guard and shop-existence check through `ShopQueryService`.
- **Period close.** `AccountingPeriod` gains `CLOSING`, a persisted `knowledgeCutoff` and a run record; snapshots are written in bounded batches under the same cutoff, visible only when the period is `CLOSED` (store triggers enforce immutability).
- **Adjustments.** One job `statements.reconcile-month {month, cause, shopId?}` computes the residual (fresh recomputation − snapshot − earlier adjustments) under a per-shop-month advisory lock and books it once per `(shop, month, causeKind, causeRef)`; it is triggered by rate changes, late facts and the close's completion.
- **Seller/operator API, CSV, reconciliation, findings** as specified; money named `…Minor`; every body has a schema in `packages/contracts/src/statements`.

## Technical Context

**Language/Version**: TypeScript strict, Node 22, NestJS (existing monorepo `packages/backend`, `packages/contracts`).

**Primary Dependencies**: `@nestjs/sequelize` + raw SQL in `infra/` only; S54 `TransactionRunner`, `CLOCK`, `@Idempotent`, `READ_REPLICA_CONNECTION`, shutdown registry, metrics; S49 `JobsService`/`@JobHandler`/`upsertSchedule`; S53 `OutboxService.append`, `Projector` framework (`infrastructure/projections`), `InboxService`; S50 `RateLimit`/`definePolicies`; S03 `ShopScoped`, `ShopQueryService.getShopsByIds`; S01 `Firewall`; zod; `fast-check`.

**Storage**: PostgreSQL (shared `public` schema, flat names, registry in `packages/backend/db/ownership.ts`). No new engine. Redis only through the rate limiter. Kafka only through the projector framework and the outbox relay. ClickHouse is not used for exact figures (questions.md CONTRACT).

**Testing**: eight `*.e2e-spec.ts` files and six unit specs exactly as in `test-plan.md`; run through `/opt/sdd/repo/scripts/sdd/test-spec.sh`. Playwright is owned by W04/J01 (D7).

**Target Platform**: three loaders of the same domain: `apps/core` (`StatementsModule`), `apps/worker` (`StatementsWorkerModule`), `apps/projector` (`StatementsProjectorModule`). No new deployable app (I.6).

**Performance Goals**: SC-004 close of 100k shops with sales < 5 min (batches ≤ 10,000); SC-005 closed-month read p95 < 300 ms, no fact reads; SC-006 200k-line export < 50 MB extra; SC-007 live freshness p95 < 60 s.

**Constraints**: injected clock everywhere (`check:no-wallclock`); explicit timeouts; `tables(q) ⊆ owned(statements)`; expand/contract migrations with `lock_timeout`; no `sequelize.transaction` in the domain (T037 audit sites migrated, count must reach 0).

**Scale/Scope**: 1M shops, ~100k with sales per month, 5 years of history; sale facts in the hundreds of millions of rows over the life of the store.

### Pool arithmetic (III.12)

- Core API: primary pool unchanged (platform default). Statement reads of closed months and exports use `READ_REPLICA_CONNECTION` (max 5 per instance, `statement_timeout` from `db_statement_timeout_ms`; the export sets `SET LOCAL statement_timeout = statements.export.timeoutMs` in its read-only transaction). The private `ReportingPool` (5 connections, `rejectUnauthorized:false`) is deleted, so core instances hold 5 fewer connections than today.
- Exports hold one replica connection each; per-shop limit 2 concurrent; with N core instances the worst case is bounded by the replica pool (5 × N) because the 6th export waits at `acquire` (3 s) and answers `503`. The primary is only used on the replica-unreachable fallback (one attempt).
- Worker: close and reconcile jobs use the primary pool; handler concurrency for `statements.close-month` is 1, `statements.reconcile-month` 4, `statements.verify-period(s)` 1, so at most 6 concurrent worker transactions, each a single connection; below the worker pool default.
- Projector: one transaction per batch per partition, bounded by the framework's in-flight limiter.

## Constitution Check

*GATE — before Phase 0 and again after Phase 1.*

| Rule | Status | How |
|---|---|---|
| I.1/I.2 layers | PASS (after work) | New `domain/` (pure), `application/` (use cases, `@Transactional`/runner), `infra/` (repositories, projectors, jobs, export). `application` reaches `infra` only through `domain/ports.ts` tokens. Closes B1/B2/A31. |
| I.3 clock | PASS | All `new Date()`/`now()` replaced by `CLOCK` (B3, A15); SQL receives the instant as a bound parameter. |
| I.4 / IX single owner | PASS | Owned set listed in `data-model.md`; registry rows added in the same PR; `check:table-ownership --strict` for statements files. |
| II.1 controllers thin | PASS | DTO validation via zod pipes in `api/`; one service call; CSV through a streaming helper (B5) instead of `@Res()` logic in the controller body. |
| III.2/III.3 transactions | PASS | `TransactionRunner.run` only; the two `// S54 T037 audit` sites are migrated and the comments deleted. No network I/O inside a transaction; job enqueue and `outbox.append` are the documented in-transaction exceptions. |
| III.4 principal in predicate | PASS | `ShopScoped('payouts.read')` resolves membership in the access predicate; admin routes `Firewall({roles:[ADMIN]})`. |
| III.6/III.7 invariants & transitions | PASS | Exclusion constraint (rates), unique `(shop, month, causeKind, causeRef)` (adjustments), conditional `UPDATE … WHERE status = :from` plus history row (periods), store triggers for immutability. |
| III.8 money | PASS | `BIGINT`, `…Minor`; JSON money as integer numbers (assumption: sums < 2^53). |
| III.10 pagination | PASS | Keyset with opaque cursor and unique tiebreaker on every list. |
| III.11 migrations | PASS | One expand migration + one contract migration (after the old reader is gone) with `lock_timeout`; legacy columns stay until contract. |
| III.12 timeouts/pools | PASS | See arithmetic above; every statement/job/outbound call has an explicit timeout (AS-81). |
| IV.3–IV.5 consumers/outbox | PASS | Projectors declare their mechanism (`versionGuard` + inbox claim in the same transaction), zod-validate, dead-letter poison; events leave through the outbox. |
| V.2/V.3/V.6 contracts/errors/idempotency | PASS | `packages/contracts/src/statements/*`; problem+json codes per `contracts/http.md`; `Idempotency-Key` on both POSTs. |
| VII tests | PASS (planned) | `test-plan.md` followed one-to-one; Gate 9 faults forced. |
| VIII.5/VIII.4/VIII.6 | PASS | Config schema validated at startup (AS-79); cooperative stop (AS-80); schedule has `UTC` zone and lease. |
| IX.4/IX.7 | PASS | Only R1 (`ShopScoped`, `ShopQueryService`) and R3 (events) used; R2 unused. |
| I.6 new app | N/A | No new deployable. |

**Justified deviations**: none. **Post-design re-check**: the design in `data-model.md` and `contracts/` introduces only statements-owned tables and the three technical-table uses (outbox, inbox, jobs), all through their libs: still PASS.

## Phase 0/1 artifacts

- [research.md](research.md) — decisions and the dependency/contract gaps found while planning (order.paid lacks `lineId`/`category` today).
- [data-model.md](data-model.md) — tables, constraints, triggers, state machines, migrations.
- [contracts/](contracts/) — `http.md`, `events.md`, `jobs.md`, `config.md`.
- [quickstart.md](quickstart.md) — runnable validation, Ops artifacts.

## Project Structure

### Documentation

```text
specs/domains/S16-seller-statements/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/{http.md,events.md,jobs.md,config.md}
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md            # next command (/speckit-tasks)
```

### Source code

```text
packages/contracts/src/statements/
├── index.ts  rates.ts  statements.ts  periods.ts  findings.ts  events.ts    # zod schemas (V.2, FR-052)

packages/backend/libs/domains/statements/
├── statements.module.ts            # core: HTTP + use cases + repositories + CommissionRateQueryService
├── statements-worker.module.ts     # jobs: close, reconcile, verify (own providers; boots standalone, L-018)
├── statements-projector.module.ts  # three projectors (apps/projector)
├── rate-limit-policies.ts          # statements.read, statements.export.concurrent, statements.admin.read/write
├── index.ts                        # StatementsModule, StatementsWorkerModule, StatementsProjectorModule, CommissionRateQueryService + DTO types, event contracts, policies
├── api/
│   ├── statements.controller.ts    # seller routes (3)
│   ├── commission-rates.controller.ts
│   ├── accounting-periods.controller.ts
│   └── statements.dto.ts           # zod pipes from contracts
├── application/
│   ├── commission-rate.service.ts  # setRate, history, asOf
│   ├── commission-rate-query.service.ts   # R1 batch export
│   ├── statement.service.ts        # read use cases (live/snapshot/as-known-at/list)
│   ├── period-close.service.ts     # request, run, resume, finalise
│   ├── adjustment.service.ts       # reconcile-month
│   ├── fact-ingestion.service.ts   # apply validated facts, trigger late-fact work
│   ├── verification.service.ts     # verify-period(s), findings
│   └── events/statements-events.ts # defineEvent for the two outgoing events
├── domain/
│   ├── commission.ts  rate-lookup.ts  recorded-instant.ts  period.ts (month, booking month, transitions)
│   ├── residual.ts (adjustment residual)  reconciliation.ts  csv.ts  cursor.ts
│   ├── statement-view.ts (own/total/corrected composition)  errors.ts  config.ts  metrics.ts
│   └── ports.ts                    # RATE_REPOSITORY, FACT_REPOSITORY, PERIOD_REPOSITORY, SNAPSHOT_REPOSITORY, ADJUSTMENT_REPOSITORY, FINDING_REPOSITORY, STATEMENT_READER, SHOP_DIRECTORY, ...
├── infra/
│   ├── models/*.model.ts           # owned tables only
│   ├── *.repository.ts             # SQL lives here (bound parameters, UTC bounds computed in TS)
│   ├── order-paid.projector.ts  payout-paid.projector.ts  ledger-journal.projector.ts
│   ├── watermark.repository.ts
│   ├── statements.jobs.ts          # @JobHandler registrations + schedule bootstrap (UTC)
│   ├── statement-export.ts         # cursor stream, batch 1,000, abort semantics
│   ├── streaming-response.ts       # keeps the filter in charge until first byte, aborts after (B5)
│   └── shop-directory.adapter.ts   # ShopQueryService adapter (anti-corruption)
├── *.spec.ts (domain/) and the eight *.e2e-spec.ts files of test-plan.md

packages/backend/migrations/
├── 2026101[6]…-statements-s16-expand.js     # additive: states, columns, tables, triggers, backfill
└── 2026101[6]…-statements-s16-contract.js   # drops retired columns/unique after the old reader is gone
packages/backend/db/ownership.ts             # rows for new tables, views, functions, triggers
packages/backend/test/fixtures/statements/   # DS-1, RC1, golden dataset + expected.json
scripts/bench/statements-close-100k.ts       # SC-004 (performance job)
docs/spec/capabilities/S16-seller-statements.md   # living page (rule 0), created in the first behavior task
docs/work/architecture/{domain-map.md,debt-register.md}   # C6/D-12 update
```

## Gap-to-plan map (every gaps.md item has an owner)

| Gap | Resolved by (section / file) |
|---|---|
| A1, C1, C2, C4 | Projectors + fact tables + pricing reader (`research.md` R-1, R-3, `data-model.md`) |
| A2 | `LEFT JOIN LATERAL`, `unpricedLineCount`, default-gap guard (R-3, R-6) |
| A3 | UTC bounds computed in TS (`domain/period.ts`), bound as `timestamptz` (R-3) |
| A4, A5, A6, A7 | `statement.service.ts` + `domain/statement-view.ts` + contracts + month list route |
| A8, A16–A17 | Policies + `RateLimit` per route; change ID in jobs; paged history, as-of route |
| A9, A10, A11, A13, A14 | `period-close.service.ts`, `adjustment.service.ts`, admin controller, triggers (R-4, R-5) |
| A12 | Adjustment key `(shop, month, causeKind, causeRef)`, four deltas (data-model) |
| A15 | `commission-rate.service.ts` with clock, advisory lock, change ID (R-2) |
| A18, A19, B5 | `domain/csv.ts`, `statement-export.ts`, `streaming-response.ts` (R-7) |
| A20, A21, A22 | Projectors, `verification.service.ts`, outbox events |
| A23, A26 | UTC schedule, shutdown registry integration |
| A24, A25, A27 | `domain/metrics.ts`, `domain/config.ts`, replica handle |
| A28 | Retention rule in the living page and `verification` check that no buyer column exists; no delete route |
| A29 | Expand/contract migrations (data-model §Migrations) |
| A30, C3 | Rewrite as the eight e2e files; fixtures deliver events, S03 test double for shops |
| A31, A32, B1–B4, B6 | Layer split, ports, exports (`index.ts`), three modules |
| C5 | `ShopDirectoryPort` over `ShopQueryService.getShopsByIds` |
| C6, C7 | Docs update task (domain map, debt register) and sibling bullet for S10 |
| D1–D8 | Tracked in research.md R-9 and `gaps.md` § Sibling-spec follow-ups |

## Follow-ups from built specs (requirements of this plan)

- **S03**: statements uses no `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw tenancy SQL after C3 is fixed; the e2e uses the scriptable S03 double. Retest: `payouts.read` routes exclude VIEWER (AS-23 asserts 403 for viewer and staff); the three seller routes are reads, so `shop_suspended`/`shop_offboarding` write answers do not apply — AS-76 asserts reads still work for an offboarded shop's admins.
- **S05**: the report leaves the `Product` join — satisfied by the category copy in `order.paid` (R-1).
- **S10**: statements stop reading order tables and settle on `order.paid` shop split — R-1 (the per-line `shopId` is the split).
- **S14**: only `ledger.journal_posted` **v2** is consumed (`LedgerEntry`/`LedgerJournal` never read; v1 payloads are rejected as unknown version); commission rates replace the flat fee only inside S14's `domain/fee.ts` (S14's change, via `CommissionRateQueryService`).
- **S15**: `payout.paid` from `payouts.events`, key `payoutId`, schema `payoutPaidSchema` from `packages/contracts/src/payments/payout-events.ts` (imported, not re-declared); discard `payoutVersion` ≤ stored; amount is `amountMinor`; the paid day is `paidAt`.
- **S50 / G-35**: `exports.concurrent` is replaced by `statements.export.concurrent`; `statements.read`, `statements.admin.read`, `statements.admin.write` are declared in this domain's `rate-limit-policies.ts`. The old `exports.concurrent` name stays declared by statements until other call sites that borrow it move (T048), then is deleted last.

## Complexity Tracking

| Decision | Why | Simpler alternative rejected |
|---|---|---|
| Append-only sale facts versioned by `orderVersion` | `knownAt` must give the same answer after a replay and after a replaced version | In-place upsert would make an older `knownAt` lose lines |
| `appliedAt` column on facts in addition to `recordedAt` | Snapshots must be deterministic and must exclude facts the system had not applied at the cutoff, so late facts become adjustments (AS-45) | Filtering on `recordedAt` alone would put a late-applied fact into a resumed run non-deterministically |
| Store triggers for immutability | FR-024/AS-37 demand store-level enforcement | Application guards cannot stop a privileged write |
