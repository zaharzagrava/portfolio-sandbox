# Implementation Plan: Phase 2 – Batch 3 Domain Restructuring

**Branch**: `004-phase2-batch3-domains` (work is on `master`, uncommitted, stacked on Phase 1 and batches
1–2) | **Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request plus
[`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md) and
[batch 2](../003-phase2-batch2-domains/plan.md).

**Status**: **Executed.** Eight new domains and every gate item is green. `libs/common/src/models/` now
holds only `all-models.ts`.

## Summary

- **Moves.** 13 legacy folders plus the last 8 legacy models moved into 8 new domains (116 files; 118 counting the 2 bis-utils files that ended up in payments).
  Pass 1 rewrote 228 specifiers in 84 files. Pass 2 rewrote 20 files to barrels.

  | Domain | Sources |
  |---|---|
  | `billing` | `billing` + `Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine` |
  | `statements` | `statements` |
  | `auctions` | `auctions` + `Auction` |
  | `launch-events` | `launch-events` + `live` + `LaunchEvent`, `Booking` |
  | `shop-functions` | `shop-functions` |
  | `asset-library` | `assets` |
  | `media` | `media` + `video` |
  | `catalog-sync` | `catalog-import` (import half) + `integrations` + `offline-sync` |
- **bis-utils.** The request said `utils/bis-utils` → `orders`. It actually went to **`payments`**
  ([R2](research.md#r2)). It only builds ledger account IDs, and only `PaymentModule` uses it. The
  domain map is corrected.
- **Two barrel cycles caught** by the module-graph check (tsc passed both times). Both were fixed at
  the source, with no `forwardRef` ([R2](research.md#r2), [R3](research.md#r3)).
- **Registry.** No edits. The placement check now covers **all 28** domain models (plus the 2
  infrastructure models), and passes.

## Technical Context

**Language/Version**: TypeScript 5.9 (`nodenext`, `isolatedModules`), Node ≥ 24

**Primary Dependencies**: NestJS (webpack), sequelize-typescript, Jest 30, TypeScript compiler API

**Storage**: PostgreSQL. No schema change.

**Testing**: `tsc --noEmit`, Jest unit (including the registry spec), the module-graph check, and
`nest build` for all 9 apps. e2e specs are typechecked and listed, not run (D2).

**Target Platform / Project Type**: unchanged

**Constraints**: no route or behavior changes, zero type errors, an unchanged unit result, history kept
(`git mv`), no deep cross-domain imports, no `undefined` in any app module graph, no `forwardRef`.

**Scale/Scope**: 116 files, 8 new domains, 3 hand fixes (bis-utils relocation, export-queue
constant, one barrel export removed).

## Constitution Check

*GATE: checked before the work and re-checked after it.*

| Rule | Result | Evidence / notes |
|---|---|---|
| I.1 layout | ✅ | Each new domain has only layer folders plus root modules, e2e specs, and `index.ts`. Unit specs sit next to their subject (`billing-math`, `reservoir`, `video` → `domain/`; `sandbox`, `image-pipeline`, `clamav` → `infra/`). |
| I.2 directions | ⚠ debt D-6 | api → infra: statements 1, launch-events 2. application → infra: billing 2, auctions 1, launch-events 2, shop-functions 1, media 1, catalog-sync 2. asset-library is clean. |
| I.3 pure `domain/` | ✅ | 0 Nest, ORM, or infrastructure imports. `periods.ts` uses `luxon`, a pure date library rather than a framework or client. |
| IX.3 registry | ✅ | 5/5. Placement covers 28 domain models plus 2 infrastructure models, which is every model in `libs/`. |
| IX.4 coupling | ✅ no new debt | None of the 8 models moved here is used outside its domain (only by `all-models.ts`, D-9). |
| X.4 single entry point | ✅ | 0 deep `@app/domains/<d>/…` imports. |
| X.5 acyclic | ⚠ unchanged | The only domain-level cycle is still orders ↔ payments (D-11). Batch 3 added none: two attempted cycles were removed ([R2](research.md#r2), [R3](research.md#r3)). |
| D2 / D-10 | ✅ recorded | Export routes and the worker's `kind: 'export'` branch remain in catalog-sync. Orders now has no dependency on catalog-sync. |
| D4 | ✅ | `BisUtilsService` (ledger account IDs) joined payments, so payment code stays in its transaction boundary. |
| VII.9 green run | ✅ | See [Validation](#validation). |

There are no unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-phase2-batch3-domains/
├── plan.md
├── research.md
├── data-model.md
├── contracts/domain-entrypoints.md
└── quickstart.md
```

### Source Code (after batch 3)

```text
packages/backend/libs/domains/   (16 domains)
├── identity tenancy catalog                                        # batch 1
├── orders payments chat fulfilment seller-onboarding               # batch 2 (+ payments/bis-utils.*)
├── billing statements auctions launch-events shop-functions        # batch 3
└── asset-library media catalog-sync                                # batch 3
packages/backend/libs/common/src/   (legacy, 24 folders left)
├── models/all-models.ts          # the only model file left (D-9)
├── utils/test-utils/             # Phase 3
└── … batch 4–5 folders, seeds/, bff/batch-read.controller.ts, types.ts, index.ts
packages/backend/scripts/refactor/phase2-batch3-moves.tsv   # NEW
docs/architecture/domain-map.md                             # bis-utils row corrected (orders → payments)
```

## Execution (what was run)

1. `phase2-move.sh phase2-batch3-moves.tsv --dry-run`: coverage guard passed (all files in 13
   folders mapped); 228 specifiers in 84 files.
2. Applied. `tsc`: 0 errors with deep paths.
3. `phase2-entrypoints.ts`: 8 new barrels; orders +2 exports appended; all other barrels unchanged.
   20 files rewritten.
4. **Module-graph check ✗** (core, local-monolith, worker, payment-processor). Traced with a
   require-stack hook:
   - `core.module → shop-functions/index → shop-functions.module → orders/index →
     order-export.service → catalog-sync/index → catalog-import.module` then reads
     `OrderExportService` while its file is still loading, so `CatalogImportModule.providers[1]`
     is `undefined`.
   - `payment-processor → payments → payment.module → orders/index (for BisUtilsModule) → … →
     stripe-webhook.controller` sees `@InjectModel(Payment)` while payments is still loading
     (`CircularDependencyException`).
5. **Fixes** ([R2](research.md#r2), [R3](research.md#r3)):
   - `bis-utils.module.ts` and `application/bis-utils.service.ts` moved `orders` → `payments`
     (`git mv`). Their imports became relative, and the two orders barrel exports were removed.
   - `OrderExportService` stopped importing `IMPORT_QUEUE` from catalog-sync. It uses a local
     `EXPORT_QUEUE = 'catalog-imports'` (the same string, documented as D-10). The unused
     `IMPORT_QUEUE` export was dropped from the catalog-sync barrel.
6. **Module-graph check ✓ 9/9.** Node counts are identical to after batch 2 (core 315, worker
   227, payment-processor 34, local-monolith 509).

## Validation

| Check | After batch 2 | After batch 3 |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| Jest unit | 30/31 suites, 130 tests | **30/31 suites, 130 tests** (8 moved unit specs pass in place; only `discussions/ranking.spec.ts` fails, as before) |
| `jest db/` | 5/5, 20 domain models | **5/5, 28 domain models** |
| `pnpm check:module-graph` | 9/9 | **9/9**, same node counts |
| `nest build`, all 9 apps | ✓ | **✓** |
| e2e specs listed | 52 | **52** |
| Deep cross-domain imports | 0 | **0** |
| `libs/common/src/models/` | 9 files | **`all-models.ts` only** |

## Debt

- **D-6 (I.2):** batch 3 counts are in the Constitution Check.
- **D-8 (infrastructure internals in barrels)** grows: `UsageProjector`, `LiveCommentsProjector`,
  `LiveModerationConsumer`, `LiveTicker`, `live-keys` helpers, `MediaProcessor`, and
  `StockPushProjector`. They're exported because the projector, sse-gateway, and Lambda apps wire
  them directly.
- **D-10 (D2):** recorded, not fixed. Export routes and the worker branch are still in catalog-sync,
  sharing the `'catalog-imports'` queue. Orders now duplicates that literal on purpose
  (`EXPORT_QUEUE`). D-10 replaces it with an orders-owned queue.
- **D-11 (X.5):** orders ↔ payments, unchanged.

## Next

Batch 4: community, content, notifications, discovery, seller-insights. Then batch 5:
developer-platform, marketing, experimentation, assistant. Then Phase 3 cleanup. Prompts for all
three were prepared in the session that planned this batch.

## Complexity Tracking

No constitution violations need justification.
