# Specification Quality Checklist: S40 — Seller Leaderboards, Live Sales Dashboard, Seller Stats

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). Stores are named only as "board store" and "analytics store"; route paths, event names and schema names appear because they are the cross-capability contract the command requires.
- [x] Focused on user value and business needs (visitors, shop members, operators)
- [x] Written for non-technical stakeholders (each story states its purpose and why it has its priority)
- [x] All mandatory sections completed (scope, scenarios, requirements, success criteria, assumptions, cross-capability contracts)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (defaults are in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (FR-001–FR-047 each map to at least one AS-nn with exact figures)
- [x] Success criteria are measurable (SC-001–SC-009)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-62, each in `test-plan.md` exactly once)
- [x] Edge cases are identified (duplicates, concurrency, out-of-order, late and sealed periods, ties, limits, cross-tenant, store failures, illegal snapshot requests, shutdown)
- [x] Scope is clearly bounded (crawler S41, orders S10, tenancy S03, realtime S51, web W04 excluded)
- [x] Dependencies and assumptions identified (Cross-capability contracts: Provides / Requires; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (board feed, public list, my rank, snapshots, live dashboard, stats, read models)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (pattern P0323 is stated behaviourally)

## Notes

- Iteration 1 found: wrong percentile in AS-28/AS-29 (`ceil(100/101 × 100)` is 100, not 99), unit totals in AS-46, an ambiguous tie scenario (AS-06), a missing AS-30, and a wrong claim that S40 registers the `shop:*:live` topic (tenancy does). All fixed; iteration 2 passed.
- `pnpm check:table-ownership` could not be run in this unattended session; `gaps.md` section C is derived from reading the code and says so.
- Every default is tagged in `questions.md` (BREAKING first, then CONTRACT, then LOCAL).
