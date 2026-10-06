# Specification Quality Checklist: S08 — Shopify/WooCommerce Catalog and Stock Sync

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the body describes behaviour; HTTP routes, event names, queue names and entity fields appear only where this repository's convention requires exact names for other specs (Provides/Requires, as in S05 and S07). No language, framework, library or storage engine is named outside test-mechanism notes in `test-plan.md`.
- [x] Focused on user value and business needs — eight stories led by what a shop owner experiences (connect, catalog appears, stock stays right, bad data set aside, drift reported).
- [x] Written for non-technical stakeholders — each story opens in plain language; the Given/When/Then scenarios are precise by design (VII.8 traceability).
- [x] All mandatory sections completed — Scope, User Scenarios & Testing, Edge Cases, Requirements, Key Entities, Success Criteria, Assumptions, Cross-capability contracts (Provides and Requires).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 0 in `spec.md` and `questions.md`; every default is under Assumptions and as one tagged line in `questions.md` (18 BREAKING, 17 CONTRACT, 20 LOCAL, in that order).
- [x] Requirements are testable and unambiguous — 80 acceptance scenarios with exact statuses, counts, values and states; every FR cites at least one AS.
- [x] Success criteria are measurable — SC-001 to SC-013 give times, percentages, counts.
- [x] Success criteria are technology-agnostic (no implementation details) — stated as seller-visible and platform-visible outcomes; SC-013 refers to the repository's ownership check only as the way the boundary rule is verified.
- [x] All acceptance scenarios are defined — all seven pattern-map rows (P0112, P0417, P0419, P0518, P0612, P0613, P0614) map to requirements and scenarios (P0112 → FR-020/AS-14/AS-54/AS-72; P0417 → FR-052/AS-55–AS-60; P0419 → FR-030/AS-26–AS-34; P0518 → FR-007/AS-79; P0612 → FR-040–FR-046/AS-35–AS-46; P0613 → FR-010–FR-014/AS-12–AS-24; P0614 → FR-060–FR-063/AS-61–AS-66).
- [x] Edge cases are identified — concurrency (AS-05, AS-10, AS-11, AS-18, AS-23, AS-60, AS-68), idempotent replay (AS-13, AS-25, AS-28, AS-42), illegal state transitions (AS-39, AS-50, AS-68, AS-70), cross-tenant access (AS-71), limits (AS-11, AS-32, AS-53, AS-70), timeouts (AS-58), out-of-order and duplicate events (AS-22, AS-40, AS-41).
- [x] Scope is clearly bounded — Scope lists in/out with owning capabilities (S05, S07, S09, S03, S01, S49, S50, S53, S54, W04).
- [x] Dependencies and assumptions identified — Cross-capability contracts (Requires with exact shapes and owning IDs) and Assumptions; open points are `[CONTRACT]` lines.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — FR-001…FR-102 each reference scenarios.
- [x] User scenarios cover primary flows — connect, pull, webhooks, stock, quarantine/resilience, reconciliation, management, lifecycle.
- [x] Feature meets measurable outcomes defined in Success Criteria — SC-001…SC-013 trace to AS-12, AS-26–AS-29, AS-35–AS-38, AS-47, AS-55, AS-61–AS-63, AS-71, AS-79, AS-80.
- [x] No implementation details leak into specification — see the first item.

## Cross-artifact checks (project rules)

- [x] `test-plan.md` has one row per scenario (80 = 80), names the e2e file per row, and puts each edge case at the lowest layer (pure rules: AS-14, AS-15, AS-45, AS-52 unit only).
- [x] `gaps.md` lists current-code gaps with file:line, every open debt row naming `catalog-sync` (D-6, D-7, D-8, D-10, D-12) and the ownership-check lines with their IX.7 mechanism (R1 for catalog and tenancy, R3-style event copy for local quantities).
- [x] Prior contracts honoured: S05 (R1 commands, no product SQL, no product events), S07 (own tables, shared topic), S03 (`integrations.manage`, offboarding/deleted), S01 (`SecretBox` context). Deviations are `[CONTRACT]` lines.

## Notes

- Iteration 1 of 3: all items pass. The ownership-check output is reconstructed by reading the code (the command could not be run in this session); `gaps.md` says so and tells the implementer to run it first.
- The Interview-Prep notes were read from `.specify/memory/Interview-Prep/` (not `~/workspace/notes/…`, which does not exist in this environment); `docs/showcase/sections/SD-36-shop-integrations-sync.md` was read from the repository.
