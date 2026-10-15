# Implementation Plan: S09 — Offline-First Inventory Sync (domain `catalog-sync`)

**Branch**: `S09-offline-sync` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), `.specify/memory/constitution.md`.

## Summary

Replace the 223-line `SyncService` (raw `UPDATE "Product"`, raw `products.events` outbox rows, a trigger and foreign key on the catalog's table, global `opId` key, whole-batch `400`) with the design of the spec: **claim → catalog call with a deterministic operation ID → record result**, stock only through `ProductStockService.applyStockDelta`, fields only through `ProductCommandService.update`, a change feed built by a projector from `catalog.product_*` events, conflicts as a reviewable queue, three modules (`OfflineSyncModule`, `OfflineSyncWorkerModule`, `OfflineSyncProjectorModule`).

Approach (same shape as S08): pure `domain/` core first (ops schemas, HLC, delta/clamp arithmetic, per-field decision, cursor codec) → ports in `domain/ports/` → Sequelize adapters in `infra/` → use-case services in `application/` (no `sequelize`, no `infra/` imports) → thin controllers. Contracts in `packages/contracts/src/catalog-sync/` first. Expand/contract migration last-step drops the trigger and the foreign key.

### Follow-ups left by built specs — each is a requirement here

| From | Follow-up | Where handled |
|---|---|---|
| S05 | write only through `applyStockDelta` / `ProductCommandService.update`; stop `catalog.product_changed` and `INSERT/UPDATE "Product"`; `price` → `priceMinor`; `quantity ≥ 0` | `CatalogGateway` port + `infra/sync-catalog.adapter.ts`; A1–A4, A17, A23 (gaps.md); `priceMinor` on the wire (FR-016) |
| S05 | **repair step** in legacy `applyOp` (clamp under row lock; test asserts `0`) is a stopgap | replaced wholesale by clamp-by-second-`applyStockDelta` (research R-03); the legacy `sync.e2e-spec.ts` is deleted, its scenario lives on as AS-08/AS-09 in `sync-push.e2e-spec.ts` (L-017) |
| S05 | S09 uses `applyStockDelta` with a `rejected` / `insufficient_stock` result as conflict signal | `StockApplier` in `application/` (R-03) |
| S08 | stock written only through `applyStockDelta`; S08 pushes to the provider from `products.events`, no call into catalog-sync | no S09 → S08 call; AS-52 proves events come from the catalog |
| S49 | `declareJobType` with a contract next to `JobPayloads`; adapt to discriminated `JobsService.cancel`; catch `InvalidScheduleError` | three jobs declared in `infra/offline-sync.jobs.ts` (same pattern as `integrations.jobs.ts`); `cancel` is never called; registration wrapped in `try/catch InvalidScheduleError` with a logged, fatal-at-boot message (T-jobs) |
| gaps.md | A1–A29, debt D-6, D-7, D-8, D-12, section C ownership lines | Phase mapping in the table below; every row has a task owner |

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22, NestJS 11 monorepo (`packages/backend`, `packages/contracts`).

**Primary Dependencies**: NestJS, Sequelize (raw SQL against own tables), `zod`, `fast-check`; infra: `TransactionRunner`/`@Transactional` (S54), `OutboxService.append` (S53), projections framework (`@app/infrastructure/projections`), `JobsService`/`declareJobType` (S49), `RateLimit` + `definePolicies` (S50), injectable `CLOCK`, metrics registry; S05 R1 services through `@app/domains/catalog`; S03 `ShopScoped`.

**Storage**: PostgreSQL, own tables only: existing `SyncOperation`, `ShopChangeLog`, `ShopSyncState`, `ProductFieldClock` (reshaped) + new `SyncConflict`. No foreign key and no trigger on or to a catalog table.

**Testing**: Jest e2e (7 files, real modules, supertest) via `/opt/sdd/repo/scripts/sdd/test-spec.sh`; `it.each` + `fast-check` unit specs under `domain/` (5 files); faked edges only: token verification and clock; faults by real mechanisms (store rule refusing one write, slow store).

**Target Platform**: `apps/core` (HTTP), worker app (jobs), `apps/projector` (consumers); `apps/local-monolith` hosts all. Each must boot alone (L-018).

**Project Type**: backend domain module (web-service + projector + jobs).

**Performance Goals**: SC-003 (push ≤50 ops p99 < 1 s, pull page < 200 ms, feed lag < 5 s) — load test outside e2e → Ops artifacts.

**Constraints**: no catalog call inside an open transaction of this domain (A6); claims committed first; numbers (500 ops, 2 MiB, 20 s budget, 60 s lease, 5 min recovery, 60 s drift, 30 d/90 d) are validated config; no direct `sequelize.transaction` added (baseline 0).

**Scale/Scope**: 55 acceptance scenarios, 40 FRs, 4 routes, 3 jobs, 3 consumers, 1 event.

No `NEEDS CLARIFICATION` remains; decisions are in [research.md](research.md).

## Constitution Check

*GATE: passes before Phase 0 and after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I Layered modules (D-6) | PASS | Repository ports (`OperationRepository`, `FeedRepository`, `FieldClockRepository`, `ConflictRepository`→ named `SyncConflictRepository` to avoid S08's token) in `domain/ports/`, adapters in `infra/repositories/`; `application/sync.service.ts` deleted |
| II Pipeline/routing | PASS | Controllers thin; envelope validation by DTO/zod pipe; 2 MiB body limit and `X-Device-Id` pipe; production pipe/filter |
| III Data access & transactions | PASS | `TransactionRunner.run` / `@Transactional` only; every query includes `shopId` (III.4); keyset cursors opaque (III.10); no new `sequelize.transaction`; per-product serialisation via `pg_advisory_xact_lock` inside a `run` |
| IV Module communication | PASS | Catalog only via R1 services + events (event copy, IX.8); own event through `outbox.append` in the transaction that records the conflicting result (IX.6); consumers use the framework's envelope check, zod, version guard, DLQ |
| V API contracts | PASS | zod schemas in `packages/contracts` first; problem+json `code`s from Provides; no `Idempotency-Key` (per-op IDs, documented) |
| VI Frontend | N/A | Device app is phase 2; W04 owns the conflict screen |
| VII Testing | PASS | e2e per feature file with persisted-state assertions; unit only for pure logic; Gate 9 faults forced for AS-13/14/37/38; no `ProductModel`/`ShopModel` in specs (D-7) |
| VIII Operational safety | PASS | Config validated at start; metrics and log fields of AS-51 with no product content; generic `503 sync_unavailable` |
| IX DB isolation | PASS | Drop trigger `product_change_log_trg`, function, and `ProductFieldClock → Product` FK (expand/contract, `lock_timeout`); `SyncConflict` registered in `db/ownership.ts`; `check:table-ownership --strict` clean for `catalog-sync` files of S09 (baseline findings: 2 → 0 for `sync.service.ts`) |
| X Monorepo/boundaries | PASS | Barrel exports `OfflineSyncModule`, `OfflineSyncWorkerModule`, `OfflineSyncProjectorModule`; `SyncService` no longer exported; apps import the modules (D-8) |

**Complexity tracking** (justified deviations): none. Two items to watch: (1) S08's `integration-boundary.e2e-spec.ts` pins the barrel's export list — adding the two modules changes a spec S08 owns → reported as a sibling follow-up, the pin is updated only in the line that lists S09's exports; (2) `sync-feed-consumer` shares the topic `products.events` with S08's consumer under a different consumer group name (`catalog-sync-offline-feed`).

## Gap → phase map

| Phase | Contents | Gaps/debt closed |
|---|---|---|
| 0 | Living-spec page `docs/spec/capabilities/S09-offline-sync.md` (rules/behaviors first, `check.py` green), contracts in `packages/contracts` | A10, VII.6 |
| 1 | Migration (expand): `SyncOperation` shape, `SyncConflict`, feed columns/generation, `ProductFieldClock.shopId`; `db/ownership.ts` | A7, A16, A18, A23 |
| 2 | Pure domain: `ops`, `hlc` (threshold parameter), `outcome`, `merge`, `cursor` + 5 unit specs | A8, A11, A25, A26 |
| 3 | Ports + Sequelize adapters + `CatalogGateway` adapter | A29, D-6, D-12 |
| 4 | Push service (claim/apply/record, takeover, budget, clamp, fields with serialisation, retry) | A1–A6, A9, A13, A14 |
| 5 | Pull + bootstrap + conflicts services; controllers; rate-limit policies | A15, A16, A18–A21 |
| 6 | Projector module: feed consumer, `shop_deleted`, `product_deleted`; backfill with new generation | A17, A22 |
| 7 | Worker module: 3 jobs with `declareJobType` | A12, A22 |
| 8 | Observability | A27 |
| 9 | Tests: 7 e2e + 5 unit; delete `sync.e2e-spec.ts` | A24, A25, D-7 |
| 10 | Contract migration (drop trigger/FK/old key), barrel, apps wiring, boundary gates, boot proofs | A28, D-8, D-12 |

## Project Structure

```text
specs/domains/S09-offline-sync/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  http-api.md  events-and-jobs.md  ports.md

packages/contracts/src/catalog-sync/
├── offline-sync.ts          # NEW: push/pull/conflict/event schemas (syncPushRequestSchema … syncEventSchemas)
└── index.ts                 # + export

packages/backend/libs/domains/catalog-sync/
├── domain/
│   ├── hlc.ts               # threshold injected (A26)
│   ├── sync-ops.ts          # NEW wire schemas + normalised op, fingerprint input
│   ├── sync-outcome.ts      # NEW result classification, clamp arithmetic
│   ├── sync-merge.ts        # NEW per-field decision with tie rule (replaces merge.ts sync half)
│   ├── sync-cursor.ts       # NEW cursor codec bound to shop + generation
│   └── ports/               # NEW sync-*.ts ports
├── application/
│   ├── sync-push.service.ts  sync-pull.service.ts  sync-conflict.service.ts
│   ├── sync-lifecycle.service.ts   # redrive, compact, purge, shop/product deletion
│   └── sync-metrics.ts
├── infra/
│   ├── repositories/sequelize-sync-*.ts
│   ├── sync-catalog.adapter.ts      # R1 services behind the port
│   ├── sync-feed.consumer.ts  sync-lifecycle.consumers.ts
│   └── offline-sync.jobs.ts
├── api/sync.controller.ts  sync-conflicts.controller.ts   # thin
├── sync.module.ts           # OfflineSyncModule + Worker + Projector
├── sync-push.e2e-spec.ts  sync-fields.e2e-spec.ts  sync-pull.e2e-spec.ts
├── sync-feed-consumer.e2e-spec.ts  sync-conflicts.e2e-spec.ts
├── sync-access.e2e-spec.ts  sync-lifecycle.e2e-spec.ts
└── migrations/ (backend: packages/backend/migrations/<ts>-offline-sync-expand.js, …-contract.js)
```

Existing `domain/merge.ts` / `merge.spec.ts` (stock delta + `winningFields`) are replaced by `sync-merge.ts` + `merge.spec.ts` rewritten per test-plan; other S07/S08 files are untouched.

## Verification order (token discipline)

Narrowest test per change; the whole `catalog-sync` suite once at the end in per-file batches (L-008) after `scripts/qa/fresh-run.sh` (L-012); then boot `apps/core`, worker, `apps/projector`, `apps/local-monolith` standalone (L-004, L-015, L-018); `python3 scripts/livespec/check.py`; `pnpm check:table-ownership --strict`, `check:boundaries`.
