# Specification Quality Checklist: S16 — Seller Statements (domain `statements`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the body describes behaviour; table, engine and framework names appear only in the contracts section (topics, jobs, schemas), as in sibling specs
- [x] Focused on user value and business needs (sellers' statements, finance's audit trail, closed months that never change)
- [x] Written for non-technical stakeholders (scenarios use a worked dataset DS-1 with plain numbers)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (defaults recorded in `questions.md` and Assumptions)
- [x] Requirements are testable and unambiguous (FR-001–FR-054, each referencing scenarios)
- [x] Success criteria are measurable (SC-001–SC-010)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-83; every pattern-map row for S16 — P0207, P0321, P0614 — appears: AS-61–AS-70, AS-01–AS-04, AS-28–AS-50 and AS-71–AS-75)
- [x] Edge cases are identified (concurrency AS-06/35/41/48, idempotent replay AS-12/30/41/52, illegal transitions AS-34, cross-tenant AS-23, limits AS-25/68, timeouts AS-67/81, out-of-order and duplicate events AS-52–AS-54)
- [x] Scope is clearly bounded (out-of-scope list with owners; refunds explicitly excluded)
- [x] Dependencies and assumptions identified (Requires list with owning capability IDs; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (rates, reads, close, adjustments, facts, export, reconciliation, operations)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Iteration 1: all items pass. One wording fix made during validation (a metrics requirement was referenced by a wrong ID; corrected to FR-054).
- Companion files: `questions.md` (16 BREAKING, 10 CONTRACT, 14 LOCAL), `test-plan.md` (83 rows = 83 scenarios), `gaps.md`.
- Limitation: `pnpm --dir packages/backend check:table-ownership` could not be run unattended (approval required); `gaps.md` section C is derived by reading the code and says the implementation agent must run it first.
- Hooks: `.specify/extensions.yml` does not exist, so no before/after hooks ran. `.specify/feature.json` now points at `specs/domains/S16-seller-statements`.
