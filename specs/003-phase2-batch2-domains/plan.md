# Implementation Plan: Phase 2 – Batch 2 Domain Restructuring

**Branch**: `003-phase2-batch2-domains` (work is on `master`, uncommitted, stacked on Phase 1 and batch 1) |
**Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request plus
[`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md) and
[batch 1](../002-phase2-domain-restructuring/plan.md).

**Status**: **Executed.** `orders`, `payments`, `chat`, `fulfilment`, and `seller-onboarding` live in
`libs/domains/` with the I.1 layout and one entry point each. All checks are green.

## Summary

- **Moves.** Twelve legacy folders, the order-export service, and 11 models moved into five domains
  (104 files). Pass 1 rewrote 303 import specifiers in 108 files. Pass 2 rewrote 53 files to the
  new barrels.
  - `orders` = `orders` + `bis-order` + `catalog-import/order-export.service.ts` (D2) + 5 models.
  - `payments` = `payment` + `payment-dto` + `ledger` + `finance` + 3 models: one domain, so one
    ACID boundary (D4).
  - `chat` = `chat` + `chat-dto` + `chat-sync` + 3 models.
  - `fulfilment` = `pickup` + `delivery`.
  - `seller-onboarding` = `onboarding`.
- **One regression caught and fixed.** `tsc` passed, but the module-graph check failed. A barrel
  cycle (catalog → identity → **infrastructure/stripe → payments** → orders → catalog) left
  `@InjectModel(Product)` `undefined` at decoration time. The root cause was the Stripe adapter
  importing domains (X.3, Phase 1 debt D-1). I fixed it at the source rather than adding
  `forwardRef` ([R2](research.md#r2)).
- **Ownership registry.** No entries changed. Batch 1 registered all 100 tables, including every
  batch 2 table. The spec's placement check now covers **20** domain models (it was 9) and passes.

## Technical Context

**Language/Version**: TypeScript 5.9 (`nodenext`, `isolatedModules`), Node ≥ 24

**Primary Dependencies**: NestJS (webpack), sequelize-typescript, Jest 30, TypeScript compiler API

**Storage**: PostgreSQL. No schema change.

**Testing**: `tsc --noEmit`, Jest unit (including the registry spec), the module-graph check, and
`nest build` for all 9 apps. e2e specs are typechecked and discovered, not run (D2).

**Target Platform / Project Type**: unchanged (NestJS modular monolith with multiple
deployables)

**Constraints**: zero new type errors, an identical unit result, history kept (`git mv`), no deep
cross-domain imports, all app module graphs free of `undefined`.

**Scale/Scope**: 104 files in 5 domains, 108 + 53 files rewritten, and 2 hand fixes in
`libs/infrastructure/stripe`.

## Constitution Check

*GATE: checked before the work and re-checked after it.*

| Rule | Result | Evidence / notes |
|---|---|---|
| I.1 layer folders only | ✅ | Each domain has only `api/ application/ domain/ infra/` plus root modules, e2e specs, and `index.ts`. Event contracts sit in `application/events/` ([R1](research.md#r1)). |
| I.2 import directions | ⚠ debt (D-6) | api → infra: orders 3, payments 2, chat 1, fulfilment 2. application → infra: orders 2, payments 2, chat 1, fulfilment 2. seller-onboarding is clean. |
| I.3 `domain/` is framework-free | ✅ | 0 imports of Nest, ORM, or infrastructure in any batch 2 `domain/`. |
| D4 one ACID boundary for payments | ✅ | Payment, ledger, payouts, and reconciliation share one domain, so `LedgerService` and `PaymentService` can keep using one transaction. |
| D2 ExportJob → orders | ✅ partial | `OrderExportService` (the only code that queries `ExportJob`) is in `orders/application`. Its HTTP route and queue consumer are still registered by the legacy `catalog-import` module ([D-10](#debt)). |
| IX.3 registry | ✅ | All 5 checks pass, and model placement holds for 20 domain models. |
| IX.4 coupling ban | ⚠ debt (D-7) | New cross-domain model consumers: `BisOrderModel` in payments (and legacy auctions), `PaymentModel` in orders. |
| X.3 infrastructure has no domain deps | ✅ improved | The Stripe adapter no longer imports `payments` or `identity` ([R2](research.md#r2)). |
| X.4 single entry point | ✅ | 0 deep `@app/domains/<d>/…` imports in the repo. |
| X.5 acyclic domain graph | ⚠ | orders ↔ payments still reference each other's models (lazy association arrows and type use). It's runtime-safe (the graph check passes), but it violates X.5 as written. Fixing it needs R1/R3 replacements (D-7). **Correction (Phase 3):** "runtime-safe" was wrong. payment-processor failed to boot in a fresh process; the in-process module-graph check hid it. Fixed in [Phase 3](../007-phase3-cleanup/plan.md) (lazy model accessors; per-process graph check). |
| VII.9 green run | ✅ | See [Validation](#validation). |

No unjustified violations. Every ⚠ row is pre-existing coupling that the move exposed. Each one is
tracked with a debt ID.

## Project Structure

### Documentation (this feature)

```text
specs/003-phase2-batch2-domains/
├── plan.md
├── research.md
├── data-model.md                    # registry: unchanged entries, wider placement coverage
├── contracts/domain-entrypoints.md  # public surface of the 5 new domains
└── quickstart.md
```

### Source Code (after batch 2)

```text
packages/backend/libs/domains/
├── identity/ tenancy/ catalog/                        # batch 1
├── orders/        { api/ application/{events/} domain/ infra/{models/} } + orders*.module, index.ts
├── payments/      { api/ application/{events/} domain/ infra/{models/} } + payment*, ledger, finance* modules
├── chat/          { api/ application/{events/} domain/ infra/{models/} } + chat*, chat-sync, chat-offline-worker modules
├── fulfilment/    { api/ application/{events/} domain/ infra/ }          + pickup, delivery* modules
└── seller-onboarding/ { api/ application/{events/} domain/ infra/ }      + onboarding.module
packages/backend/libs/infrastructure/stripe/stripe.errors.ts   # NEW: CircuitBreakerOpen error, moved from payments
packages/backend/scripts/refactor/
├── phase2-batch1-moves.tsv   # renamed from phase2-moves.tsv; has a `# batch-dirs:` header
├── phase2-batch2-moves.tsv   # NEW
├── phase2-move.sh            # now takes <batch-moves.tsv>; refuses to re-apply a batch
└── phase2-entrypoints.ts     # now appends to existing barrels (idempotent on earlier batches)
```

## Execution (what was run)

1. **Tooling.**
   - `phase2-move.sh` takes the move map as an argument and reads `# batch-dirs:` from it. The
     re-apply guard was rewritten without a `pipefail`-sensitive pipeline, then tested: batch 1 is
     refused.
   - `phase2-entrypoints.ts` merges into existing barrels. Dry run on the batch 1 tree: all 3
     barrels unchanged.
2. **Move.** `phase2-move.sh phase2-batch2-moves.tsv --dry-run` passed the coverage guard (every
   file in the 12 folders is mapped). Applying it gave `tsc` 0 errors with deep paths.
3. **Entry points.** 5 new barrels (orders 19, payments 19 → 18 after step 4, chat 7, fulfilment 6, onboarding 4
   exports) and 53 files rewritten. `tsc`: 0 errors, 0 deep imports.
4. **Module-graph check: ✗.** `CircularDependencyException` in `@InjectModel()` at
   `orders/application/checkout.service.ts`. A require-stack trace gave the cycle (see
   [R2](research.md#r2)). Fixes:
   - `Domain_CircuitBreakerOpenError` (only used by Stripe; message "Stripe circuit breaker is
     open") moved from `payments/api/payment.dto.ts` to `infrastructure/stripe/stripe.errors.ts`
     and removed from the payments barrel.
   - The unused `UserUtilsModule` import was removed from `StripeModule` (`StripeService` never
     injects it, and `StripeModule` didn't re-export it).
5. **Module-graph check: ✓ 9/9.**

## Validation

| Check | After batch 1 | After batch 2 |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| Jest unit | 30/31 suites, 130 tests | **30/31 suites, 130 tests**. The moved `validators.spec` and `flash-stock.service.spec` pass in place. The only failure is still `discussions/ranking.spec.ts`. |
| Registry spec (IX.3) | 5/5, 9 models placed | **5/5, 20 models placed** |
| Module-graph check | 9/9 | **9/9** after the fix. payment-processor 36 → 34 and worker 229 → 227 modules/classes, which is exactly the `UserUtilsModule` and `UserUtilsService` nodes that were only reachable through the unused Stripe import. |
| `nest build`, all 9 apps | ✓ | **✓** |
| e2e spec discovery | 52 | **52** |
| Deep cross-domain imports | 0 | **0** |

## Debt

New items continue the batch 1 numbering. D-1 is partly paid: Stripe no longer imports domains.

- **D-6 (I.2)**, updated with the batch 2 counts in the Constitution Check.
- **D-7 (IX.4)** adds `BisOrderModel` (payments, auctions) and `PaymentModel` (orders). The
  replacements: payments consumes `order.reserved` / `order.paid` events (it already listens), and
  orders reads payment status through a `payments` R1 export.
- **D-10 (D2, export route).** Move the export endpoints from `CatalogImportController` and the
  `kind === 'export'` branch of `catalog-import.worker` into `orders` (controller + SQS consumer
  with its own queue). Then `OrderExportService` stops importing `IMPORT_QUEUE` from legacy
  `catalog-import`. This changes routes, so it needs an e2e spec update.
- **D-11 (X.5): orders ↔ payments model references.** They're resolved by D-7. Until then the cycle
  is safe only because every cross reference is a lazy association arrow or type-only. The
  module-graph check guards it.

## Next batches

- **Batch 3:** `catalog-sync` (catalog-import (import half), integrations, offline-sync), `media`
  (media, video), `shop-functions`, `asset-library`, `statements`, `billing`.
- **Batch 4:** `community` (D5), `content`, `notifications`, `launch-events` (launch-events,
  live), `auctions`.
- **Batch 5:** `discovery`, `marketing`, `experimentation`, `seller-insights`,
  `developer-platform`, `assistant`. Then retire `all-models.ts` (D-9) and the `@app/common/*`
  fallback (D-5).

Each batch: write the move map → `phase2-move.sh <map>` → `phase2-entrypoints.ts` → the
verification set. The module-graph check is mandatory, because batch 2 showed `tsc` can't see
barrel cycles.

## Complexity Tracking

No constitution violations need justification. Every ⚠ row is pre-existing coupling tracked as
D-6, D-7, D-10, or D-11.
