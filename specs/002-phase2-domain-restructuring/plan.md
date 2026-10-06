# Implementation Plan: Phase 2 – Domain Restructuring & Ownership Registry (batch 1)

**Branch**: `002-phase2-domain-restructuring` (work is on `master`, uncommitted, on top of the uncommitted
Phase 1) | **Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request
plus [`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md) §1.1, §2, §3.

**Status**: **Executed** for batch 1 (`identity`, `tenancy`, `catalog`). The ownership registry covers
**all** tables. The remaining 22 domains follow the same scripts in later batches
([next batches](#next-batches)).

## Summary

- **Domains moved.** Nine legacy folders plus nine models moved into
  `libs/domains/{identity,tenancy,catalog}` with the I.1 layout (`api/`, `application/`, `domain/`,
  `infra/`; Nest modules and e2e specs sit at the domain root). The merges:
  - `auth`, `users`, `users-dto`, `admin`, and `utils/user-utils` → `identity`;
  - `product`, `product-dto`, and `collab` → `catalog`.
- **Entry points (X.4).** Each domain has one generated `index.ts`, and **every** outside import
  (180 files) now goes through `@app/domains/<d>`. Zero deep imports remain.
- **Ownership registry (IX.3).** `packages/backend/db/ownership.ts` maps all 100 live tables to one
  owner each. `db/ownership.spec.ts` enforces it against the migrations and the models.
- **Runtime safety net.** `scripts/check-module-graph.ts` loads all 9 app root modules and proves
  that no barrel or circular import leaves a Nest reference `undefined`. `tsc` can't detect that
  class of failure.

## Technical Context

**Language/Version**: TypeScript 5.9 (`nodenext`, `isolatedModules`), Node ≥ 24

**Primary Dependencies**: NestJS monorepo (webpack), Sequelize-typescript, Jest 30 / ts-jest, TypeScript
compiler API (codemod)

**Storage**: PostgreSQL. **No schema change.** The registry is metadata only (IX.2: flat names in
`public`).

**Testing**:
- `tsc --noEmit`;
- Jest unit tests, including the new registry spec;
- `nest build` for all 9 apps;
- the module-graph check;
- e2e specs are typechecked and discovered, not run (decision D2).

**Target Platform**: unchanged

**Project Type**: NestJS modular monolith with multiple deployables

**Performance Goals**: N/A (no runtime behavior change)

**Constraints**: zero new type errors; an identical unit result; history kept (`git mv`); all 9 app
module graphs unchanged; no deep cross-domain imports.

**Scale/Scope**: 84 files moved (76 move-map entries, 6 of them directories), 484 specifiers rewritten
in 226 files by pass 1, and 180 files rewritten to barrels by pass 2.

## Constitution Check

*GATE: checked before the work and re-checked after it.*

| Rule | Result | Evidence / notes |
|---|---|---|
| I.1 layer folders only | ✅ | Each domain contains only `api/ application/ domain/ infra/`, plus `*.module.ts`, e2e specs, and `index.ts` at the root. `identity` has no pure logic, so it has no `domain/` folder. |
| I.2 import directions | ⚠ debt | 9 `api/` files and 12 `application/` files import `infra/` directly, mostly injected Sequelize models. Fixing this needs repository/port extraction, which is a behavior-preserving refactor beyond a move ([D-6](#debt)). |
| I.3 `domain/` is framework-free | ✅ | `permissions.ts`, `hash-ring.ts`, and `listing-doc.ts` import no Nest, ORM, or infrastructure code. |
| I.4 single owner per table / model | ✅ | Models live in the owning domain's `infra/models/`. The spec checks this. |
| IX.3 ownership registry | ✅ | 100 tables, 25 domains, plus the 6-table technical allowlist. The spec has 5 checks, and a mutation test confirmed it fails on a wrong owner. |
| IX.4 coupling ban | ⚠ debt | Barrels still export models that other code injects (UserModel in catalog, tenancy, ledger; ProductModel in 7 legacy domains plus the projector app; ShopMembershipModel in 2 domains plus 2 apps; ShopModel in finance). They're marked transitional ([D-7](#debt)). |
| X.2 domains in `libs/domains/<d>` | ✅ batch 1 | 22 domains are still legacy ([next batches](#next-batches)). |
| X.4 single public entry point | ✅ | `grep "@app/domains/<d>/"` finds 0 hits outside the domains. |
| X.5 dependency directions | ✅ batch 1 | catalog → tenancy → identity and catalog → identity: acyclic. `common/src/types.ts` → identity is type-only and erased at emit. |
| X.6 dependency-graph CI | ⏭ | The module-graph check and the registry spec are the first automated guards. dependency-cruiser comes once the `@app/common` fallback is gone. |
| VII.9 green run | ✅ runnable layers | See [Validation](#validation). |

There are no unjustified violations. Both ⚠ items are pre-existing coupling that the move made
visible, and they're tracked as debt with an owner phase.

## Project Structure

### Documentation (this feature)

```text
specs/002-phase2-domain-restructuring/
├── plan.md                         # this file
├── research.md                     # decisions R1–R7
├── data-model.md                   # ownership registry model + validation rules
├── contracts/domain-entrypoints.md # the public surface of identity / tenancy / catalog
└── quickstart.md                   # how to re-verify
```

### Source Code (after batch 1)

```text
packages/backend/
├── db/
│   ├── ownership.ts                # NEW: IX.3 registry (all tables)
│   └── ownership.spec.ts           # NEW: completeness, single owner, model placement
├── libs/domains/                   # NEW area
│   ├── identity/  { api/ application/ infra/ } + auth*.module, users*.module, admin.module, user-utils.module, index.ts
│   ├── tenancy/   { api/ application/ domain/ infra/ } + tenancy*.module, index.ts
│   └── catalog/   { api/ application/ domain/ infra/ } + product*.module, collab/drafts.module, index.ts
├── libs/common/src/                # legacy: 22 domains still to migrate
└── scripts/
    ├── check-module-graph.ts       # NEW: `pnpm check:module-graph`
    └── refactor/
        ├── phase2-moves.tsv        # file-level layer map (reviewable)
        ├── phase2-move.sh          # coverage guard + codemod + git mv
        ├── rewrite_imports.py      # generalized codemod (post-Phase-1 aliases)
        └── phase2-entrypoints.ts   # TS-API barrel generator + import rewriter
```

**Structure Decision**: one Nest module per former folder stays at the domain root (e.g.
`identity/auth.module.ts`, `identity/users.module.ts`) rather than being merged into one
`identity.module.ts`. Merging modules changes provider scopes and import graphs, which is a
runtime change. That belongs in a follow-up that the module-graph check can watch.

## Execution (what was run)

1. **Baseline**, taken after Phase 1:
   - `tsc`: 0 errors;
   - Jest: 29/30 suites, 125 tests;
   - module graph: 9/9 apps clean (36–509 modules/classes walked).
2. `bash scripts/refactor/phase2-move.sh --dry-run`: the coverage guard confirmed every file in
   the 9 batch folders is mapped. Codemod: 484 specifiers in 226 files.
3. `bash scripts/refactor/phase2-move.sh`: rewrite, then `git mv`, then delete the emptied
   folders.
4. Aliases: `@app/domains/*` added to tsconfig, both Jest mappers, the esbuild resolver, and the
   local-monolith include. `tsc`: 0 errors with deep paths.
5. `phase2-entrypoints.ts --dry-run` found one conflict: the `User` model vs the `@User()`
   decorator. It was resolved by re-exporting models as `<Name>Model` ([R4](research.md#r4)).
   Then it was applied: 3 barrels (20 / 9 / 11 exports) and 180 files rewritten.
6. Registry and spec written; `<rootDir>/db/` added to the Jest roots.

## Validation

| Check | Baseline | After |
|---|---|---|
| `tsc --noEmit` (all of backend, including `db/`) | 0 | **0** |
| Jest unit | 29/30 suites, 125 tests | **30/31 suites, 130 tests**. The new registry spec adds 5. The only failure is still `discussions/ranking.spec.ts`. |
| Registry mutation test (`User` → tenancy) | — | spec **fails** and names `user.model.ts`, then restored |
| `scripts/check-module-graph.ts` | 9/9 ✓ | **9/9 ✓**, same visit counts |
| `nest build` for all 9 apps | — | **all compiled successfully** |
| e2e spec discovery | 52 | **52** |
| Deep `@app/domains/<d>/…` imports outside the domain | — | **0** |

## Debt

Recorded with its target phase. Phase 1 debt D-1 to D-5 still applies.

- **D-6 (I.2): layering inside domains.** api → infra (9 files) and application → infra (12 files).
  Extract repository ports in `domain/` with adapters in `infra/`, then drop model injection from
  `application/`. Do this per domain, after all moves.
- **D-7 (IX.4): model exports in barrels.** Replace each consumer with R1 exports (e.g.
  `identity.getUsersByIds`, `tenancy.assertMember`, `catalog.getProductsByIds`) or R3 read models,
  then delete the `*Model` exports. The list of consumers is in the Constitution Check.
- **D-8: infrastructure internals exported.** `ProductSearchProjector`,
  `ProductCacheInvalidator`, `ProductDtoService`, `KeyStore`, `OidcService`, and `SecretBox` are
  exported because apps or legacy code import them directly. Apps should import the owning
  domain's worker/projector module instead.
- **D-9: `all-models.ts`.** It now imports from the barrels. Delete it per domain map §1.4 once
  every app registers its domains' models (`SequelizeModule.forFeature` inside each domain
  module).

## Next batches

The same three steps apply to each batch: move map → `phase2-move.sh` (parametrize `MOVES` and
`BATCH_DIRS`) → `phase2-entrypoints.ts`. Then add the domain to the registry spec's placement
check, which is automatic once its models move.

1. **Batch 2, money path:** `orders` (+ order export, D2), `payments` (payment, payment-dto,
   ledger, finance; D4), `billing`, `statements`.
2. **Batch 3:** `seller-onboarding`, `catalog-sync`, `media`, `fulfilment`, `shop-functions`,
   `asset-library`.
3. **Batch 4:** `chat`, `community` (D5), `content`, `notifications`, `launch-events`, `auctions`.
4. **Batch 5:** `discovery`, `marketing`, `experimentation`, `seller-insights`,
   `developer-platform`, `assistant`. Then remove the `@app/common/*` → `libs/common/src` fallback
   (D-5).

## Complexity Tracking

No constitution violations need justification. The ⚠ rows are pre-existing coupling, tracked as
D-6 and D-7 above.
