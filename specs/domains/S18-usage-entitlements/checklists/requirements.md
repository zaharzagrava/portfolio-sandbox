# Specification Quality Checklist: S18 — Usage Metering and Entitlement Checks

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs): stores are "usage store", "cache"; exported service and event names appear only as contracts, as S17 does
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders (stories first, contracts last)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous (FR-001 to FR-043, each with AS references)
- [x] Success criteria are measurable (SC-001 to SC-009)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01 to AS-57, one test-plan row each)
- [x] Edge cases are identified (replay, out-of-order, concurrency, cross-tenant, limits, timeouts, dependency down, late events)
- [x] Scope is clearly bounded (out-of-scope list names S17, S46, S03, S01, S49, S50, S53, S54, developer-platform)
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions, `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (entitlement checks, cache, ingestion, invoice lines and adjustments, usage read, operations)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Pattern-map row P0614 (late usage → adjustment lines, closed periods never mutated, invariant checked automatically) is covered by FR-026 to FR-031 and AS-37 to AS-47.
- Source gap: the showcase section SD-24 is absent from this checkout; design 24 and `06/02` §5 were used (same as S17).
- Cross-capability: S17's required shapes are honoured except two additive changes raised as `[CONTRACT]` (`linesFor` also returns `settlement`; S17 calls `settle` inside its invoice transaction), plus `hasEntitlement` gaining `subjectType`. `llm.call_completed` needs three additive fields from S46.
- `pnpm check:table-ownership` could not be run (needs approval); `gaps.md` section C states what was derived instead.
- Iteration 1: all items pass; one inconsistency (re-subscription version handling in the cache) was found and fixed in spec and questions.
