# Implementation Plan: Phase 3 – Retire `libs/common/src` and Enforce Boundaries

**Branch**: `007-phase3-cleanup` (work is on `master`, uncommitted, on top of commit `723a746 phase 2`) |
**Date**: 2026-10-04 | **Spec**: there is no `spec.md`. Inputs: the `/speckit-plan` request,
[`docs/architecture/debt-register.md`](../../docs/architecture/debt-register.md) (rows D-1…D-5 and D-9), the
domain map, and the constitution.

**Status**: **Executed.** All 8 steps are done, each followed by the verification gate. `libs/common/src` no
longer exists. dependency-cruiser enforces constitution X.4, X.5, and X.8. D-1, D-2, D-3, D-4, D-5, and D-9
are marked `resolved (Phase 3)`.

**One pre-existing boot failure was found and fixed.** In a fresh process, payment-processor failed to load
its module graph at the committed `phase 2` tree. Details are in [R1](research.md#r1).

## Summary

| Step | Debt | Result |
|---|---|---|
| 1 | D-1 | Infrastructure no longer imports domain or test code. `kafka/types.ts` (an unused duplicate) is deleted. The payment DTOs nobody used are removed from `outbox/types.ts`. `PRODUCT_EMBEDDING_DIMS` moves into the Elasticsearch lib, its only user. Test cleanup now goes through a `TestCleanupPort` + `TEST_CLEANUP` token in `libs/common/testing`. |
| 2 | — | `seeds/` → `test/seeds`, `utils/test-utils` → `test/utils`, new `@app/test/*` alias. `SeedsModule` is removed from production `CoreModule`: nothing injected it, and its only unique model, `Migration`, is used only by seeds ([R2](research.md#r2)). |
| 3 | D-2 | Generic types → `libs/common/types/index.ts`. The alias resolves there first, so the 38 importers are unchanged. `RequestWithUser` → `identity/api/request-with-user.ts`. |
| 4 | D-4 | `GET /batch/shops` → tenancy `ShopBatchReadModule`; `GET /batch/products` → catalog `ProductBatchReadModule`. Same routes, cache headers, and SQL. Only core and local-monolith serve them, as before (verified from Nest metadata). |
| 5 | D-9 | `all-models.ts` is deleted. Each domain module already registers its models (`forFeature` + `autoLoadModels`). New `pnpm check:model-registry` proves offline that every app's model set wires all its associations. The e2e harness loads every domain entry point instead of `ALL_MODELS`. |
| 6 | D-3 | `TopicRegistry` replaces `TopicPolicies` and the hard-coded topic union and regex. 9 domain `*TopicsModule`s define their own topics, and sse-gateway imports them. A parity spec checks the registry against the old regex on 22 topics. The `topic-stream` e2e spec now loads the 3 topic modules it needs. |
| 7 | D-5 | `libs/common/src` is deleted. The `@app/common` fallback is removed from tsconfig, both Jest mappers, the esbuild plugin, and nest-cli. |
| 8 | X.6 | dependency-cruiser 18.5 runs as `pnpm check:boundaries`. Its first run found 5 errors: three `common` libs depended on infrastructure. Fixed: `platform` and `lifecycle` moved to infrastructure, and the request-context contract moved to `libs/common/request-context`. Now 0 errors. The 62 cycle warnings are recorded (D-11/D-12/D-15, plus new D-17). |

## Technical Context

| | |
|---|---|
| **Language / version** | TypeScript 5.9, Node ≥ 24, pnpm 12 |
| **Primary dependencies** | NestJS (webpack), sequelize-typescript, Jest 30. **New dev dependency:** `dependency-cruiser@18.5.0`, plus a `packageExtensions` entry in `pnpm-workspace.yaml` that makes it use the backend's TypeScript 5.9 instead of the root's TypeScript 7 ([R5](research.md#r5)). |
| **Storage** | No schema change. |
| **Testing** | tsc, Jest unit, `jest db/`, and the new and updated checks. e2e specs are typechecked and listed, not run (no docker). |
| **Constraints** | Same routes, response shapes, and topic semantics. No `forwardRef`. Don't commit. |

## Constitution Check (after)

| Rule | Result |
|---|---|
| X.1 nothing imports `apps/` | ✅ enforced (`x1-nothing-imports-apps`) |
| X.3 / X.5 infrastructure and common are domain-agnostic | ✅ enforced. 0 violations. |
| X.4 entry points only | ✅ enforced, both for code outside domains and for domain-to-domain imports |
| X.5 directions | ✅ enforced. Cycles are warn-only and recorded (D-11, D-12, D-15, D-17) ([R6](research.md#r6)). |
| X.6 dependency-graph check | ✅ `pnpm check:boundaries`. A mutation test (3 injected violations) gave 3 errors, exit 3. Clean tree: exit 0. |
| X.8 composition | ✅ enforced (no domain imports; infrastructure allowlist) |
| IX.3 registry | ✅ `jest db/` 5/5. `check:model-registry` 10/10. |
| Production never imports `test/` | ✅ enforced |

## Validation (final gate)

| Check | Phase 2 end | After Phase 3 |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| Jest unit | 30/31 suites, 130 tests | **31/32 suites, 154 tests** (+ topic-registry parity spec, 24 tests). The only failure is still `ranking.spec` (`marked` ESM). |
| `jest db/` | 5/5 | **5/5** |
| `check:module-graph` | 9/9 (in one process) | **9/9 (one process per app)** |
| `check:model-registry` | — | **10/10** (9 apps + e2e harness) |
| `check:boundaries` | — | **0 errors**, 62 recorded cycle warnings |
| `nest build`, all 9 apps | ✓ | **✓** |
| Lambda bundling | resolves aliases | **resolves aliases** (still fails only on `pg-hstore`, a missing sequelize optional dependency, pre-existing) |
| e2e specs listed | 52 | **52** |
| Deep cross-domain imports | 0 | **0** |

Node-count changes, each fully explained:
- **core:** 315 → 313 (`SeedsModule` and `SeedsService` removed) → 315 (two batch-read modules and controllers replace one each).
- **sse-gateway:** 145 → 158 (−1 policy module and 4 providers, +9 topic modules and 9 providers).
- **local-monolith:** 509 → 522 (the sse-gateway change; core is back to 315).

## Source Code (after Phase 3)

```text
packages/backend/
├── .dependency-cruiser.cjs          # NEW: X.4/X.5/X.8 rules
├── apps/*                           # sse-gateway/src/shop-live deleted (policies now in domains)
├── db/ownership.ts, ownership.spec.ts
├── libs/
│   ├── common/        config core errors exceptions-filter logging money request-context scripts telemetry testing types
│   ├── composition/   bff
│   ├── domains/       25 domains (+ *TopicsModule ×9, Shop/ProductBatchReadModule)
│   └── infrastructure/ … + platform, lifecycle (from common); realtime/topic-registry.ts
├── scripts/  check-module-graph.ts (per process), check-model-registry.ts (NEW), check-table-ownership.ts
└── test/     e2e-env.setup.ts, seeds/, utils/   (@app/test/*)
```

## Remaining debt

See the [debt register](../../docs/architecture/debt-register.md).
- **Open from before:** D-6, D-7, D-8, D-10, D-11 (mitigated), D-12, D-14, D-15.
- **New:** D-16 (the Elasticsearch lib is a product-index adapter) and D-17 (file cycles inside one lib, plus an identity `application → api` type import).

All of them are assigned to capability specs.

## Next

Commit. Then runbook step 2 (bulk spec writing). The SDD gate in `scripts/sdd/implement-specs.sh` now also runs
`check:model-registry` and `check:boundaries`.

## Complexity Tracking

There are no unjustified violations. Cycle warnings are deliberately warn-only and tied to debt IDs, and they
become errors once that debt is paid.
