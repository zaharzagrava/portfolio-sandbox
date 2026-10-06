# Implementation Plan: Phase 2 – Batch 5 (last move batch)

**Branch**: `006-phase2-batch5-domains` (work is on `master`, uncommitted, stacked on Phase 1 and batches
1–4) | **Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request,
[`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md), and the runbook note on D-13.

**Status**: **Executed.** All 25 domains now exist. `libs/common/src` holds exactly the six allowed legacy
items. The whole verification gate passed on the first run. Debt is now tracked in
[`docs/architecture/debt-register.md`](../../docs/architecture/debt-register.md).

## Summary

- **Moves:** 9 legacy folders → 4 domains (96 files). Pass 1 rewrote 185 specifiers in 72 files; pass 2
  rewrote 12 files to barrels.
  - `developer-platform` = `public-api` + `webhooks` + `widget`. The widget owns `WidgetSite`, so it's a
    domain, not composition.
  - `marketing` = `ads` + `share-links`.
  - `experimentation` = `flags` + `analytics`.
  - `assistant` = `assistant` + `knowledge`. `llm/` moved intact to `assistant/infra/llm/`
    ([R2](research.md#r2), D-14).
- **D-13 resolved.** `flags/murmur3.ts` → `libs/common/core/murmur3.ts`. All four users import
  `@app/common/core/murmur3`, so `discovery/domain` is pure again.
- **What's left in `libs/common/src`** (exactly the allowed set; anything else would have been an error):
  - `bff/batch-read.controller.ts`
  - `index.ts`
  - `models/all-models.ts`
  - `seeds/` (3 files)
  - `types.ts`
  - `utils/test-utils/` (9 files)
- **New tooling: `pnpm check:table-ownership`.** It lists every raw-SQL reference to another domain's
  table and every `*Model` imported from another domain's barrel. Today it finds 87 accesses in 21
  domains. This is the first version of the constitution IX.5 check; `--strict` exits 1, ready to gate
  CI once the debt is paid ([R3](research.md#r3)).
- **New debt register.** `docs/architecture/debt-register.md` consolidates D-1…D-15 (previously spread
  over five plans). The spec prompt now reads it, together with the ownership report, when it writes
  each capability's `gaps.md`.

## Technical Context

| | |
|---|---|
| **Language / version** | TypeScript 5.9 (`nodenext`, `isolatedModules`), Node ≥ 24 |
| **Primary dependencies** | NestJS (webpack), Jest 30, TypeScript compiler API |
| **Storage** | No schema change. No registry edits needed: `ApiKey`, `ShopApiSettings`, `WebhookEndpoint`, `WidgetSite`, `AdCampaign`, `AdBillingRun`, `FeatureFlag`, `FlagAudit`, `Experiment`, `KnowledgeDocument`, and `KnowledgeChunk` were already registered, and none has a model. |
| **Testing** | The batch 3 gate. e2e specs are typechecked and listed, not run (no docker). |
| **Constraints** | No route or behavior changes; no `forwardRef`; `ranking.spec` result unchanged. |
| **Scale / scope** | 96 files, 4 domains, 1 utility relocation (murmur3), 1 new report script, 1 new doc. |

## Constitution Check

*GATE: checked before the work and re-checked after.*

| Rule | Result | Evidence / notes |
|---|---|---|
| I.1 layout | ✅ | Layer folders plus root modules, e2e specs, and `index.ts`. |
| I.2 directions | ⚠ D-6 | api → infra: developer-platform 1, experimentation 2, assistant 2. application → infra: developer-platform 1, marketing 1, experimentation 1, assistant 3. |
| I.3 pure `domain/` | ✅ | 0 framework, ORM, infrastructure, or cross-domain imports in the four new `domain/` folders. D-13 is resolved, so discovery is clean too. |
| IX.4 coupling | ⚠ D-7 / D-12 | `pnpm check:table-ownership` finds 87 accesses in 21 domains. developer-platform has 11 (`Product`, `Shop`, `ShopMembership`, `ShopOrder`, `BisOrder`, `BisOrderItem`). |
| X.4 single entry point | ✅ | 0 deep imports. |
| X.5 acyclic | ⚠ **D-15 (new)** | A full SCC check over the static domain graph finds one component: {catalog, discovery, experimentation, orders, payments} ([R4](research.md#r4)). It's built from D-11, D-12, and D-15. It's runtime-safe: the module graph is 9/9. Batch 4 wrongly reported no cycle; that plan is now corrected. **Correction (Phase 3):** "runtime-safe" was wrong. payment-processor failed to boot in a fresh process; the in-process module-graph check hid it. Fixed in [Phase 3](../007-phase3-cleanup/plan.md) (lazy model accessors; per-process graph check). |
| X.3 / X.7 | ⚠ **D-14 (new)** | The LLM provider adapter is used by three domains and a Lambda, but metering couples it to billing, so it stays in `assistant/infra/llm/` for now. |
| VII.9 green run | ✅ | See [Validation](#validation). |

No unjustified violations. Each ⚠ is pre-existing coupling, recorded in the debt register with the step
or capability that pays it.

## Source Code (after batch 5)

```text
packages/backend/libs/
├── domains/ (25)   asset-library assistant auctions billing catalog catalog-sync chat community content
│                   developer-platform discovery experimentation fulfilment identity launch-events marketing
│                   media notifications orders payments seller-insights seller-onboarding shop-functions
│                   statements tenancy
├── infrastructure/ (25)   composition/bff   common/{config,core(+murmur3),errors,…}
└── common/src/     legacy, exactly: bff/batch-read.controller.ts index.ts models/all-models.ts seeds/ types.ts utils/test-utils/
packages/backend/scripts/check-table-ownership.ts      # NEW (pnpm check:table-ownership)
docs/architecture/debt-register.md                     # NEW
```

## Execution

1. Placement decisions ([R1](research.md#r1), [R2](research.md#r2)). Then `phase2-move.sh phase2-batch5-moves.tsv --dry-run`: the coverage guard passed; 185 specifiers in 72 files.
2. Applied. `tsc` gave 0 errors with deep paths.
3. `phase2-entrypoints.ts`: 4 new barrels (developer-platform 11, marketing 4, experimentation 5, assistant 14 exports) and 12 files rewritten. Earlier barrels unchanged.
4. Ran the gate: all green on the first run. The residue check found exactly the allowed set.
5. Ran a full SCC check over the domain graph, which found the cycle in [R4](research.md#r4). I traced it to file-level edges and recorded it as D-15.
6. Measured D-12 with a lexical SQL scan. It was much wider than the batch 4 note said, so I turned the scan into `scripts/check-table-ownership.ts` and wrote the debt register.
7. Updated docs:
   - `spec-prompt.md`: `gaps.md` now includes debt-register rows and ownership-report lines.
   - `lib.sh`: the spec writer may run the report.
   - `sdd-runbook.md`: D-13 marked done; debt section rewritten.
   - `domain-map.md`: murmur3 row added.
   - Batch 4 plan and research: cycle claim corrected.

## Validation

| Check | After batch 4 | After batch 5 |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| Jest unit | 30/31 suites, 130 tests | **30/31 suites, 130 tests**. The 6 moved unit specs pass in place; `ranking.spec` fails with the same `marked` ESM error. |
| `jest db/` | 5/5 | **5/5** |
| `pnpm check:module-graph` | 9/9 | **9/9**, identical node counts |
| `nest build`, all 9 apps | ✓ | **✓** |
| e2e specs listed | 52 | **52** |
| Deep cross-domain imports | 0 | **0** |
| `libs/common/src` residue | 13 folders | **only the 6 allowed items** |
| `pnpm check:table-ownership` | — | 87 findings in 21 domains (report mode, exit 0); `--strict` exit 1 |

## Next

Phase 3 (runbook §1c) retires `libs/common/src` and pays D-1…D-5 and D-9. After that, step 2 of the runbook
(bulk spec writing) starts.

## Complexity Tracking

No constitution violations need justification.
