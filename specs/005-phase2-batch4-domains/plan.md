# Implementation Plan: Phase 2 – Batch 4 Domain Restructuring

**Branch**: `005-phase2-batch4-domains` (work is on `master`, uncommitted, stacked on Phase 1 and batches
1–3) | **Date**: 2026-10-04 | **Spec**: there is no `spec.md`. The input is the `/speckit-plan` request,
[`docs/architecture/domain-map.md`](../../docs/architecture/domain-map.md), and
[batch 3](../004-phase2-batch3-domains/plan.md).

**Status**: **Executed.** Five new domains, and the whole verification gate passed on the first run
(no barrel cycles this time).

## Summary

- **Moves.** 11 legacy folders → 5 domains (118 files). Pass 1 rewrote 210 specifiers in 85 files.
  Pass 2 rewrote 13 files to barrels.

  | Domain | Sources | Notes |
  |---|---|---|
  | `community` | `discussions` + `feed` | D5: no Postgres tables |
  | `content` | `stories` | |
  | `notifications` | `notifications` (28 files) | `providers/ports.ts` → `domain/provider-ports.ts`; adapters → `infra/providers/` |
  | `discovery` | `search-admin` + `autocomplete` + `recommendations` + `trending` | Read models only. The two `search-events.ts` files became `application/events/search-click-events.ts` and `search-query-events.ts` |
  | `seller-insights` | `leaderboards` + `seller-stats` + `crawler` | |
