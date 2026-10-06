# Implementation Plan: Phase 1 – Infrastructure, Common, and Composition Refactor

**Branch**: `001-phase1-infra-common-composition` (work is on `master`; no branch was created) |
**Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request plus
[`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md) §1.2, §1.3, and §5.

**Status**: **Executed.** The moves, import rewrites, and config changes are applied in the working
tree (not committed). Verification results are under [Validation](#validation).

## Summary

This phase moves every domain-agnostic tool out of `packages/backend/libs/common/src/` into the
target areas of constitution v3.1.0, Principle X:

- 25 technical wrappers → `libs/infrastructure/*`;
- 12 utilities → `libs/common/*`;
- the BFF composition code → `libs/composition/bff`.

Business domains stay in `libs/common/src/` until Phase 2.

The move is a mechanical, history-preserving refactor (`git mv`). A codemod rewrites about 1,050
import specifiers in about 450 files. No behavior changes, except one broken `.env` path in a
test mock that the move forced into the open ([research R5](research.md#r5)).

## Technical Context

**Language/Version**: TypeScript 5.9 (backend tsconfig, `moduleResolution: nodenext`), Node ≥ 24

**Primary Dependencies**: NestJS monorepo (webpack via `nest build`), ts-jest 29 / Jest 30, esbuild
(Lambda bundles)

**Storage**: N/A. No schema, table, or data change.

**Testing**:
- `tsc --noEmit` over the whole backend;
- the Jest unit suite;
- webpack builds of `bff` and `core`;
- e2e specs are typechecked only (they need the docker-compose stack, decision D2).

**Target Platform**: Linux containers / Lambda (unchanged)

**Project Type**: NestJS modular monolith with multiple deployables (`apps/*`)

**Performance Goals**: N/A (no runtime change)

**Constraints**:
- Zero new type errors and an identical unit-test result.
- Git history is preserved (`git mv`).
- Business domains are untouched in Phase 1.
- Every `@app/common/<domain>` import keeps working until Phase 2.

**Scale/Scope**: 38 source folders/files moved; 446 TS files rewritten; 5 build configs.

## Constitution Check

*GATE: checked before the work and re-checked after it.*

| Gate (constitution v3.1.0) | Result | Notes |
|---|---|---|
| X.1 apps are deployment units only | ✅ unchanged | Only import specifiers in `apps/*` changed. |
| X.2 domains in `libs/domains/<d>` | ⏭ Phase 2 | Domains intentionally stay in `libs/common/src`. |
| X.3 infrastructure/common own no business data, no domain types | ⚠ partial | 8 production imports from new libs into legacy domains remain ([debt D-1](#phase-2-debt)). They existed before; the move only makes them visible. |
| X.4 / X.5 dependency directions | ⚠ transitional | `@app/common/*` falls back to `libs/common/src/*` ([R2](research.md#r2)), so domains still resolve. Removed in Phase 2. |
| X.6 dependency-graph CI check | ⏭ later | It can be added once Phase 2 removes the fallback. |
| X.8 composition: no data, no domain imports, allowlisted infrastructure | ✅ | `libs/composition/bff` imports only `@app/common/config`, `@app/common/types` (legacy, [D-2](#phase-2-debt)), and its own files. It calls core over HTTP (`CoreClient`). `batch-read.controller.ts` (raw SQL over `Shop`/`Product`) was **kept out** of composition, because X.8.1 forbids data access there. |
| IX ownership registry | ✅ consistent | `Outbox` → `infrastructure/outbox`, `SequelizeMeta` model → `infrastructure/database`, as the IX.3 allowlist says. |
| VII.9 green run | ✅ for the runnable layers | tsc, unit, and webpack all pass. e2e specs are typechecked only (D2). |

There are no unjustified violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-phase1-infra-common-composition/
├── plan.md          # this file
├── research.md      # decisions R1–R6
└── quickstart.md    # how to re-verify
```

`data-model.md` and `contracts/` are intentionally omitted. This is an internal refactor with no
entities, endpoints, or interface changes.

### Source Code (after Phase 1)

```text
packages/backend/
├── apps/*                         # unchanged deployables (imports rewritten)
├── libs/
│   ├── infrastructure/            # NEW: aws, cache, cassandra, clickhouse, context, database,
│   │                              #   dynamo, elasticsearch, events, firebase, health, http-client,
│   │                              #   idempotency, jobs, kafka, net, outbox, projections, rate-limit,
│   │                              #   realtime, redis, redis-pubsub, sqs, storage, stripe
│   ├── common/
│   │   ├── config, core, errors, exceptions-filter, lifecycle, load-shedding,
│   │   │   logging, money, platform, scripts, telemetry          # NEW common libs
│   │   └── src/                   # LEGACY: business domains, models/, seeds/, utils/{bis,user,test}-utils,
│   │                              #   types.ts, bff/batch-read.controller.ts (all handled in Phase 2)
│   └── composition/
│       └── bff/                   # NEW: product-page aggregation + GraphQL (X.8)
└── scripts/refactor/              # NEW: phase1-move.sh, phase1-moves.tsv, phase1_rewrite_imports.py
```

**Structure Decision**: these follow the domain map, with three mechanical deviations, each kept
as a sub-folder so no files had to be merged in Phase 1:
- `cron` → `infrastructure/jobs/cron-module`;
- `request` → `infrastructure/http-client/request`;
- `outbox-dto` → `infrastructure/outbox/dto`.

## Execution (what was run)

1. **Baseline.** `tsc --noEmit` reported 0 errors. Jest: 29/30 suites passed, 125/125 tests. The
   one failing suite, `discussions/ranking.spec.ts`, already failed on master.
2. **Dry run.** `bash scripts/refactor/phase1-move.sh --dry-run` reported 1,053 specifiers in 446
   files.
3. **Apply.** `bash scripts/refactor/phase1-move.sh`:
   - validates that every source exists and that the tree is clean;
   - rewrites imports against the old layout;
   - creates `libs/{infrastructure,common,composition}`;
   - runs `git mv` in a safe order: park files that stay behind → directories, shallowest first →
     single files → restore parked files.
4. **Fix-up.** 33 `declare module '@app/common/jobs/job-types'` augmentations were missed by the
   first regex. They were rewritten to `@app/infrastructure/jobs/job-types`, and the codemod regex
   was extended so the script on record matches what was applied.
5. **Config updates:**
   - `tsconfig.json` paths: `@app/infrastructure/*`, `@app/composition/*`, and
     `@app/common/*` → [`libs/common/*`, `libs/common/src/*`].
   - The Jest `moduleNameMapper` in `package.json` and `jest-e2e.json` uses the same fallback.
   - `scripts/build-lambdas.mjs`: the esbuild `alias` became an `appAliases` resolver plugin,
     because esbuild aliases can't fall back.
   - `apps/local-monolith/tsconfig.app.json` includes the new areas.
   - `libs/common/tsconfig.lib.json` includes `**/*.ts`.

## Validation

| Check | Before | After |
|---|---|---|
| `tsc --noEmit -p tsconfig.json` | 0 errors | **0 errors** |
| `jest` (unit) | 29/30 suites, 125/125 tests | **29/30 suites, 125/125 tests** (same pre-existing failure) |
| `jest --config jest-e2e.json --listTests` | n/a | 52 specs discovered (not run, D2) |
| `nest build bff`, `nest build core` (webpack) | n/a | **compiled successfully** |
| `node scripts/build-lambdas.mjs` | not run | Every `@app/*` alias resolves. The bundle fails on `Could not resolve "pg-hstore"` (a missing sequelize optional dependency, unrelated to paths, not checked on master). |

## Phase 2 debt

Recorded here so Phase 2 can plan around it. None of it was introduced by this phase.

- **D-1. Infrastructure → domain imports in production code (X.3/X.5 violations):**
  - `elasticsearch` → `models/product.model`;
  - `kafka` and `outbox` → `models/payment.model`;
  - `stripe` → `payment/types` and `utils/user-utils`;
  - `redis`, `dynamo`, `cassandra` → `utils/test-utils/test-cleanup.registry`. That registry moves
    to `test/` in Phase 2, and the clean-up hook should then be an infrastructure port.

  Test-only imports (seeds, test-utils, `product.module`, `auth-api.module`) in 6 infrastructure
  e2e specs move with the test harness.
- **D-2.** `libs/common/src/types.ts` mixes generic types (`Environment`, `OrderDirection`) with a
  domain import (`users/types`). Twelve imports from the new areas use it. Split it: generic parts
  → `libs/common/types`, `RequestWithUser` → identity.
- **D-3.** `realtime/topics.ts` still hard-codes domain topic names (decision D3). Replace it with a
  topic registry where each domain registers its prefix and policy on module init.
- **D-4.** `bff/batch-read.controller.ts` (raw SQL over `Shop` and `Product`) is split into tenancy
  and catalog `api/` batch endpoints (domain map §4).
- **D-5.** Remove the `@app/common/*` → `libs/common/src/*` fallback from tsconfig, Jest, and esbuild
  once `libs/common/src` is empty, then add the X.6 dependency-graph check.
- **Locked decisions for later phases:**
  - D2: `ExportJob` belongs to orders;
  - D3: topic registration is decentralized;
  - D4: payments includes ledger;
  - D5: community has zero Postgres tables;
  - D1: composition lives at `libs/composition/bff` (done).

## Complexity Tracking

No constitution violations need justification.
