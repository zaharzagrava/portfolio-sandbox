# Implementation Plan: S33 — Search Autocomplete

**Branch**: `S33-autocomplete` (working branch `sdd/auto`) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md` (A1–A23, D-6/D-8/D-15/D-16), `questions.md` (defaults accepted), the constitution, and the follow-ups left by S32 and S49 (below).

## Summary

Rebuild the autocomplete slice of `discovery` as one validated public route `GET /suggest` → one application service that blends an in-memory top-K query index, a per-prefix-cached, circuit-broken catalog source and a speculative typo source, each with its own 40 ms budget. It returns `{prefix, suggestions[{text,source}], degraded[]}` (schemas in `packages/contracts`). The hourly build becomes deterministic, eligibility-filtered, checksummed, forward-only-pointer, retention-managed and reports outcomes. Serving nodes verify, single-flight and hot-swap snapshots. All I/O crosses `domain/` ports with adapters in `infra/` (D-6); the module exports nothing (D-8, D-15, D-16).

## Technical Context

**Language/Version**: TypeScript, NestJS (`packages/backend`); Zod schemas in `packages/contracts`
**Primary Dependencies**: `ClickHouseService`, `RedisService`, `ObjectStorage`, `JobsService` / `declareJobType` / `@JobHandler`, `@app/infrastructure/rate-limit`, `MetricsRegistry`; `fast-check` (AS-53) if not already a dev dependency
**Storage**: ClickHouse `search_queries` (read-only), object storage `autocomplete/<version>.json.gz`, Redis pointer `autocomplete:current`; no Postgres table
**Testing**: jest e2e via `scripts/sdd/test-spec.sh` (four files in `test-plan.md`), unit specs beside `domain/`
**Target Platform**: Linux; API nodes (`apps/core`) and worker (`apps/worker`)
**Project Type**: backend domain module (web consumer owned by W02)
**Performance Goals**: p99 ≤ 100 ms at 50k rps behind a CDN (SC-001, ops artifact); trie lookup proportional to prefix length
**Constraints**: catalog 40 ms and typo 40 ms budgets, parallel; ≤ 400 MB index at 200k queries; rebuild never stalls requests beyond one slice
**Scale/Scope**: 200,000 queries, K=10, depth 20, floor 5 searchers, 30-day window

## Constitution Check

| Gate | Status | How |
|---|---|---|
| I layering / ports (I.2, I.3) | PASS after work | `domain/` ports + tokens; `api/` and `application/` import no `infra/`; injected `Clock`, no `new Date()` in `domain/` |
| II one call per controller, DTO validation | PASS | controller → one application service; strict Zod parse, unknown params rejected |
| III transactions (S54) | N/A | no Postgres writes; no `sequelize.transaction` in the touched files; none added |
| IV / X.4 module communication | PASS after work | only S32's exported `ProductTitleSuggester` crosses domains; module exports nothing; `@Global` removed; `SearchQueryLogger` export dropped |
| V contracts, problem+json | PASS after work | `suggestQuerySchema`, `suggestResponseSchema`, codes `validation_failed`, `rate_limited` |
| VII tests | PASS after work | all rows of `test-plan.md`; `useTrie` hook removed; fallbacks forced (VII.9) |
| VIII no PII in logs/metrics | PASS | `autocomplete_*` series, bounded labels, prefix never logged |
| IX table ownership | PASS | reads a discovery-owned ClickHouse table only; `check:table-ownership --strict` re-run |

No unjustified violations. Post-design re-check: still PASS; the one risk is the S32 dependency (research R-1).

## Follow-ups from built sibling specs (treated as requirements)

1. **S32 → S33**: titles only through `ProductTitleSuggester` (replace `ElasticsearchService.suggestTitles` in the autocomplete service); `search.performed` is keyed by `searchId`, so the build never assumes per-query ordering (AS-34); `suggestions` is gone from the search response (web consumers are W02's, see gaps.md follow-ups).
2. **S49 → job owners**: keep `declareJobType` + contract next to the `JobPayloads` augmentation (already present in `infra/autocomplete-builder.jobs.ts`); catch `InvalidScheduleError` (not a generic `Error`) around `upsertSchedule`; no `JobsService.cancel` caller exists here (verify by grep).
3. **S49 → S33**: set `maxRuntimeMs` explicitly. The lease stays 10 min (FR-030); `handler-options.ts` requires `maxRuntimeMs ≥ leaseMs` and defaults to 15 min, so `maxRuntimeMs: 600_000` is valid and stops a run at the lease boundary (a second replica cannot start while the first still runs). Test: handler options validate and the aggregation timeout is below `maxRuntimeMs`.

## Project Structure

### Documentation

```text
specs/domains/S33-autocomplete/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/suggest-api.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/discovery/`; contracts in `packages/contracts/src/search/`)

```text
packages/contracts/src/search/suggest.ts   # query/response schemas, problem codes (A19); export from search/index.ts
discovery/
├── api/suggest.controller.ts              # replaces autocomplete.controller.ts; @RateLimit('discovery.suggest'); headers (A2,A4,A5)
├── application/
│   ├── suggest.service.ts                 # blend, budgets, breaker, cache, typo, logging, metrics (A1,A6–A8,A20)
│   ├── query-index.service.ts             # poll, verify, single-flight, hot swap, readiness (A14,A15)
│   └── autocomplete-build.service.ts      # build use case: outcomes, pointer CAS, retention (A10–A13)
├── domain/
│   ├── top-k-trie.ts (+spec)              # kept; reuse query-text.ts reducer (A3); extended tests (A21)
│   ├── suggestion-blend.ts (+spec)        # AS-14, AS-15
│   ├── catalog-circuit.ts (+spec)         # AS-21
│   ├── query-eligibility.ts (+spec)       # AS-38, whole-word blocklist
│   ├── snapshot-pointer.ts (+spec)        # AS-39
│   ├── snapshot-codec.ts (+spec)          # AS-40
│   └── autocomplete-ports.ts              # QueryIndexSnapshotStore, SnapshotPointer, SearchLogReader, CatalogTitleSource, Clock + tokens (D-6)
├── infra/
│   ├── autocomplete-builder.jobs.ts       # thin @JobHandler → build service
│   ├── snapshot-store.adapter.ts  snapshot-pointer.adapter.ts  search-log-reader.adapter.ts
│   ├── catalog-title-source.adapter.ts  system-clock.ts
│   ├── autocomplete-config.ts             # validated settings incl. blocklist (A18, FR-039)
│   └── autocomplete-metrics.ts            # autocomplete_* series (A18)
├── autocomplete.module.ts                 # not @Global, exports nothing (A17)
├── autocomplete-worker.module.ts
├── rate-limit-policies.ts                 # add discovery.suggest (600/min, ip, fail open)
├── index.ts                               # drop SearchQueryLogger / projector exports as S32 permits (D-8)
└── autocomplete-{suggest,sources,snapshot,platform}.e2e-spec.ts   # replace autocomplete.e2e-spec.ts
```

**Structure Decision**: stay inside the `discovery` domain with the standard layers. The old `AutocompleteService` is split into query-index serving and request blending so each has one purpose.

## Complexity Tracking

None.
