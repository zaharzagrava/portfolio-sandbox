# Specification Quality Checklist: S12 — Order Export (domain `orders`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework, library or vendor is named in `spec.md` (searched for Postgres, Sequelize, Nest, S3, SQS, Redis, Kafka, MinIO, zod, Jest, supertest: no hit after one shop alias `S3` was renamed `Sx`). Route paths, exported service and schema names, event, topic and queue names, problem codes and check commands appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names.
- [x] Focused on user value and business needs. Seven stories: export as CSV, constant-memory streaming without losing or repeating a line, progress, safe starts, tenant isolation, failure/cancel/recovery, lifecycle and the move out of `catalog-sync`.
- [x] Written for non-technical stakeholders. Scope, stories and success criteria are plain language; scenarios and contracts are precise on purpose, like the sibling specs S01–S11.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Defaults are in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous: 40 functional requirements, each cites the scenarios that prove it (checked: 40 of 40 name an AS).
- [x] Success criteria are measurable (SC-001–SC-009 carry sizes, counts, percentages, minutes).
- [x] Success criteria are technology-agnostic (no engine, framework or tool).
- [x] All acceptance scenarios are defined: 61 scenarios (AS-01–AS-61), each with exact outcomes; `test-plan.md` has 61 matching rows (counted).
- [x] Edge cases are identified: concurrency, idempotent replay, illegal transitions, cross-tenant access, limits, timeouts, duplicate and out-of-order events each map to named scenarios (see the Edge Cases section).
- [x] Scope is clearly bounded: in-scope and out-of-scope lists name the owning capability for every excluded item (S05, S07, S10, S16, S03, S49–S54, W04).
- [x] Dependencies and assumptions identified: Assumptions section; `Requires` list with owning capability and exact shapes; `[CONTRACT]` lines in `questions.md`.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (start, run, download, progress) and the failure and lifecycle paths.
- [x] Feature meets measurable outcomes defined in Success Criteria (each SC maps to scenarios: SC-001→AS-12, SC-002→AS-10/AS-11, SC-003→AS-06/AS-09, SC-004→AS-08/AS-27, SC-005→AS-45, SC-006→AS-24/AS-43/AS-44/AS-53–AS-55, SC-007→AS-15, SC-008→AS-56/AS-57, SC-009→AS-58).
- [x] No implementation details leak into specification.

## Cross-checks against the command's rules

- [x] Pattern-map rows with `S12` in **Specs**: P0102 and P0207 — both appear as requirements (FR-014–FR-017) and scenarios (AS-09–AS-12, AS-33, AS-40).
- [x] Debt rows: D-10 paid (FR-034–FR-036, AS-56); D-7/D-12 share and D-8/D-6/D-15 recorded in `gaps.md`; the ownership-check output could not be run unattended and `gaps.md` says so and gives a static derivation.
- [x] Cross-domain data only as IX.7 mechanisms: SKU and shop membership are **R1** (named); no R2 or R3 is needed (stated in `gaps.md` section B).
- [x] Specs already written were searched (`S12`, `orders`); their requirements are honoured or differ via `[CONTRACT]` lines (S07 route wording, S05 `externalSku`, S10 snapshot, S03 offboarding export).
- [x] `questions.md` is tagged and sorted: 13 BREAKING, 13 CONTRACT, 15 LOCAL.
- [x] `test-plan.md`: one row per scenario, each edge case in one row at its lowest layer, e2e file named per row.

## Notes

- Iterations: 1 validation pass found and fixed 2 issues (a shop alias `S3` that read as the storage vendor; FR-040 lacked a scenario reference). Re-run: all items pass.
- `pnpm --dir packages/backend check:table-ownership` was not run (needs approval unavailable in this session); `gaps.md` §C must be reconciled with its real output first.
