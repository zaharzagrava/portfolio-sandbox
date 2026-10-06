# Specification Quality Checklist: S07 — Bulk Catalog Import (domain `catalog-sync`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework, library or vendor is named in `spec.md` (searched for Postgres, Sequelize, Nest, S3, SQS, ClamAV, clamd, csv-parse, zod, Redis, Kafka: the only hit is "S32", a capability ID). Route paths, exported service and schema names, event and topic names, problem codes and check commands appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names.
- [x] Focused on user value and business needs. Seven stories: import a catalog, untrusted files, crash survival, error report, status/progress/cancel, fairness and limits, lifecycle and contracts.
- [x] Written for non-technical stakeholders. Scope, stories and success criteria are plain language; scenarios and contracts are precise on purpose, like the sibling specs S01–S06.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Defaults are in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous: 46 functional requirements, each cites the scenarios that prove it (checked: 46 of 46 name an AS).
- [x] Success criteria are measurable (SC-001–SC-009 carry sizes, counts, percentages, minutes).
- [x] Success criteria are technology-agnostic (no engine, framework or tool).
- [x] All acceptance scenarios are defined: 71 scenarios (AS-01–AS-71), each with exact outcomes; `test-plan.md` has 71 matching rows (counted).
- [x] Edge cases are identified: concurrency (AS-04, AS-11, AS-36, AS-37, AS-57, AS-61), idempotent replay (AS-03, AS-10, AS-17, AS-38), illegal state transitions (AS-12, AS-56, AS-58), cross-tenant access (AS-52), limits (AS-02, AS-28, AS-46, AS-61, AS-62), timeouts (AS-24, AS-37, AS-39, AS-44), out-of-order and duplicate events (AS-65, AS-66), plus the Edge Cases section.
- [x] Scope is clearly bounded (in/out lists name S05, S12, S08, S09, S32, W04, S49–S54 as owners of what is excluded; cross-domain data appears only as R1 calls to S05 and S03, and the R3-style consumption of tenancy events).
- [x] Dependencies and assumptions identified (Assumptions list; "Requires" names the owning capability and exact shape for each).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (upload → scan → parse → write → report), the failure paths, and the lifecycle.
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 and SC-002 are proven by a benchmark artifact named in `test-plan.md`, the rest by scenarios).
- [x] No implementation details leak into specification.
- [x] Mandatory pattern rows covered: P0207 (FR-015, FR-016, FR-020; AS-13, AS-19, AS-42, AS-43), P0407 (FR-006, FR-033, FR-035; AS-07, AS-51, AS-55), P0509 (FR-008–FR-014; AS-21–AS-32).
- [x] Cross-capability contracts honoured: S05 (R1 `upsertFromExternal`, no product SQL, no product events), S03 (`ShopScoped`, shop events), S12 (export leaves). No `[CONTRACT]` difference is left implicit; each is a line in `questions.md`.

## Notes

- Iteration 1 found and fixed: a wrongly numbered list in Story 2, an invented `Idempotency-Replayed` header (removed), an awkward expiry scenario, a state table that allowed an unneeded `SCANNING→UPLOADED` move, an unreferenced `source_missing` edge case (now AS-71), and one requirement (FR-046) without a scenario reference. After the fixes all items pass.
- **Not run:** `pnpm --dir packages/backend check:table-ownership` was refused approval in this unattended session, so `gaps.md` section C is reconstructed from code searches and says so; run the real check before implementation.
- AS-71 sits at the end of Story 3, out of numeric order, to keep every other scenario ID stable across the three files.
