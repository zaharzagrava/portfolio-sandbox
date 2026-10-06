# Specification Quality Checklist: S32 — Product Search (domain `discovery`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). The body names no engine, database, broker, framework or library (searched for Elasticsearch, Kafka, Postgres, Redis, ClickHouse, Sequelize, Nest: no hit after one fix). Route paths, exported service names, schema names, event and topic names, problem codes, job names and policy names appear because the constitution's contract rules (V.2, X.4, IX.7) and the task's "Cross-capability contracts" section require exact names. Technique words that describe behaviour (typo tolerance, full text, trigram fallback, nearest neighbour) stay.
- [x] Focused on user value and business needs (nine stories: buyer search, facets, semantic search, index sync, reindex, synonyms, seller search, measurement, platform).
- [x] Written for non-technical stakeholders. Stories and success criteria read in plain language; the acceptance scenarios and contracts are written for the reviewers and the implementation agent, as in the sibling specs (S05, S31). Caveat recorded, not a blocker.
- [x] All mandatory sections completed (User Scenarios, Requirements, Success Criteria, Assumptions, Cross-capability contracts).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (none were written; every choice is an Assumption and a tagged line in `questions.md`).
- [x] Requirements are testable and unambiguous: 61 functional requirements, each cites the acceptance scenarios that prove it.
- [x] Success criteria are measurable (SC-001 to SC-010 with numbers).
- [x] Success criteria are technology-agnostic (stated as buyer, seller and operator outcomes).
- [x] All acceptance scenarios are defined: 86 scenarios (AS-01 to AS-86), each with exact status codes, bodies and persisted effects, and each mapped to exactly one row of `test-plan.md` (86 rows, verified by count).
- [x] Edge cases are identified (concurrency, idempotent replay, illegal transitions, cross-tenant, limits, timeouts, out-of-order and duplicate events, poison messages, privacy), each mapped to a scenario in the Edge Cases section.
- [x] Scope is clearly bounded (in/out lists name S03, S05, S19, S25, S29, S30, S31, S33–S36, S46–S50, S53, S54, W02, W04 as owners of what is excluded; cross-domain data appears only as R1 (`getShopsByIds`, `getReadyMediaByIds`) and R3 (events), named per use).
- [x] Dependencies and assumptions identified (Requires list with owner IDs and exact shapes; Assumptions; `questions.md` with 21 BREAKING, 15 CONTRACT and 17 LOCAL lines).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR names its AS IDs).
- [x] User scenarios cover primary flows (search, facets, semantic, sync, reindex with rollback, synonyms, seller search, measurement, exported services).
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 and SC-003 load proofs are operations artifacts, noted in `test-plan.md`).
- [x] No implementation details leak into specification (see the first item; `plan.md` decides storage layout, index mapping, job mechanics and metrics wiring).

## Notes

- Pattern-map rows for S32 are covered: **P0308** (relational full text for per-shop search, search engine for the catalog: FR-046–FR-049, AS-61–AS-69, FR-017 and AS-22 for the index side) and **P0408** (read models, version-guarded, rebuildable by replay: FR-017–FR-029, FR-032–FR-039, AS-22–AS-51, AS-81).
- Prior contracts honoured: S05 (routes, projector, logger, popularity, embeddings; two differences recorded as `[CONTRACT]`), S19, S07/J04, S03, S29, S30/S31 (not consumed, recorded), S25. `specs/web` and `specs/journeys` do not exist yet.
- Known limitation: `pnpm check:table-ownership` could not be run unattended (approval required); `gaps.md` section C is derived from reading the code and says so. The implementation agent must replace it with the command's output.
- Validation passes: 1 (all items pass; one wording fix for a stray "Postgres" mention and three sentence clean-ups in AS-02, AS-04, AS-15 were applied before the final check).
