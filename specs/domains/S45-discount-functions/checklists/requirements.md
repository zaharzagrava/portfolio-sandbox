# Specification Quality Checklist: S45 — Seller discount functions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — HTTP routes, error codes, the function contract and exported service names are the external contract (same convention as S42/S44); no framework, library, storage engine or file path appears in `spec.md`. AS-38 names the repository's static checks, which are the acceptance tooling, not design.
- [x] Focused on user value and business needs — each story states the seller, buyer or operator outcome
- [x] Written for non-technical stakeholders — Overview and story intros are plain language; scenarios are Given/When/Then
- [x] All mandatory sections completed — User Scenarios, Requirements, Success Criteria, Assumptions, Cross-capability contracts

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 0 (every default is an Assumption and a line in `questions.md`)
- [x] Requirements are testable and unambiguous — FR-001…FR-037 each map to at least one AS scenario with exact status codes, amounts and counts
- [x] Success criteria are measurable — SC-001…SC-009 carry numbers (200 ms, 15 ms, 5 failures, 60 s, 12 minutes, 20 concurrent operations)
- [x] Success criteria are technology-agnostic — phrased as refusals, times, counts and buyer outcomes
- [x] All acceptance scenarios are defined — 39 scenarios (AS-01…AS-39), one row each in `test-plan.md` (39 rows)
- [x] Edge cases are identified — concurrency (AS-03, AS-12, AS-16, AS-20, AS-29), idempotent replay (AS-17), illegal transitions (AS-20, AS-21), cross-tenant (AS-04, AS-08), limits (AS-02, AS-03, AS-11), timeouts (AS-13, AS-28, AS-31), out-of-order and duplicate events (AS-15, AS-17, AS-18, AS-19), plus the Edge Cases list
- [x] Scope is clearly bounded — Scope lists in and out with owner capabilities
- [x] Dependencies and assumptions identified — Assumptions and Cross-capability contracts (Provides / Requires with exact shapes)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows — manage, submit and judge, checkout evaluation, operations
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification
- [x] Pattern-map rows for S45 are covered — P0112 (FR-005, FR-021, AS-02, AS-14, AS-26, AS-18), P0510 (FR-022 to FR-024, AS-14, AS-23), P0620 (FR-026 to FR-032, AS-28 to AS-34)

## Notes

- Validation passed on the first iteration.
- `check:table-ownership` could not be run in this unattended session (approval required); `gaps.md` section 3 is derived from reading the code and tells the implementation agent to run it first.
- Open cross-capability asks (all in `questions.md` as `[CONTRACT]`): S03 permission `functions.manage`; S18 entitlement key `shopFunctions` and use of `getMany`; S10 imports `DiscountEvaluationService` and drops the orders-side port; S53, S49, S50 names; domain-map hosting of the runner.