- **`ranking.spec.ts`** moved with all three of its subjects (`ranking.ts`, `paths.ts`, `content.ts`) to
  `community/domain/`. It fails exactly as before: Jest can't `require` the ESM-only `marked`
  (`Must use import to load ES Module … marked.esm.js`), and 0 tests run ([R2](research.md#r2)).
- **`realtime/topics.ts`** is untouched (D3, Phase 3).
- **Registry**: no edits. None of these domains has a Sequelize model. The tables of content,
  notifications, and seller-insights are raw SQL.

## Technical Context

**Language/Version**: TypeScript 5.9 (`nodenext`, `isolatedModules`), Node ≥ 24

**Primary Dependencies**: NestJS (webpack), Jest 30, TypeScript compiler API

**Storage**: No schema change.

**Testing**: the batch 3 gate. e2e specs are typechecked and listed, not run (no docker).

**Constraints**: no route or behavior changes, no `forwardRef`, D3 left alone, the `ranking.spec`
result unchanged.

**Scale/Scope**: 118 files, 5 new domains, 0 hand fixes.

## Constitution Check

*GATE: checked before the work and re-checked after it.*

| Rule | Result | Evidence / notes |
|---|---|---|
| I.1 layout | ✅ | Layer folders plus root modules, e2e specs, and `index.ts`. `crawler.module.ts` stays at the root but declares `CompetitorController` inline (debt D-6: split into `api/`). |
| I.2 directions | ⚠ D-6 | api → infra: notifications 1. application → infra: notifications 1, discovery 3, seller-insights 2. community and content are clean. |
| I.3 pure `domain/` | ⚠ **D-13 (new)** | `discovery/domain/count-min-sketch.ts` imports `murmur3` from legacy `libs/common/src/flags` (experimentation, batch 5). Everything else in the 5 `domain/` folders is pure. `marked`, `sanitize-html`, `luxon`, and `zod` are pure libraries, not frameworks or clients. |
| IX.4 coupling | ⚠ **D-12 (new)** | Domains that own no tables query catalog's `"Product"` with raw SQL: discovery `trending.service`, `shop-product-search.service`, `recommendations.service`, `search-reindex.service`, and community `product-feed.projector`. |
| X.4 single entry point | ✅ | 0 deep imports. |
| X.5 acyclic | ⚠ **corrected in batch 5** | New edges: community → catalog; discovery → catalog, orders; notifications → auctions, billing, orders; seller-insights → catalog, notifications, orders. This row originally said "none closes a cycle", which was **wrong**: I checked only the new edges. catalog → discovery (product search logging, debt D-15) and discovery → catalog (D-12) already formed a cycle after this batch. A full strongly-connected-component check in batch 5 found it. See [batch 5](../006-phase2-batch5-domains/plan.md) and `docs/architecture/debt-register.md`. |
| D3 / D5 | ✅ | topics.ts untouched; community owns 0 tables. |
| VII.9 green run | ✅ | See [Validation](#validation). |

There are no unjustified violations. D-12 and D-13 are pre-existing coupling that the move made
visible.

## Source Code (after batch 4)

```text
packages/backend/libs/domains/   (21 domains)
├── … batches 1–3 (16)
├── community/        { api/ application/ domain/ infra/ } discussions*, feed*, feed-publisher modules
├── content/          { api/ application/{events/} domain/ infra/ } stories.module
├── notifications/    { api/ application/ domain/ infra/{providers/} } notifications{,-core,-worker} modules
├── discovery/        { api/ application/{events/} domain/ infra/ } search-admin, search-reindex-worker, autocomplete*, recommendations*, trending modules
└── seller-insights/  { api/ application/ domain/ infra/ } leaderboards*, seller-stats, crawler modules
packages/backend/libs/common/src/   (legacy, 13 folders): ads analytics assistant bff flags knowledge models public-api seeds share-links utils webhooks widget
packages/backend/scripts/refactor/phase2-batch4-moves.tsv   # NEW
```

## Execution (what was run)

1. `phase2-move.sh phase2-batch4-moves.tsv --dry-run`: the coverage guard passed; 210 specifiers in 85 files.
2. Applied it. `tsc` gave 0 errors with deep paths.
3. `phase2-entrypoints.ts` produced 5 new barrels (community 6, content 4, discovery 14, notifications 6,
   seller-insights 8 exports) and rewrote 13 files. All earlier barrels were unchanged.
4. Ran the verification gate. Everything passed on the first run.

## Validation

| Check | After batch 3 | After batch 4 |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| Jest unit | 30/31 suites, 130 tests | **30/31 suites, 130 tests** (5 moved unit specs pass in place) |
| `ranking.spec.ts` | fails: `marked` ESM, 0 tests | **fails identically** at `libs/domains/community/domain/ranking.spec.ts` |
| `jest db/` | 5/5 | **5/5** |
| `pnpm check:module-graph` | 9/9 | **9/9**, identical node counts (core 315, worker 227, local-monolith 509) |
| `nest build`, all 9 apps | ✓ | **✓** |
| e2e specs listed | 52 | **52** |
| Deep cross-domain imports | 0 | **0** |

## Debt

- **D-12 (IX.4, new).** Read-model domains query catalog's `Product` table directly.
  - **Fix:** use the R1 `catalog.getProductsByIds` for lookups (trending, recommendations hydration),
    and the R3 product index for search (shop-admin search over Elasticsearch, or a discovery-owned
    projection for the Postgres FTS variant).
  - **Where:** capability specs S32–S35 and S26 pick this up through their `gaps.md`.
- **D-13 (I.3, new).** `murmur3` is a generic hash used by experimentation (flags evaluator, A/B
  assignment) and by discovery (count-min sketch).
  - **Fix:** move `libs/common/src/flags/murmur3.ts` → `libs/common/core/murmur3.ts` in **batch 5**.
    That's a pure utility move with no behavior change.
  - Then `discovery/domain` imports only `@app/common/core`. The runbook's batch 5 section notes this.
- **D-6 / D-8:** batch 4 counts are above. The exported infra internals (projectors, consumers,
  `SearchQueryLogger`, `StoryCacheInvalidator`) are wired by the projector and worker apps.

## Next

Batch 5 (developer-platform, marketing, experimentation, assistant, plus the D-13 murmur3 move), then
Phase 3. Both are in [`docs/architecture/sdd-runbook.md`](../../docs/architecture/sdd-runbook.md).

## Complexity Tracking

No constitution violations need justification.
