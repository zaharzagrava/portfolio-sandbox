# Specification Quality Checklist: S19 — Pickup near me

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs): the spec names no language, framework, database or search product ("exact store", "search index"). HTTP routes, error codes and event names appear only because the Cross-capability contracts section must keep them exact.
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders (stories and success criteria are in shopper and seller terms; scenarios are Given/When/Then)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; defaults are in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (FR-001…FR-053 each map to an AS scenario)
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01…AS-45; each has one row in `test-plan.md`)
- [x] Edge cases are identified (concurrency, idempotent replay, illegal transitions, cross-tenant, limits, timeouts, out-of-order and duplicate events, replay)
- [x] Scope is clearly bounded (Scope section names owners of everything excluded)
- [x] Dependencies and assumptions identified (Cross-capability contracts: Provides and Requires; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Pattern P0328 (the only pattern-map row naming S19) is covered: exact store as truth (AS-10–AS-23, AS-33, AS-40–AS-43), search index with distance filter and per-product collapse (AS-01–AS-09), cell clustering (AS-34–AS-39), freshness and replay (AS-24–AS-31). Redis GEO for live positions belongs to S20.
- Iterations: 1 (all items passed on the first review).
- Open verification for the implementation agent: `check:table-ownership` could not be run unattended; `gaps.md` section C is derived by hand and must be confirmed.
- Cross-capability: three differences from earlier specs are recorded as `[CONTRACT]` lines in `questions.md` (S10 consumer list, S09/J04 "reaches pickup", S05 `{shopId}` filter).
